/**
 * Mandelbrot/Julia Web Worker
 *
 * Loads the WASM module once, then handles render tasks off the main thread.
 * Each task renders a rectangular tile and returns RGBA pixel data.
 * Iteration data is cached per tile so color-only changes can be applied
 * without recomputing the fractal (recolor task).
 */

import type {RecolorTask, RenderTask, ToWorkerMessage} from './types';
import {PALETTE_SIZE, PALETTES, samplePaletteData} from './colorPalettes';
import Decimal from 'decimal.js';

Decimal.set({precision: 60});

// ─── WASM glue ────────────────────────────────────────────────────────────────

interface MandelbrotWasm {
  exports: {
    memory: WebAssembly.Memory;
    allocBuffer: (w: number, h: number) => number;
    computeTile: (
      xMin: number, yMin: number, xMax: number, yMax: number,
      width: number, height: number, maxIter: number,
      juliaRe: number, juliaIm: number, isJulia: number, orbitTrapMode: number
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
    xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
  width: number, height: number, maxIter: number,
    juliaReStr: string, juliaImStr: string, isJulia: boolean, orbitTrapMode: number,
  buf: Float32Array
): void {
  const xMin = Number(xMinStr);
  const yMin = Number(yMinStr);
  const xMax = Number(xMaxStr);
  const yMax = Number(yMaxStr);
  const dx = (xMax - xMin) / width;
  const dy = (yMax - yMin) / height;
  const juliaRe = Number(juliaReStr);
  const juliaIm = Number(juliaImStr);

  if (xMax - xMin < 1e-13 || isNaN(dx)) {
    computeTileDecimal(xMinStr, yMinStr, xMaxStr, yMaxStr, width, height, maxIter, juliaReStr, juliaImStr, isJulia, orbitTrapMode, buf);
    return;
  }

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
      let minDist = 1e20;

      while (x2 + y2 <= 100000.0 && iter < maxIter) {
        zIm = 2.0 * zRe * zIm + cIm;
        zRe = x2 - y2 + cRe;
        x2 = zRe * zRe;
        y2 = zIm * zIm;
        iter++;

        if (orbitTrapMode > 0) {
          let dist = 1e20;
          if (orbitTrapMode === 1) {
            dist = Math.sqrt(x2 + y2);
          } else if (orbitTrapMode === 2) {
            dist = Math.abs(zRe * zIm);
          }
          if (dist < minDist) minDist = dist;
        }
      }

      let val: number;
      if (orbitTrapMode > 0) {
        val = minDist < 1e19 ? Math.log(minDist + 1e-10) * -10.0 : -1.0;
      } else if (iter >= maxIter) {
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

function computeTileDecimal(
    xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
    width: number, height: number, maxIter: number,
    juliaReStr: string, juliaImStr: string, isJulia: boolean, orbitTrapMode: number,
    buf: Float32Array
): void {
  const dXMin = new Decimal(xMinStr);
  const dYMin = new Decimal(yMinStr);
  const dXMax = new Decimal(xMaxStr);
  const dYMax = new Decimal(yMaxStr);
  const dx = dXMax.minus(dXMin).div(width);
  const dy = dYMax.minus(dYMin).div(height);
  const cReD = new Decimal(juliaReStr);
  const cImD = new Decimal(juliaImStr);

  const zero = new Decimal(0);
  const escapeRadius = new Decimal(100000.0);

  // Pre-calculate x coordinates to avoid repeated additions in the inner loop
  const xCoords = new Array<Decimal>(width);
  for (let px = 0; px < width; px++) {
    xCoords[px] = dXMin.plus(dx.times(px));
  }

  for (let py = 0; py < height; py++) {
    const im = dYMin.plus(dy.times(py));
    for (let px = 0; px < width; px++) {
      const re = xCoords[px];

      let zRe: Decimal;
      let zIm: Decimal;
      let cRe: Decimal;
      let cIm: Decimal;

      if (isJulia) {
        zRe = re;
        zIm = im;
        cRe = cReD;
        cIm = cImD;
      } else {
        zRe = zero;
        zIm = zero;
        cRe = re;
        cIm = im;
      }

      let iter = 0;
      let x2 = zRe.times(zRe);
      let y2 = zIm.times(zIm);
      let minDist = new Decimal('1e20');
      let val = -1.0;

      while (x2.plus(y2).lte(escapeRadius) && iter < maxIter) {
        if (orbitTrapMode > 0) {
          let dist = new Decimal('1e20');
          if (orbitTrapMode === 1) {
            // dist = Math.sqrt(x2 + y2);
            dist = x2.plus(y2).sqrt();
          } else if (orbitTrapMode === 2) {
            // dist = Math.abs(zRe * zIm);
            dist = zRe.times(zIm).abs();
          }
          if (dist.lt(minDist)) minDist = dist;
        }

        zIm = zRe.times(zIm).times(2).plus(cIm);
        zRe = x2.minus(y2).plus(cRe);
        x2 = zRe.times(zRe);
        y2 = zIm.times(zIm);
        iter++;
      }

      if (orbitTrapMode > 0) {
        val = minDist.lt('1e19') ? Math.log(minDist.toNumber() + 1e-10) * -10.0 : -1.0;
      } else if (iter < maxIter) {
        const x2y2 = x2.plus(y2).toNumber();
        const log_zn = Math.log(x2y2) * 0.5;
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
    juliaRe, juliaIm, isJulia, palette, colorSpeed, colorOffset, orbitTrapMode
  } = task;
  const size = tileW * tileH;

  let iterBuf: Float32Array;

  const dxCheck = Number(xMax) - Number(xMin);
  const needsDecimal = dxCheck < 1e-13 || isNaN(dxCheck);

  if (wasmInstance && !needsDecimal) {
    // ─── WASM path ────────────────────────────────────────────────────────────────
    const ptr = wasmInstance.exports.allocBuffer(tileW, tileH);
    wasmInstance.exports.computeTile(
        Number(xMin), Number(yMin), Number(xMax), Number(yMax),
      tileW, tileH, maxIter,
        Number(juliaRe), Number(juliaIm), isJulia ? 1 : 0, orbitTrapMode || 0
    );
    // Read results directly from WASM linear memory
    iterBuf = new Float32Array(
      wasmInstance.exports.memory.buffer,
      ptr,
      size
    );
  } else {
    // ─── JS fallback ──────────────────────────────────────────────────────────────
    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTileJS(
      xMin, yMin, xMax, yMax,
      tileW, tileH, maxIter,
        juliaRe, juliaIm, isJulia, orbitTrapMode || 0,
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
