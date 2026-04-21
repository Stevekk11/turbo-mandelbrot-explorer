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
import {type DD, ddAdd, ddDivNum, ddFromString, ddMul, ddMulNum, ddSub} from './dd';
import {type QD, qdAdd, qdDivNum, qdFromString, qdHi, qdMul, qdMulNum, qdSub} from './qd';

// ─── WASM glue ────────────────────────────────────────────────────────────────

interface MandelbrotWasm {
  exports: {
    memory: WebAssembly.Memory;
    allocBuffer: (w: number, h: number) => number;
    computeTile: (
      xMin: number, yMin: number, xMax: number, yMax: number,
      width: number, height: number, maxIter: number,
      juliaRe: number, juliaIm: number, isJulia: number, orbitTrapMode: number,
      fractalType: number
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
  buf: Float32Array, fractalType = 0
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
        if (fractalType === 1) {
          // Burning Ship: take absolute values before squaring
          zIm = 2.0 * Math.abs(zRe) * Math.abs(zIm) + cIm;
          zRe = x2 - y2 + cRe;
        } else if (fractalType === 2) {
          // Tricorn (Mandelbar): z_{n+1} = conj(z_n)² + c
          // conj(z_n)² = (zRe - i·zIm)² = (zRe² - zIm²) - i·2·zRe·zIm
          zIm = -2.0 * zRe * zIm + cIm;
          zRe = x2 - y2 + cRe;
        } else {
          // Standard Mandelbrot
          zIm = 2.0 * zRe * zIm + cIm;
          zRe = x2 - y2 + cRe;
        }
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

      // n is the current index into the reference orbit.  It is reset to 0 on
      // rebasing so a single pixel may traverse the reference orbit many times.
      let n = 0;

      while (iter < maxIter) {
        if (n >= refOrbitLen) break; // reference orbit exhausted — handled by fallback below

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

        // ── Perturbation rebasing ──────────────────────────────────────────────
        // When |δ_{n+1}|² > |Z_{n+1}|² the floating-point perturbation has
        // drifted too far from the true orbit.  Reset the reference orbit index
        // to 0 and set δ = z_actual − Z_0 so the next step re-anchors the
        // perturbation to the start of the reference.  This allows the pixel to
        // accumulate arbitrarily many iterations without glitch artifacts.
        // For Mandelbrot Z_0 = 0, so δ_new = z_actual.
        // For Julia     Z_0 = refStart, so δ_new = z_actual − orbitRe/Im[0].
        //
        // Index safety: n < refOrbitLen ≤ maxIter, and orbitRe has maxIter+1
        // elements, so orbitRe[n+1] ≤ orbitRe[maxIter] is always in bounds.
        const d2    = dRe * dRe + dIm * dIm;
        const Zn1Re = orbitRe[n + 1];
        const Zn1Im = orbitIm[n + 1];
        if (d2 > Zn1Re * Zn1Re + Zn1Im * Zn1Im) {
          dRe = zActRe - orbitRe[0];
          dIm = zActIm - orbitIm[0];
          n = 0;
        } else {
          n++;
        }
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

function computeTilePerturbationQD(
    xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
    width: number, height: number, maxIter: number,
    juliaReStr: string, juliaImStr: string, isJulia: boolean,
    orbitTrapMode: number,
    refReStr: string, refImStr: string,
    buf: Float32Array
): void {
  const refRe = qdFromString(refReStr);
  const refIm = qdFromString(refImStr);
  const cRe_qd: QD = isJulia ? qdFromString(juliaReStr) : refRe;
  const cIm_qd: QD = isJulia ? qdFromString(juliaImStr) : refIm;

  const orbitRe = new Float64Array(maxIter + 1);
  const orbitIm = new Float64Array(maxIter + 1);

  let zRe: QD = isJulia ? refRe : [0, 0, 0, 0];
  let zIm: QD = isJulia ? refIm : [0, 0, 0, 0];

  orbitRe[0] = qdHi(zRe);
  orbitIm[0] = qdHi(zIm);

  let refOrbitLen = 0;
  for (let n = 0; n < maxIter; n++) {
    const zReHi = qdHi(zRe);
    const zImHi = qdHi(zIm);
    const r2 = zReHi * zReHi + zImHi * zImHi;
    if (r2 > 100000.0) {
      refOrbitLen = n;
      break;
    }
    const newZRe = qdAdd(qdSub(qdMul(zRe, zRe), qdMul(zIm, zIm)), cRe_qd);
    const newZIm = qdAdd(qdMulNum(qdMul(zRe, zIm), 2.0), cIm_qd);
    zRe = newZRe;
    zIm = newZIm;
    refOrbitLen = n + 1;
    orbitRe[n + 1] = qdHi(zRe);
    orbitIm[n + 1] = qdHi(zIm);
  }

  const xMin_qd = qdFromString(xMinStr);
  const xMax_qd = qdFromString(xMaxStr);
  const yMin_qd = qdFromString(yMinStr);
  const yMax_qd = qdFromString(yMaxStr);
  const dx_qd = qdDivNum(qdSub(xMax_qd, xMin_qd), width);
  const dy_qd = qdDivNum(qdSub(yMax_qd, yMin_qd), height);

  for (let py = 0; py < height; py++) {
    const pixelIm_qd = qdAdd(yMin_qd, qdMulNum(dy_qd, py));
    const dcImQD = qdSub(pixelIm_qd, refIm);
    // Use all 4 components for better precision in the float64 perturbation
    const dcImF = (dcImQD[0] + dcImQD[1]) + (dcImQD[2] + dcImQD[3]);

    for (let px = 0; px < width; px++) {
      const pixelRe_qd = qdAdd(xMin_qd, qdMulNum(dx_qd, px));
      const dcReQD_p = qdSub(pixelRe_qd, refRe);
      const dcReF_p = (dcReQD_p[0] + dcReQD_p[1]) + (dcReQD_p[2] + dcReQD_p[3]);

      let dRe = isJulia ? dcReF_p : 0.0;
      let dIm = isJulia ? dcImF : 0.0;

      const loopDcRe = isJulia ? 0.0 : dcReF_p;
      const loopDcIm = isJulia ? 0.0 : dcImF;

      let iter = 0;
      let val = -1.0;
      let minDist = 1e20;
      let n = 0;

      while (iter < maxIter) {
        if (n >= refOrbitLen) break;

        const ZnRe = orbitRe[n];
        const ZnIm = orbitIm[n];

        const a = 2.0 * ZnRe + dRe;
        const b = 2.0 * ZnIm + dIm;
        const newDRe = a * dRe - b * dIm + loopDcRe;
        const newDIm = a * dIm + b * dRe + loopDcIm;
        dRe = newDRe;
        dIm = newDIm;
        iter++;

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

        const d2 = dRe * dRe + dIm * dIm;
        const Zn1Re = orbitRe[n + 1];
        const Zn1Im = orbitIm[n + 1];
        if (d2 > Zn1Re * Zn1Re + Zn1Im * Zn1Im) {
          dRe = zActRe - orbitRe[0];
          dIm = zActIm - orbitIm[0];
          n = 0;
        } else {
          n++;
        }
      }

      if (val === -1.0 && refOrbitLen < maxIter && iter < maxIter && orbitTrapMode === 0) {
        let zRe = orbitRe[refOrbitLen] + dRe;
        let zIm = orbitIm[refOrbitLen] + dIm;
        const cPixelRe = isJulia ? Number(juliaReStr) : (qdHi(refRe) + dcReF_p);
        const cPixelIm = isJulia ? Number(juliaImStr) : (qdHi(refIm) + dcImF);

        while (iter < maxIter) {
          const x2 = zRe * zRe;
          const y2 = zIm * zIm;
          const r2 = x2 + y2;
          if (r2 > 100000.0) {
            const log_zn = Math.log(r2) * 0.5;
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
  tileW: number,
  tileH: number,
  palette: number,
  colorSpeed: number,
  colorOffset: number,
  shadows: boolean
): Uint8ClampedArray {
  const paletteData = PALETTES[palette].data;
  const size = tileW * tileH;
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
    let r = (paletteData[b0]     + (paletteData[b1]     - paletteData[b0])     * frac) | 0;
    let g = (paletteData[b0 + 1] + (paletteData[b1 + 1] - paletteData[b0 + 1]) * frac) | 0;
    let b = (paletteData[b0 + 2] + (paletteData[b1 + 2] - paletteData[b0 + 2]) * frac) | 0;

    if (shadows) {
      const py = Math.floor(i / tileW);
      const px = i % tileW;
      // Sample neighbours, clamping to tile edges; use val for interior pixels
      const vL = px > 0          ? (iterBuf[py * tileW + (px - 1)] < 0 ? val : iterBuf[py * tileW + (px - 1)]) : val;
      const vR = px < tileW - 1  ? (iterBuf[py * tileW + (px + 1)] < 0 ? val : iterBuf[py * tileW + (px + 1)]) : val;
      const vU = py > 0          ? (iterBuf[(py - 1) * tileW + px]  < 0 ? val : iterBuf[(py - 1) * tileW + px])  : val;
      const vD = py < tileH - 1  ? (iterBuf[(py + 1) * tileW + px]  < 0 ? val : iterBuf[(py + 1) * tileW + px])  : val;
      // Surface gradient → normal
      const nx = -(vR - vL);
      const ny = -(vD - vU);
      const nz = 2.0;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      // Light from upper-left
      const lx = 0.5774, ly = 0.5774, lz = 0.5774;
      const dot = (nx / nlen) * lx + (ny / nlen) * ly + (nz / nlen) * lz;
      const light = Math.max(0.25, Math.min(1.0, dot));
      r = Math.min(255, (r * light) | 0);
      g = Math.min(255, (g * light) | 0);
      b = Math.min(255, (b * light) | 0);
    }

    rgba[o]     = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return rgba;
}

// ─── Tile rendering ───────────────────────────────────────────────────────────

let _jsBuf: Float32Array | null = null;

function renderTile(task: RenderTask): ArrayBuffer {
  const { tileX, tileY, tileW, tileH, xMin, yMin, xMax, yMax, maxIter,
    juliaRe, juliaIm, isJulia, palette, colorSpeed, colorOffset, orbitTrapMode, shadows
  } = task;
  const fractalType = task.fractalType ?? 0;
  const size = tileW * tileH;

  // Parse highs from QD/DD/number strings uniformly.
  const xMinHi = qdHi(qdFromString(xMin));
  const yMinHi = qdHi(qdFromString(yMin));
  const xMaxHi = qdHi(qdFromString(xMax));
  const yMaxHi = qdHi(qdFromString(yMax));

  const dxCheck = xMaxHi - xMinHi;
  const inferredTier = !Number.isFinite(dxCheck) ? 'qd' : (Math.abs(dxCheck) < 1e-28 ? 'qd' : (Math.abs(dxCheck) < 2e-13 ? 'dd' : 'wasm'));
  // Perturbation theory only applies to Mandelbrot (fractalType 0); fall back to
  // JS for Burning Ship and Tricorn which have non-analytic iteration formulas.
  const baseTier = task.precisionTier ?? inferredTier;
  const precisionTier = fractalType !== 0 && baseTier !== 'wasm' ? 'wasm' : baseTier;

  let iterBuf: Float32Array;

  if (wasmInstance && precisionTier === 'wasm') {
    // ─── WASM path ──────────────────────────────────────────────────────────
    const ptr = wasmInstance.exports.allocBuffer(tileW, tileH);
    wasmInstance.exports.computeTile(
      xMinHi, yMinHi, xMaxHi, yMaxHi,
      tileW, tileH, maxIter,
      Number(juliaRe), Number(juliaIm), isJulia ? 1 : 0, orbitTrapMode || 0,
      fractalType
    );
    iterBuf = new Float32Array(
      wasmInstance.exports.memory.buffer,
      ptr,
      size
    );
  } else if (precisionTier === 'wasm') {
    // ─── JS fallback for normal-precision (WASM unavailable) ───────────────
    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTileJS(
      xMinHi, yMinHi, xMaxHi, yMaxHi,
      tileW, tileH, maxIter,
      Number(juliaRe), Number(juliaIm), isJulia, orbitTrapMode || 0,
      _jsBuf, fractalType
    );
    iterBuf = _jsBuf;
  } else if (precisionTier === 'dd') {
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
  } else {
    const refRe = task.refRe ?? xMin;
    const refIm = task.refIm ?? yMin;

    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTilePerturbationQD(
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

  return applyColorization(iterBuf, tileW, tileH, palette, colorSpeed, colorOffset, shadows ?? false).buffer as ArrayBuffer;
}

function recolorTile(task: RecolorTask): ArrayBuffer | null {
  const key = `${task.tileX},${task.tileY}`;
  const iterBuf = iterCache.get(key);
  if (!iterBuf) return null;
  return applyColorization(iterBuf, task.tileW, task.tileH, task.palette, task.colorSpeed, task.colorOffset, task.shadows ?? false).buffer as ArrayBuffer;
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

  if (msg.type === 'updatePalette') {
    if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < PALETTES.length) {
      PALETTES[msg.index].data = new Uint8ClampedArray(msg.data);
    }
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
