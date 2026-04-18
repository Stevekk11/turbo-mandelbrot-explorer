/**
 * Mandelbrot/Julia Web Worker
 *
 * Loads the WASM module once, then handles render tasks off the main thread.
 * Each task renders a rectangular tile and returns RGBA pixel data.
 * Iteration data is cached per tile so color-only changes can be applied
 * without recomputing the fractal (recolor task).
 */

import type { ToWorkerMessage, RenderTask, RecolorTask } from './types';
import { PALETTES, PALETTE_SIZE, samplePaletteData } from './colorPalettes';

// ─── WASM glue ────────────────────────────────────────────────────────────────

interface MandelbrotWasm {
  exports: {
    memory: WebAssembly.Memory;
    allocBuffer: (w: number, h: number) => number;
    computeTile: (
      xMin: number, yMin: number, xMax: number, yMax: number,
      width: number, height: number, maxIter: number,
      juliaRe: number, juliaIm: number, isJulia: number
    ) => void;
    getBufferSize: () => number;
  };
}

let wasmInstance: MandelbrotWasm | null = null;

async function loadWasm(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    const result = await WebAssembly.instantiateStreaming(response, {
      env: { abort: () => {} },
    });
    wasmInstance = result.instance as unknown as MandelbrotWasm;
  } catch (e) {
    // Fallback: fetch as ArrayBuffer (needed when MIME type is not application/wasm)
    try {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      const result = await WebAssembly.instantiate(bytes, {
        env: { abort: () => {} },
      });
      wasmInstance = result.instance as unknown as MandelbrotWasm;
    } catch (e2) {
      console.error('Worker: WASM load failed, using JS fallback', e2);
    }
  }
}

// ─── JavaScript fallback (if WASM unavailable) ────────────────────────────────

function computeTileJS(
  xMin: number, yMin: number, xMax: number, yMax: number,
  width: number, height: number, maxIter: number,
  juliaRe: number, juliaIm: number, isJulia: boolean,
  buf: Float32Array
): void {
  const dx = (xMax - xMin) / width;
  const dy = (yMax - yMin) / height;

  for (let py = 0; py < height; py++) {
    const im = yMin + py * dy;
    for (let px = 0; px < width; px++) {
      const re = xMin + px * dx;

      let zRe = isJulia ? re : 0.0;
      let zIm = isJulia ? im : 0.0;
      const cRe = isJulia ? juliaRe : re;
      const cIm = isJulia ? juliaIm : im;

      let iter = 0;
      let x2 = zRe * zRe;
      let y2 = zIm * zIm;

      while (x2 + y2 <= 4.0 && iter < maxIter) {
        zIm = 2.0 * zRe * zIm + cIm;
        zRe = x2 - y2 + cRe;
        x2 = zRe * zRe;
        y2 = zIm * zIm;
        iter++;
      }

      let val: number;
      if (iter >= maxIter) {
        val = -1.0;
      } else {
        const log_zn = Math.log(x2 + y2) * 0.5;
        const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
        val = iter + 1.0 - nu;
      }

      buf[py * width + px] = val;
    }
  }
}

// ─── Per-tile iteration data cache ────────────────────────────────────────────
// Keyed by `${tileX},${tileY}`. Cleared when main thread sends clearCache.

const iterCache = new Map<string, Float32Array>();

// ─── Colorization ─────────────────────────────────────────────────────────────

function applyColorization(
  iterBuf: Float32Array,
  size: number,
  palette: number,
  colorSpeed: number,
  colorOffset: number
): Uint8ClampedArray {
  const paletteData = PALETTES[palette].data;
  const rgba = new Uint8ClampedArray(size * 4);

  for (let i = 0; i < size; i++) {
    const val = iterBuf[i];
    if (val < 0) {
      // Interior — black; alpha is set on the next line
      rgba[i * 4 + 3] = 255;
      continue;
    }
    const t = ((val * colorSpeed * 0.01 + colorOffset) % 1 + 1) % 1;
    const fIdx = t * PALETTE_SIZE;
    const idx0 = Math.floor(fIdx) % PALETTE_SIZE;
    const idx1 = (idx0 + 1) % PALETTE_SIZE;
    const frac = fIdx - idx0;
    const b0 = idx0 * 4;
    const b1 = idx1 * 4;
    const o = i * 4;
    rgba[o]     = (paletteData[b0]     + (paletteData[b1]     - paletteData[b0])     * frac) | 0;
    rgba[o + 1] = (paletteData[b0 + 1] + (paletteData[b1 + 1] - paletteData[b0 + 1]) * frac) | 0;
    rgba[o + 2] = (paletteData[b0 + 2] + (paletteData[b1 + 2] - paletteData[b0 + 2]) * frac) | 0;
    rgba[o + 3] = 255;
  }
  return rgba;
}

// ─── Tile rendering ───────────────────────────────────────────────────────────

let _jsBuf: Float32Array | null = null;

function renderTile(task: RenderTask): ArrayBuffer {
  const { tileX, tileY, tileW, tileH, xMin, yMin, xMax, yMax, maxIter,
          juliaRe, juliaIm, isJulia, palette, colorSpeed, colorOffset } = task;
  const size = tileW * tileH;

  let iterBuf: Float32Array;

  if (wasmInstance) {
    // ── WASM path ──────────────────────────────────────────────────────────
    const ptr = wasmInstance.exports.allocBuffer(tileW, tileH);
    wasmInstance.exports.computeTile(
      xMin, yMin, xMax, yMax,
      tileW, tileH, maxIter,
      juliaRe, juliaIm, isJulia ? 1 : 0
    );
    // Read results directly from WASM linear memory
    iterBuf = new Float32Array(
      wasmInstance.exports.memory.buffer,
      ptr,
      size
    );
  } else {
    // ── JS fallback ────────────────────────────────────────────────────────
    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTileJS(
      xMin, yMin, xMax, yMax,
      tileW, tileH, maxIter,
      juliaRe, juliaIm, isJulia,
      _jsBuf
    );
    iterBuf = _jsBuf;
  }

  // Cache a copy of the iteration data for fast recoloring later
  iterCache.set(`${tileX},${tileY}`, iterBuf.slice(0));

  return applyColorization(iterBuf, size, palette, colorSpeed, colorOffset).buffer as ArrayBuffer;
}

function recolorTile(task: RecolorTask): ArrayBuffer | null {
  const key = `${task.tileX},${task.tileY}`;
  const iterBuf = iterCache.get(key);
  if (!iterBuf) return null;
  const size = task.tileW * task.tileH;
  return applyColorization(iterBuf, size, task.palette, task.colorSpeed, task.colorOffset).buffer as ArrayBuffer;
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<ToWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    await loadWasm(msg.wasmUrl);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'clearCache') {
    iterCache.clear();
    return;
  }

  if (msg.type === 'render') {
    const buf = renderTile(msg);
    // Transfer buffer ownership back to main thread (zero-copy)
    (self as unknown as Worker).postMessage(
      {
        type: 'result',
        taskId: msg.taskId,
        gen: msg.gen,
        tileX: msg.tileX,
        tileY: msg.tileY,
        tileW: msg.tileW,
        tileH: msg.tileH,
        imageData: buf,
      },
      [buf]
    );
    return;
  }

  if (msg.type === 'recolor') {
    const buf = recolorTile(msg);
    if (!buf) return; // no cached data — silently skip
    (self as unknown as Worker).postMessage(
      {
        type: 'result',
        taskId: msg.taskId,
        gen: msg.gen,
        tileX: msg.tileX,
        tileY: msg.tileY,
        tileW: msg.tileW,
        tileH: msg.tileH,
        imageData: buf,
      },
      [buf]
    );
  }
};

export { PALETTE_SIZE, samplePaletteData };
