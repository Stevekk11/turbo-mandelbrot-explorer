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
import {type DD, ddAdd, ddSub, ddMul, ddMulNum, ddDivNum, ddFromString} from './dd';

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

// ─── JavaScript fallback for normal-precision tiles (WASM unavailable) ───────

function computeTileJS(
  xMin: number, yMin: number, xMax: number, yMax: number,
  width: number, height: number, maxIter: number,
  juliaRe: number, juliaIm: number, isJulia: boolean, orbitTrapMode: number,
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

// ─── Perturbation-theory renderer for deep-zoom tiles ─────────────────────────
//
// Standard Mandelbrot / Julia iteration requires arbitrary-precision
// coordinates once the viewport width drops below ~1e-13 (float64 runs out
// of mantissa bits).  Perturbation theory sidesteps that by computing one
// high-precision "reference orbit" with DD arithmetic, then deriving every
// other pixel's iteration count from a cheap float64 perturbation delta.
//
// For a Mandelbrot pixel c = C_ref + Δc :
//   δ_0 = 0
//   δ_{n+1} = (2·Z_n + δ_n)·δ_n + Δc          (float64 complex arithmetic)
//   z_n = Z_n + δ_n                              (actual pixel iterate)
//
// For a Julia pixel with start p = P_ref + Δp :
//   δ_0 = Δp
//   δ_{n+1} = (2·Z_n + δ_n)·δ_n                 (no Δc term — absorbed in δ_0)
//
// Reference orbit Z_n is computed in DD to stay accurate beyond 10^15 zoom.

function computeTilePerturbation(
  xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
  width: number, height: number, maxIter: number,
  juliaReStr: string, juliaImStr: string, isJulia: boolean,
  orbitTrapMode: number,
  refReStr: string, refImStr: string,
  buf: Float32Array
): void {
  // ── Reference point and iteration constant (both in DD) ────────────────────
  const refRe = ddFromString(refReStr);
  const refIm = ddFromString(refImStr);

  // For Mandelbrot the constant equals the reference; for Julia it is fixed.
  const cRe_dd: DD = isJulia ? ddFromString(juliaReStr) : refRe;
  const cIm_dd: DD = isJulia ? ddFromString(juliaImStr) : refIm;

  // ── Reference orbit (computed in DD, stored as float64 for the inner loop) ─
  // We allocate maxIter+1 slots:  orbitRe[n] = Re(Z_n), orbitIm[n] = Im(Z_n).
  // Float64Array is zero-initialised, so out-of-bounds reads return 0.
  const orbitRe = new Float64Array(maxIter + 1);
  const orbitIm = new Float64Array(maxIter + 1);

  // Julia orbit starts at the reference pixel; Mandelbrot starts at 0.
  let zRe: DD = isJulia ? refRe : [0, 0];
  let zIm: DD = isJulia ? refIm : [0, 0];

  orbitRe[0] = zRe[0];
  orbitIm[0] = zIm[0];

  let refOrbitLen = 0;
  for (let n = 0; n < maxIter; n++) {
    // Escape check on the float64 approximation (sufficient for the orbit)
    const r2 = zRe[0] * zRe[0] + zIm[0] * zIm[0];
    if (r2 > 100000.0) {
      refOrbitLen = n;
      break;
    }
    // Z_{n+1} = Z_n^2 + C  (DD arithmetic)
    const newZRe = ddAdd(ddSub(ddMul(zRe, zRe), ddMul(zIm, zIm)), cRe_dd);
    const newZIm = ddAdd(ddMulNum(ddMul(zRe, zIm), 2.0), cIm_dd);
    zRe = newZRe;
    zIm = newZIm;
    refOrbitLen = n + 1;
    orbitRe[n + 1] = zRe[0];
    orbitIm[n + 1] = zIm[0];
  }
  // refOrbitLen == maxIter means the reference is interior (never escaped).

  // ── Tile pixel bounds in DD ─────────────────────────────────────────────────
  const xMin_dd = ddFromString(xMinStr);
  const xMax_dd = ddFromString(xMaxStr);
  const yMin_dd = ddFromString(yMinStr);
  const yMax_dd = ddFromString(yMaxStr);
  const dx_dd = ddDivNum(ddSub(xMax_dd, xMin_dd), width);
  const dy_dd = ddDivNum(ddSub(yMax_dd, yMin_dd), height);

  // ── Per-pixel perturbation ─────────────────────────────────────────────────
  for (let py = 0; py < height; py++) {
    const pixelIm_dd = ddAdd(yMin_dd, ddMulNum(dy_dd, py));
    // Δcy = pixel_im − ref_im  (as float64; hi+lo gives best f64 representation)
    const dcImDD = ddSub(pixelIm_dd, refIm);
    const dcImF  = dcImDD[0] + dcImDD[1];

    for (let px = 0; px < width; px++) {
      const pixelRe_dd = ddAdd(xMin_dd, ddMulNum(dx_dd, px));
      const dcReDD = ddSub(pixelRe_dd, refRe);
      const dcReF  = dcReDD[0] + dcReDD[1];

      // Initial perturbation δ_0:
      //   Mandelbrot → 0 (Δc enters via the recurrence term)
      //   Julia      → Δp (pixel offset from reference start)
      let dRe = isJulia ? dcReF : 0.0;
      let dIm = isJulia ? dcImF : 0.0;

      // The recurrence term Δc that is added each step:
      //   Mandelbrot → Δc,  Julia → 0 (already folded into δ_0)
      const loopDcRe = isJulia ? 0.0 : dcReF;
      const loopDcIm = isJulia ? 0.0 : dcImF;

      let iter = 0;
      let val  = -1.0;
      let minDist = 1e20;

      for (let n = 0; n < refOrbitLen; n++) {
        const ZnRe = orbitRe[n];
        const ZnIm = orbitIm[n];

        // δ_{n+1} = (2·Z_n + δ_n)·δ_n + Δc
        const a = 2.0 * ZnRe + dRe;
        const b = 2.0 * ZnIm + dIm;
        const newDRe = a * dRe - b * dIm + loopDcRe;
        const newDIm = a * dIm + b * dRe + loopDcIm;
        dRe = newDRe;
        dIm = newDIm;
        iter++;

        // z_{n+1} = Z_{n+1} + δ_{n+1}
        // orbitRe[n+1] holds Z_{n+1} for n+1 ≤ refOrbitLen (always within loop).
        const zActRe = orbitRe[n + 1] + dRe;
        const zActIm = orbitIm[n + 1] + dIm;
        const r2 = zActRe * zActRe + zActIm * zActIm;

        if (orbitTrapMode > 0) {
          const dist = orbitTrapMode === 1
            ? Math.sqrt(r2)
            : Math.abs(zActRe * zActIm);
          if (dist < minDist) minDist = dist;
        }

        if (r2 > 100000.0) {
          if (orbitTrapMode === 0) {
            const log_zn = Math.log(r2) * 0.5;
            const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
            val = iter + 1.0 - nu;
          }
          break;
        }

        if (iter >= maxIter) break;
      }

      // When the reference orbit escaped early (refOrbitLen < maxIter) the
      // perturbation approximation can break down for pixels close to the set
      // boundary that need more iterations.  Continue from the last computed
      // z = Z_{refOrbitLen} + δ using standard float64 iteration so they are
      // correctly classified rather than being left as interior (-1).
      if (val === -1.0 && refOrbitLen < maxIter && iter < maxIter && orbitTrapMode === 0) {
        let zRe = orbitRe[refOrbitLen] + dRe;
        let zIm = orbitIm[refOrbitLen] + dIm;
        const cPixelRe = isJulia ? Number(juliaReStr) : (refRe[0] + dcReF);
        const cPixelIm = isJulia ? Number(juliaImStr) : (refIm[0] + dcImF);

        while (iter < maxIter) {
          const x2 = zRe * zRe;
          const y2 = zIm * zIm;
          if (x2 + y2 > 100000.0) {
            const log_zn = Math.log(x2 + y2) * 0.5;
            const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
            val = iter + 1.0 - nu;
            break;
          }
          const newZIm = 2.0 * zRe * zIm + cPixelIm;
          zRe = x2 - y2 + cPixelRe;
          zIm = newZIm;
          iter++;
        }
      }

      if (orbitTrapMode > 0) {
        val = minDist < 1e19 ? Math.log(minDist + 1e-10) * -10.0 : -1.0;
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

  // Extract the float64 hi-part from DD-format strings (e.g. "hi|lo") so we
  // can pass valid f64 values to WASM and check whether this tile needs
  // the high-precision path.
  const xMinHi = ddFromString(xMin)[0];
  const yMinHi = ddFromString(yMin)[0];
  const xMaxHi = ddFromString(xMax)[0];
  const yMaxHi = ddFromString(yMax)[0];

  const dxCheck = xMaxHi - xMinHi;
  const needsHighPrec = dxCheck < 1e-13 || isNaN(dxCheck);

  let iterBuf: Float32Array;

  if (wasmInstance && !needsHighPrec) {
    // ─── WASM path ──────────────────────────────────────────────────────────
    const ptr = wasmInstance.exports.allocBuffer(tileW, tileH);
    wasmInstance.exports.computeTile(
      xMinHi, yMinHi, xMaxHi, yMaxHi,
      tileW, tileH, maxIter,
      Number(juliaRe), Number(juliaIm), isJulia ? 1 : 0, orbitTrapMode || 0
    );
    iterBuf = new Float32Array(
      wasmInstance.exports.memory.buffer,
      ptr,
      size
    );
  } else if (!needsHighPrec) {
    // ─── JS fallback for normal-precision (WASM unavailable) ───────────────
    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTileJS(
      xMinHi, yMinHi, xMaxHi, yMaxHi,
      tileW, tileH, maxIter,
      Number(juliaRe), Number(juliaIm), isJulia, orbitTrapMode || 0,
      _jsBuf
    );
    iterBuf = _jsBuf;
  } else {
    // ─── Perturbation path for deep zoom ────────────────────────────────────
    // refRe / refIm are the view-centre coordinates supplied by main.ts.
    // Fall back to using the tile's own xMin/yMin if somehow absent.
    const refRe = task.refRe ?? xMin;
    const refIm = task.refIm ?? yMin;

    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTilePerturbation(
      xMin, yMin, xMax, yMax,
      tileW, tileH, maxIter,
      juliaRe, juliaIm, isJulia, orbitTrapMode || 0,
      refRe, refIm,
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
