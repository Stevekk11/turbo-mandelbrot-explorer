/**
 * Mandelbrot/Julia Web Worker
 *
 * Loads the WASM module once, then handles render tasks off the main thread.
 * Each task renders a rectangular tile and returns RGBA pixel data.
 */

import type { ToWorkerMessage, RenderTask } from './types';
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

// ─── Tile rendering ───────────────────────────────────────────────────────────

let _jsBuf: Float32Array | null = null;

function renderTile(task: RenderTask): ArrayBuffer {
  const { tileW, tileH, xMin, yMin, xMax, yMax, maxIter,
          juliaRe, juliaIm, isJulia, palette, colorSpeed, colorOffset } = task;
  const size = tileW * tileH;

  const paletteData = PALETTES[palette].data;
  const rgba = new Uint8ClampedArray(size * 4);

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

  // ── Color mapping ──────────────────────────────────────────────────────────
  for (let i = 0; i < size; i++) {
    const val = iterBuf[i];
    const [r, g, b] = samplePaletteData(paletteData, val, colorSpeed, colorOffset);
    const o = i * 4;
    rgba[o]     = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }

  return rgba.buffer;
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<ToWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    await loadWasm(msg.wasmUrl);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'render') {
    const buf = renderTile(msg);
    // Transfer buffer ownership back to main thread (zero-copy)
    (self as unknown as Worker).postMessage(
      {
        type: 'result',
        taskId: msg.taskId,
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

export { PALETTE_SIZE };
