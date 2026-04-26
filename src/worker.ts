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
import {stepFractalIteration} from './fractalMath';
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
        juliaRe: number, juliaIm: number, isJulia: number,
      multibrotPower: number,
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
    juliaRe: number, juliaIm: number, isJulia: boolean,
    buf: Float32Array, fractalType = 0, multibrotPower = 2.0
): void {
  const dx = (xMax - xMin) / width;
  const dy = (yMax - yMin) / height;
  const smoothBase = fractalType === 0 && Math.abs(multibrotPower) > 1.000001 ? Math.abs(multibrotPower) : 2.0;
  const logBase = Math.log(smoothBase);
  const negativeMultibrotMandelbrot = fractalType === 0 && multibrotPower < 0.0 && !isJulia;

  for (let py = 0; py < height; py++) {
    const im = yMin + py * dy;
    for (let px = 0; px < width; px++) {
      const re = xMin + px * dx;

      let zRe = isJulia || negativeMultibrotMandelbrot ? re : 0.0;
      let zIm = isJulia || negativeMultibrotMandelbrot ? im : 0.0;
      const cRe = isJulia ? juliaRe : re;
      const cIm = isJulia ? juliaIm : im;

      let iter = 0;
      let x2 = zRe * zRe;
      let y2 = zIm * zIm;

      while (x2 + y2 <= 100000.0 && iter < maxIter) {
        [zRe, zIm] = stepFractalIteration(zRe, zIm, cRe, cIm, fractalType, multibrotPower);
        x2 = zRe * zRe;
        y2 = zIm * zIm;
        iter++;
      }

      let val: number;
      if (iter >= maxIter) {
        val = -1.0;
      } else {
        const r2 = x2 + y2;
        if (!Number.isFinite(r2) || r2 > 1e300) {
          // Infinite escape (common near poles for d < 0): keep it as exterior.
          val = iter;
        } else {
          const logZn = Math.log(r2) * 0.5;
          const nu = Math.log(logZn / logBase) / logBase;
          val = Number.isFinite(nu) ? (iter + 1.0 - nu) : iter;
        }
      }

      buf[py * width + px] = val;
    }
  }
}

// ─── Perturbation-theory renderer for deep-zoom tiles ─────────────────────────

function computeTilePerturbation(
    xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
    width: number, height: number, maxIter: number,
    juliaReStr: string, juliaImStr: string, isJulia: boolean,
    refReStr: string, refImStr: string,
    buf: Float32Array
): void {
  const refRe = ddFromString(refReStr);
  const refIm = ddFromString(refImStr);

  const cRe_dd: DD = isJulia ? ddFromString(juliaReStr) : refRe;
  const cIm_dd: DD = isJulia ? ddFromString(juliaImStr) : refIm;

  const orbitRe = new Float64Array(maxIter + 1);
  const orbitIm = new Float64Array(maxIter + 1);

  let zRe: DD = isJulia ? refRe : [0, 0];
  let zIm: DD = isJulia ? refIm : [0, 0];

  orbitRe[0] = zRe[0];
  orbitIm[0] = zIm[0];

  let refOrbitLen = 0;
  for (let n = 0; n < maxIter; n++) {
    const r2 = zRe[0] * zRe[0] + zIm[0] * zIm[0];
    if (r2 > 100000.0) {
      refOrbitLen = n;
      break;
    }
    const newZRe = ddAdd(ddSub(ddMul(zRe, zRe), ddMul(zIm, zIm)), cRe_dd);
    const newZIm = ddAdd(ddMulNum(ddMul(zRe, zIm), 2.0), cIm_dd);
    zRe = newZRe;
    zIm = newZIm;
    refOrbitLen = n + 1;
    orbitRe[n + 1] = zRe[0];
    orbitIm[n + 1] = zIm[0];
  }

  const xMin_dd = ddFromString(xMinStr);
  const xMax_dd = ddFromString(xMaxStr);
  const yMin_dd = ddFromString(yMinStr);
  const yMax_dd = ddFromString(yMaxStr);
  const dx_dd = ddDivNum(ddSub(xMax_dd, xMin_dd), width);
  const dy_dd = ddDivNum(ddSub(yMax_dd, yMin_dd), height);

  for (let py = 0; py < height; py++) {
    const pixelIm_dd = ddAdd(yMin_dd, ddMulNum(dy_dd, py));
    const dcImDD = ddSub(pixelIm_dd, refIm);
    const dcImF  = dcImDD[0] + dcImDD[1];

    for (let px = 0; px < width; px++) {
      const pixelRe_dd = ddAdd(xMin_dd, ddMulNum(dx_dd, px));
      const dcReDD = ddSub(pixelRe_dd, refRe);
      const dcReF  = dcReDD[0] + dcReDD[1];

      let dRe = isJulia ? dcReF : 0.0;
      let dIm = isJulia ? dcImF : 0.0;

      const loopDcRe = isJulia ? 0.0 : dcReF;
      const loopDcIm = isJulia ? 0.0 : dcImF;

      let iter = 0;
      let val  = -1.0;
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

        if (r2 > 100000.0) {
          const log_zn = Math.log(r2) * 0.5;
          const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
          val = iter + 1.0 - nu;
          break;
        }

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

      if (val === -1.0 && refOrbitLen < maxIter && iter < maxIter) {
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

      buf[py * width + px] = val;
    }
  }
}

function computeTilePerturbationQD(
    xMinStr: string, yMinStr: string, xMaxStr: string, yMaxStr: string,
    width: number, height: number, maxIter: number,
    juliaReStr: string, juliaImStr: string, isJulia: boolean,
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

        if (r2 > 100000.0) {
          const log_zn = Math.log(r2) * 0.5;
          const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
          val = iter + 1.0 - nu;
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

      if (val === -1.0 && refOrbitLen < maxIter && iter < maxIter) {
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

      buf[py * width + px] = val;
    }
  }
}

// ─── Per-tile iteration data cache ────────────────────────────────────────────

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
      const vL = px > 0          ? (iterBuf[py * tileW + (px - 1)] < 0 ? val : iterBuf[py * tileW + (px - 1)]) : val;
      const vR = px < tileW - 1  ? (iterBuf[py * tileW + (px + 1)] < 0 ? val : iterBuf[py * tileW + (px + 1)]) : val;
      const vU = py > 0          ? (iterBuf[(py - 1) * tileW + px]  < 0 ? val : iterBuf[(py - 1) * tileW + px])  : val;
      const vD = py < tileH - 1  ? (iterBuf[(py + 1) * tileW + px]  < 0 ? val : iterBuf[(py + 1) * tileW + px])  : val;
      const nx = -(vR - vL);
      const ny = -(vD - vU);
      const nz = 2.0;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
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
    juliaRe, juliaIm, isJulia, palette, colorSpeed, colorOffset, shadows
  } = task;
  const fractalType = task.fractalType ?? 0;
  const multibrotPower = Number.isFinite(task.multibrotPower) ? task.multibrotPower : 2.0;
  const size = tileW * tileH;

  const xMinHi = qdHi(qdFromString(xMin));
  const yMinHi = qdHi(qdFromString(yMin));
  const xMaxHi = qdHi(qdFromString(xMax));
  const yMaxHi = qdHi(qdFromString(yMax));

  const dxCheck = xMaxHi - xMinHi;
  const inferredTier = !Number.isFinite(dxCheck) ? 'qd' : (Math.abs(dxCheck) < 1e-28 ? 'qd' : (Math.abs(dxCheck) < 2e-13 ? 'dd' : 'wasm'));
  const baseTier = task.precisionTier ?? inferredTier;
  const requiresGeneralFormula = fractalType !== 0 || Math.abs(multibrotPower - 2.0) > 1e-12;
  const precisionTier = requiresGeneralFormula && baseTier !== 'wasm' ? 'wasm' : baseTier;

  let iterBuf: Float32Array;

  if (wasmInstance && precisionTier === 'wasm') {
    const ptr = wasmInstance.exports.allocBuffer(tileW, tileH);
    wasmInstance.exports.computeTile(
        xMinHi, yMinHi, xMaxHi, yMaxHi,
        tileW, tileH, maxIter,
        Number(juliaRe), Number(juliaIm), isJulia ? 1 : 0,
      multibrotPower,
        fractalType
    );
    iterBuf = new Float32Array(
        wasmInstance.exports.memory.buffer,
        ptr,
        size
    );
  } else if (precisionTier === 'wasm') {
    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTileJS(
        xMinHi, yMinHi, xMaxHi, yMaxHi,
        tileW, tileH, maxIter,
        Number(juliaRe), Number(juliaIm), isJulia,
      _jsBuf, fractalType, multibrotPower
    );
    iterBuf = _jsBuf;
  } else if (precisionTier === 'dd') {
    const refRe = task.refRe ?? xMin;
    const refIm = task.refIm ?? yMin;

    if (!_jsBuf || _jsBuf.length < size) {
      _jsBuf = new Float32Array(size);
    }
    computeTilePerturbation(
        xMin, yMin, xMax, yMax,
        tileW, tileH, maxIter,
        juliaRe, juliaIm, isJulia,
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
        juliaRe, juliaIm, isJulia,
        refRe, refIm,
        _jsBuf
    );
    iterBuf = _jsBuf;
  }

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
    if (!buf) return;
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