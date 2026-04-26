/**
 * Turbo Mandelbrot Explorer — Main Application
 *
 * Orchestrates rendering, UI state, worker pool, and interactions.
 */

import './style.css';
import type {PrecisionTier, RecolorTask, RenderResult, RenderTask, ViewState} from './types';
import {generateRandomPalette, PALETTES, RANDOM_PALETTE_INDEX} from './colorPalettes';
import {createAudioControls} from './audioControls';
import {createBookmarks} from './bookmarks';
import {createInteractions} from './interactions';
import {createMiniMap} from './miniMap';
import {createOverlays} from './overlays';
import {type QD, qdAdd, qdDiv, qdDivNum, qdFromString, qdHi, qdMulNum, qdSub, qdToString,} from './qd';

// ─── Worker pool ──────────────────────────────────────────────────────────────

const NUM_WORKERS = Math.max(2, Math.min(16, navigator.hardwareConcurrency ?? 4));
const workers: Worker[] = [];
let workersReady = 0;

function createWorkerPool(wasmUrl: string) {
  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = handleWorkerMessage;
    w.postMessage({ type: 'init', wasmUrl });
    workers.push(w);
  }
}

// ─── Application state ────────────────────────────────────────────────────────

const DEFAULT_VIEW: ViewState = {
  xMin: '-2.5', xMax: '1.0',
  yMin: '-1.25', yMax: '1.25',
  maxIter: 1000,
  palette: 2,
  colorSpeed: 0.8,
  colorOffset: 0.35,
  isJulia: false,
  juliaRe: '-0.7269',
  juliaIm: '0.1889',
  zoom: '1',
  shadows: false,
  fractalType: 0,
  multibrotPower: 2.0,
};

let view: ViewState = { ...DEFAULT_VIEW };
let renderGen = 0;          // incremented on each render to cancel stale results
let recolorGen = 0;         // incremented on each recolor request to cancel stale results
let pendingTiles = 0;
let completedTiles = 0;
let totalTiles = 0;
let isRendering = false;

const precisionTierHintEl = document.getElementById('precision-tier-hint');

function updatePrecisionTierHint(tier: PrecisionTier) {
  if (!precisionTierHintEl) return;
  precisionTierHintEl.textContent = `p: ${tier.toUpperCase()}`;
}

// Tile queue for distributing work
interface PendingTask { task: RenderTask; gen: number }
const taskQueue: PendingTask[] = [];
const workerBusy: boolean[] = Array(NUM_WORKERS).fill(false);

// Maps tile key `${tileX},${tileY}` → worker index (set when a tile is dispatched)
const tileWorkerMap = new Map<string, number>();

// Tracks how many recolor tiles are still pending for the current recolorGen
let pendingRecolorTiles = 0;

let renderSnapshot: OffscreenCanvas | null = null;
let activeTiles: { canvas: OffscreenCanvas, x: number, y: number, startTime: number }[] = [];
let fadeRaf = 0;
let activeTilesGen = 0;
let activeTilesIsRecolor = false;

function startTileAnimation(gen: number, isRecolor: boolean) {
  if (audioControls.isColorAnimActive() || audioControls.isAudioPulseActive()) return;
  renderSnapshot = new OffscreenCanvas(canvas.width, canvas.height);
  renderSnapshot.getContext('2d')!.drawImage(canvas, 0, 0);
  activeTiles = [];
  activeTilesGen = gen;
  activeTilesIsRecolor = isRecolor;
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  fadeRaf = requestAnimationFrame(animateTiles);
}

function animateTiles() {
  const currentGen = activeTilesIsRecolor ? recolorGen : renderGen;
  if (activeTilesGen !== currentGen) return;
  if (interactions.isDragging() || !interactions.wheelTimerIsIdle()) return;

  if (!renderSnapshot) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(renderSnapshot, 0, 0);

  const now = performance.now();
  let allDone = true;

  for (const t of activeTiles) {
    let alpha = (now - t.startTime) / 250;
    if (alpha >= 1.0) alpha = 1.0;
    else allDone = false;

    ctx.globalAlpha = alpha;
    ctx.drawImage(t.canvas, t.x, t.y);
  }
  ctx.globalAlpha = 1.0;

  const receivedAll = activeTilesIsRecolor
      ? (pendingRecolorTiles === 0)
      : (completedTiles >= totalTiles);

  if (receivedAll && allDone) {
    if (offscreen) {
      ctx.drawImage(offscreen, 0, 0);
      drawAllOverlays();
    }
  } else {
    fadeRaf = requestAnimationFrame(animateTiles);
  }
}

// ─── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('fractal-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Offscreen canvas for assembling tile results before blitting
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width  = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);

  offscreen = new OffscreenCanvas(canvas.width, canvas.height);
  offCtx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;

  // Keep aspect ratio correct by adjusting Y range
  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const cy = qdDivNum(qdAdd(qdFromString(view.yMin), qdFromString(view.yMax)), 2);
  const xRange = qdSub(dXMax, dXMin);
  // aspect = width / height, so yRange = xRange / aspect = xRange * (height / width)
  const yRange = qdDivNum(qdMulNum(xRange, canvas.height), canvas.width);
  view.yMin = qdToString(qdSub(cy, qdDivNum(yRange, 2)));
  view.yMax = qdToString(qdAdd(cy, qdDivNum(yRange, 2)));

  scheduleRender();
}

window.addEventListener('resize', () => resizeCanvas());

// ─── Tiled rendering ──────────────────────────────────────────────────────────

const TILE_SIZE = 256;

function getPrecisionTier(xRange: QD): PrecisionTier {
  const dx = Math.abs(qdHi(xRange));
  if (!Number.isFinite(dx) || dx < 1e-28) return 'qd';
  if (dx < 2e-13) return 'dd';
  return 'wasm';
}

function scheduleRender() {
  if (!offscreen || workersReady < NUM_WORKERS) return;
  renderGen++;
  const gen = renderGen;

  // Tell every worker to drop its cached iteration data so memory is not wasted
  for (const w of workers) w.postMessage({ type: 'clearCache' });

  taskQueue.length = 0;
  tileWorkerMap.clear();
  pendingTiles = 0;
  completedTiles = 0;

  const cw = canvas.width;
  const ch = canvas.height;
  const cols = Math.ceil(cw / TILE_SIZE);
  const rows = Math.ceil(ch / TILE_SIZE);
  totalTiles = cols * rows;

  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const dYMin = qdFromString(view.yMin);
  const dYMax = qdFromString(view.yMax);
  const xRange = qdSub(dXMax, dXMin);
  const yRange = qdSub(dYMax, dYMin);
  const precisionTier = getPrecisionTier(xRange);
  updatePrecisionTierHint(precisionTier);

  // View-centre reference point for perturbation-theory deep-zoom tiles
  const refReStr = qdToString(qdDivNum(qdAdd(dXMin, dXMax), 2));
  const refImStr = qdToString(qdDivNum(qdAdd(dYMin, dYMax), 2));

  let taskId = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileX = col * TILE_SIZE;
      const tileY = row * TILE_SIZE;
      const tileW = Math.min(TILE_SIZE, cw - tileX);
      const tileH = Math.min(TILE_SIZE, ch - tileY);

      const task: RenderTask = {
        type: 'render',
        taskId: taskId++,
        gen,
        tileX, tileY, tileW, tileH,
        xMin: qdToString(qdAdd(dXMin, qdMulNum(qdDivNum(xRange, cw), tileX))),
        yMin: qdToString(qdAdd(dYMin, qdMulNum(qdDivNum(yRange, ch), tileY))),
        xMax: qdToString(qdAdd(dXMin, qdMulNum(qdDivNum(xRange, cw), tileX + tileW))),
        yMax: qdToString(qdAdd(dYMin, qdMulNum(qdDivNum(yRange, ch), tileY + tileH))),
        maxIter: view.maxIter,
        juliaRe: view.juliaRe,
        juliaIm: view.juliaIm,
        isJulia: view.isJulia,
        palette: view.palette,
        colorSpeed: view.colorSpeed,
        colorOffset: view.colorOffset,
        shadows: view.shadows,
        fractalType: view.fractalType,
        multibrotPower: view.multibrotPower,
        precisionTier,
        refRe: refReStr,
        refIm: refImStr,
      };
      taskQueue.push({ task, gen });
    }
  }

  pendingTiles = totalTiles;
  isRendering = true;
  updateProgressBar(0);

  startTileAnimation(gen, false);

  // Dispatch to idle workers
  dispatchTasks();
}

function dispatchTasks() {
  let workerIdx = 0;
  while (workerIdx < NUM_WORKERS && taskQueue.length > 0) {
    if (!workerBusy[workerIdx]) {
      const item = taskQueue.shift()!;
      if (item.gen !== renderGen) {
        // Skip stale tasks without advancing to the next worker
        continue;
      }
      workerBusy[workerIdx] = true;
      tileWorkerMap.set(`${item.task.tileX},${item.task.tileY}`, workerIdx);
      workers[workerIdx].postMessage(item.task);
    }
    workerIdx++;
  }
}

function handleWorkerMessage(e: MessageEvent) {
  const msg = e.data as RenderResult | { type: 'ready' };

  if (msg.type === 'ready') {
    workersReady++;
    if (workersReady === NUM_WORKERS) {
      scheduleRender();
    }
    return;
  }

  if (msg.type === 'result') {
    // Find which worker sent this and mark it free
    const workerIdx = workers.indexOf(e.target as unknown as Worker);
    if (workerIdx >= 0) workerBusy[workerIdx] = false;

    const result = msg as RenderResult;

    // Discard results from a superseded render or recolor generation
    const isCurrentRender  = result.gen === renderGen;
    const isCurrentRecolor = result.gen === recolorGen;

    const shouldAnimate = !audioControls.isColorAnimActive() && !audioControls.isAudioPulseActive();

    if ((isCurrentRender || isCurrentRecolor) && offCtx && offscreen) {
      const imgData = new ImageData(
        new Uint8ClampedArray(result.imageData),
        result.tileW,
        result.tileH
      );
      offCtx.putImageData(imgData, result.tileX, result.tileY);

      if (shouldAnimate && activeTilesGen === (isCurrentRender ? renderGen : recolorGen)) {
        const tileCanvas = new OffscreenCanvas(result.tileW, result.tileH);
        tileCanvas.getContext('2d')!.putImageData(imgData, 0, 0);
        activeTiles.push({
          canvas: tileCanvas,
          x: result.tileX,
          y: result.tileY,
          startTime: performance.now()
        });
      } else {
        // Blit offscreen to visible canvas immediately
        ctx.drawImage(offscreen, 0, 0);
        drawAllOverlays();
      }
    }

    if (isCurrentRender) {
      completedTiles++;
      const progress = completedTiles / totalTiles;
      updateProgressBar(progress);

      if (completedTiles >= totalTiles) {
        isRendering = false;
        updateProgressBar(1);
        setTimeout(() => updateProgressBar(-1), 500);
      }
    }

    if (isCurrentRecolor) {
      pendingRecolorTiles--;
    }

    // Always dispatch tasks if there are any, even if this result was stale,
    // so the newly freed worker can pick up modern tasks.
    dispatchTasks();
  }
}

function screenToFractal(sx: number, sy: number): [QD, QD] {
  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const dYMin = qdFromString(view.yMin);
  const dYMax = qdFromString(view.yMax);

  const xRange = qdSub(dXMax, dXMin);
  const yRange = qdSub(dYMax, dYMin);

  // Use qdDivNum for high-precision division of the range by pixels
  const fx = qdAdd(dXMin, qdMulNum(qdDivNum(xRange, canvas.width), sx));
  const fy = qdAdd(dYMin, qdMulNum(qdDivNum(yRange, canvas.height), sy));
  return [fx, fy];
}

function redrawBaseCanvas() {
  if (offscreen) {
    ctx.drawImage(offscreen, 0, 0);
  }
}

const overlays = createOverlays({
  canvas,
  ctx,
  getView: () => view,
  screenToFractal,
  redrawBase: redrawBaseCanvas,
  scheduleRender,
});

function drawAllOverlays() {
  overlays.drawAll();
}

function redrawOverlays() {
  overlays.redraw();
}

const interactions = createInteractions({
  canvas,
  ctx,
  getView: () => view,
  screenToFractal,
  zoomAt,
  scheduleRender,
  getOffscreen: () => offscreen,
  getRedrawOverlays: () => redrawOverlays,
  getDrawAxisGrid: () => overlays.drawAxisGrid,
  getOverlayState: () => ({
    isMeasureMode: overlays.isMeasureMode,
    hasMeasurements: overlays.hasMeasurements,
    isOrbitModeActive: overlays.isOrbitModeActive,
    showOrbitAtClientPoint: overlays.showOrbitAtClientPoint,
    addMeasurementPoint: overlays.addMeasurementPoint,
    clearMeasurements: overlays.clearMeasurements,
    hasPath: overlays.hasPath,
    clearPath: overlays.clearPath,
    placePathAtClientPoint: overlays.placePathAtClientPoint,
  }),
  onCancelRenderDuringDrag: () => {
    renderGen++;
  },
  updateIterDisplay,
  resetView,
  toggleJulia,
  saveScreenshot,
  cyclePalette,
  toggleShadows,
  togglePathModeUI: (active) => {
    const btn = document.getElementById('path-mode-btn');
    if (btn) btn.classList.toggle('btn-active', active);
  },
  toggleColorAnim: () => audioControls.toggleColorAnim(),
});

const audioControls = createAudioControls({
  getView: () => view,
  scheduleRecolor,
  getPendingRecolorTiles: () => pendingRecolorTiles,
  getTileCount: () => tileWorkerMap.size,
  getCanPulseRecolor: () => !isRendering && !interactions.isDragging() && interactions.wheelTimerIsIdle(),
});

/**
 * Send recolor-only tasks to workers using their cached iteration data.
 * Colourises tiles without recomputing the fractal — used for color animation
 * and palette/speed changes when the view hasn't moved.
 */
function scheduleRecolor() {
  if (!offscreen || workersReady < NUM_WORKERS || tileWorkerMap.size === 0) return;
  recolorGen++;
  const gen = recolorGen;
  let count = 0;

  const cw = canvas.width;
  const ch = canvas.height;
  const cols = Math.ceil(cw / TILE_SIZE);
  const rows = Math.ceil(ch / TILE_SIZE);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileX = col * TILE_SIZE;
      const tileY = row * TILE_SIZE;
      const tileW = Math.min(TILE_SIZE, cw - tileX);
      const tileH = Math.min(TILE_SIZE, ch - tileY);
      const key = `${tileX},${tileY}`;
      const workerIdx = tileWorkerMap.get(key);
      if (workerIdx === undefined) continue;

      const task: RecolorTask = {
        type: 'recolor',
        taskId: col + row * cols,
        gen,
        tileX, tileY, tileW, tileH,
        palette: view.palette,
        colorSpeed: view.colorSpeed,
        colorOffset: view.colorOffset,
        shadows: view.shadows,
      };
      workers[workerIdx].postMessage(task);
      count++;
    }
  }

  pendingRecolorTiles = count;
  startTileAnimation(gen, true);
}

function zoomAt(screenX: number, screenY: number, factor: number, rerender = true) {
  const dpr = window.devicePixelRatio || 1;
  const [fx, fy] = screenToFractal(screenX * dpr, screenY * dpr);
  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const dYMin = qdFromString(view.yMin);
  const dYMax = qdFromString(view.yMax);

  const xRange = qdSub(dXMax, dXMin);
  const yRange = qdSub(dYMax, dYMin);
  const newXRange = qdMulNum(xRange, factor);
  const newYRange = qdMulNum(yRange, factor);

  // We want the point (screenX, screenY) to remain at the same fractal coordinates (fx, fy)
  // view.xMin = fx - (newXRange * (screenX / clientWidth))
  view.xMin = qdToString(qdSub(fx, qdMulNum(qdDivNum(newXRange, canvas.clientWidth), screenX)));
  view.xMax = qdToString(qdAdd(qdFromString(view.xMin), newXRange));
  view.yMin = qdToString(qdSub(fy, qdMulNum(qdDivNum(newYRange, canvas.clientHeight), screenY)));
  view.yMax = qdToString(qdAdd(qdFromString(view.yMin), newYRange));

  updateZoom();
  if (rerender) scheduleRender();
}

function updateZoom() {
  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const zoomD = qdDiv([3.5, 0, 0, 0], qdSub(dXMax, dXMin));
  const z = zoomD[0];
  view.zoom = String(z);

  // Each 10x zoom increases iterations by ~256
  // Formula: 256 + 128 * log10(zoom)
  // Clamp between 32 and 10,000 (slider limits)
  const autoIter = 256 + 256 * Math.log10(Math.max(1, z));
  const clampedIter = Math.min(10000, Math.max(32, autoIter));

  // Only update if it's a significant change to avoid jitter
  // Use a smaller threshold or just snap to steps
  const steppedIter = Math.floor(clampedIter / 32) * 32;
  if (view.maxIter !== steppedIter) {
    view.maxIter = steppedIter;
    updateIterDisplay();
  }

  const zoomEl = document.getElementById('zoom-counter');
  if (zoomEl) {
    let label: string;
    if (z < 1000) label = `${z.toFixed(1)}×`;
    else if (z < 1e6) label = `${(z / 1000).toFixed(2)}K×`;
    else if (z < 1e9) label = `${(z / 1e6).toFixed(2)}M×`;
    else if (z < 1e12) label = `${(z / 1e9).toFixed(2)}G×`;
    else label = `${z.toExponential(2)}×`;
    zoomEl.textContent = label;
  }
}

// ─── UI functions ─────────────────────────────────────────────────────────────

function updateProgressBar(progress: number) {
  const bar = document.getElementById('progress-bar') as HTMLElement;
  const container = document.getElementById('progress-container') as HTMLElement;
  if (!bar || !container) return;

  if (progress < 0) {
    container.classList.add('hidden-bar');
    return;
  }
  container.classList.remove('hidden-bar');
  bar.style.width = `${Math.round(progress * 100)}%`;
}

function updateIterDisplay() {
  const el = document.getElementById('iter-counter');
  if (el) el.textContent = `${view.maxIter}`;
  const display = document.getElementById('iter-display');
  if (display) display.textContent = `${view.maxIter}`;
  const slider = document.getElementById('iter-slider') as HTMLInputElement;
  if (slider) slider.value = String(view.maxIter);
  const quickSlider = document.getElementById('quick-iter-slider') as HTMLInputElement;
  if (quickSlider) quickSlider.value = String(view.maxIter);
}

function resetView() {
  const savedPalette = view.palette;
  const savedColorSpeed = view.colorSpeed;
  const savedFractalType = view.fractalType;
  const savedMultibrotPower = view.multibrotPower;
  view = { ...DEFAULT_VIEW };
  view.palette = savedPalette;
  view.colorSpeed = savedColorSpeed;
  view.fractalType = savedFractalType;
  view.multibrotPower = savedMultibrotPower;
  const aspect = canvas.width / canvas.height;
  const yRange = 3.5 / aspect;
  view.yMin = String(-yRange / 2);
  view.yMax = String(yRange / 2);
  updateZoom();
  updateIterDisplay();
  updatePaletteUI();
  updateFractalTypeUI();
  updateMultibrotUI();
  updateSpeedUI();
  scheduleRender();
}

function updateSpeedUI() {
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  if (speedSlider) speedSlider.value = String(view.colorSpeed);
  const quickSpeedSlider = document.getElementById('quick-speed-slider') as HTMLInputElement;
  if (quickSpeedSlider) quickSpeedSlider.value = String(view.colorSpeed);
  const speedDisplay = document.getElementById('speed-display');
  if (speedDisplay) speedDisplay.textContent = String(view.colorSpeed);
}

function toggleJulia() {
  view.isJulia = !view.isJulia;
  overlays.clearOrbit();
  const btn = document.getElementById('julia-btn');
  if (btn) {
    btn.textContent = view.isJulia ? '🌀 M' : '🌀 J';
    btn.classList.toggle('btn-active', view.isJulia);
  }
  const coordsEl = document.getElementById('julia-coords') as HTMLElement;
  if (coordsEl) coordsEl.style.display = view.isJulia ? 'inline-flex' : 'none';

  const miniContainer = document.getElementById('mini-mandelbrot-container') as HTMLElement;
  if (miniContainer) {
    miniContainer.style.display = view.isJulia ? 'block' : 'none';
    if (view.isJulia) miniMap.render();
  }

  scheduleRender();
}

function cyclePalette() {
  view.palette = (view.palette + 1) % PALETTES.length;
  updatePaletteUI();
  if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
}

function randomizePalette() {
  const newData = generateRandomPalette();
  // Update the main-thread palette slot
  PALETTES[RANDOM_PALETTE_INDEX].data = newData;
  // Broadcast updated data to every worker (transfer a copy per worker)
  workers.forEach(w => {
    const buf = newData.buffer.slice(0) as ArrayBuffer;
    w.postMessage({ type: 'updatePalette', index: RANDOM_PALETTE_INDEX, data: buf }, [buf]);
  });
  view.palette = RANDOM_PALETTE_INDEX;
  updatePaletteUI();
  if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
}

function updatePaletteUI() {
  const sel = document.getElementById('palette-select') as HTMLSelectElement;
  if (sel) sel.value = String(view.palette);
}

function updateFractalTypeUI() {
  const sel = document.getElementById('fractal-type-select') as HTMLSelectElement;
  if (sel) sel.value = String(view.fractalType);
}

function updateMultibrotUI() {
  const input = document.getElementById('multibrot-power') as HTMLInputElement | null;
  if (!input) return;
  input.value = view.multibrotPower.toFixed(2);
  input.disabled = view.fractalType !== 0;
}

const miniMap = createMiniMap({
  getView: () => view,
  scheduleRender,
});

// ─── Screenshot ───────────────────────────────────────────────────────────────

function saveScreenshot() {
  const link = document.createElement('a');
  link.download = `mandelbrot-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function toggleShadows() {
  view.shadows = !view.shadows;
  const btn = document.getElementById('shadows-btn');
  if (btn) btn.classList.toggle('btn-active', view.shadows);
  const checkbox = document.getElementById('shadows-checkbox') as HTMLInputElement | null;
  if (checkbox) checkbox.checked = view.shadows;
  if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function initSettingsPanel() {
  const settingsToggle = document.getElementById('settings-toggle')!;
  const settingsPanel  = document.getElementById('settings-panel')!;

  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('panel-open');
  });
  document.getElementById('settings-close')?.addEventListener('click', () => {
    settingsPanel.classList.remove('panel-open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target as Node) &&
        e.target !== settingsToggle &&
        !settingsToggle.contains(e.target as Node)) {
      settingsPanel.classList.remove('panel-open');
    }
  });

  // Max iterations slider
  const iterSlider = document.getElementById('iter-slider') as HTMLInputElement;
  const quickIterSlider = document.getElementById('quick-iter-slider') as HTMLInputElement;
  
  iterSlider.value = String(view.maxIter);
  if (quickIterSlider) quickIterSlider.value = String(view.maxIter);

  const handleIterInput = (val: string) => {
    view.maxIter = parseInt(val);
    updateIterDisplay();
    scheduleRender();
  };

  iterSlider.addEventListener('input', () => handleIterInput(iterSlider.value));
  if (quickIterSlider) {
    quickIterSlider.addEventListener('input', () => handleIterInput(quickIterSlider.value));
  }

  // Palette select
  const paletteSelect = document.getElementById('palette-select') as HTMLSelectElement;
  paletteSelect.addEventListener('change', () => {
    view.palette = parseInt(paletteSelect.value);
    // Recolour in place if iteration data is cached; otherwise full re-render
    if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
  });

  // Fractal type select
  const fractalTypeSelect = document.getElementById('fractal-type-select') as HTMLSelectElement;
  if (fractalTypeSelect) {
    fractalTypeSelect.value = String(view.fractalType);
    fractalTypeSelect.addEventListener('change', () => {
      view.fractalType = parseInt(fractalTypeSelect.value);
      updateMultibrotUI();
      overlays.clearOrbit();
      if (view.isJulia) miniMap.render();
      scheduleRender();
    });
  }

  const multibrotInput = document.getElementById('multibrot-power') as HTMLInputElement | null;
  if (multibrotInput) {
    updateMultibrotUI();
    multibrotInput.addEventListener('input', () => {
      const parsed = Number.parseFloat(multibrotInput.value);
      if (!Number.isFinite(parsed)) return;
      view.multibrotPower = Math.min(500, Math.max(-16, parsed));
      if (view.isJulia) miniMap.render();
      if (view.fractalType === 0) {
        overlays.clearOrbit();
        scheduleRender();
      }
    });
    multibrotInput.addEventListener('change', () => updateMultibrotUI());
  }


  // Color speed slider
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  const quickSpeedSlider = document.getElementById('quick-speed-slider') as HTMLInputElement;

  if (speedSlider) speedSlider.value = String(view.colorSpeed);
  if (quickSpeedSlider) quickSpeedSlider.value = String(view.colorSpeed);

  const handleSpeedInput = (val: string) => {
    view.colorSpeed = parseFloat(val);
    updateSpeedUI();
    if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
  };

  if (speedSlider) {
    speedSlider.addEventListener('input', () => handleSpeedInput(speedSlider.value));
  }
  if (quickSpeedSlider) {
    quickSpeedSlider.addEventListener('input', () => handleSpeedInput(quickSpeedSlider.value));
  }

  audioControls.bindSettingsControls();

  // 3D Shadows checkbox
  const shadowsCheckbox = document.getElementById('shadows-checkbox') as HTMLInputElement | null;
  if (shadowsCheckbox) {
    shadowsCheckbox.checked = view.shadows;
    shadowsCheckbox.addEventListener('change', () => {
      view.shadows = shadowsCheckbox.checked;
      const btn = document.getElementById('shadows-btn');
      if (btn) btn.classList.toggle('btn-active', view.shadows);
      if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
    });
  }

  // Julia controls
  const juliaReInput = document.getElementById('julia-re') as HTMLInputElement;
  const juliaImInput = document.getElementById('julia-im') as HTMLInputElement;
  juliaReInput.value = String(view.juliaRe);
  juliaImInput.value = String(view.juliaIm);

  juliaReInput.addEventListener('input', () => {
    view.juliaRe = String(parseFloat(juliaReInput.value) || 0);
    if (view.isJulia) {
      overlays.clearOrbit();
      scheduleRender();
    }
  });
  juliaImInput.addEventListener('input', () => {
    view.juliaIm = String(parseFloat(juliaImInput.value) || 0);
    if (view.isJulia) {
      overlays.clearOrbit();
      scheduleRender();
    }
  });

  // Julia preset buttons
  document.querySelectorAll<HTMLButtonElement>('.julia-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const re = parseFloat(btn.dataset.re ?? '0');
      const im = parseFloat(btn.dataset.im ?? '0');
      view.juliaRe = String(re);
      view.juliaIm = String(im);
      juliaReInput.value = String(re);
      juliaImInput.value = String(im);
      overlays.clearOrbit();
      if (!view.isJulia) toggleJulia();
      else scheduleRender();
    });
  });
}

// ─── Toolbar button wiring ────────────────────────────────────────────────────

function initToolbar() {
  document.getElementById('orbit-btn')?.addEventListener('click', overlays.toggleOrbitMode);
  document.getElementById('grid-btn')?.addEventListener('click', overlays.toggleAxisGrid);
  document.getElementById('reset-btn')?.addEventListener('click', resetView);
  document.getElementById('julia-btn')?.addEventListener('click', toggleJulia);
  document.getElementById('screenshot-btn')?.addEventListener('click', saveScreenshot);
  document.getElementById('color-anim-btn')?.addEventListener('click', audioControls.toggleColorAnim);
  document.getElementById('audio-visualizer-btn')?.addEventListener('click', audioControls.toggleAudioPulse);
  document.getElementById('shadows-btn')?.addEventListener('click', toggleShadows);
  document.getElementById('random-palette-btn')?.addEventListener('click', randomizePalette);
  document.getElementById('measure-btn')?.addEventListener('click', overlays.toggleMeasureMode);

  // Bookmarks
  document.getElementById('bookmark-btn')?.addEventListener('click', bookmarks.saveBookmark);
  bookmarks.renderBookmarks();
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────

const bookmarks = createBookmarks({
  getView: () => view,
  onApplyBookmark: (bm) => {
    view.xMin = String(bm.xMin);
    view.xMax = String(bm.xMax);
    view.yMin = String(bm.yMin);
    view.yMax = String(bm.yMax);
    view.maxIter = bm.maxIter;
    view.palette = bm.palette;
    view.isJulia = bm.isJulia;
    view.juliaRe = bm.juliaRe;
    view.juliaIm = bm.juliaIm;
    view.fractalType = bm.fractalType ?? DEFAULT_VIEW.fractalType;
    view.multibrotPower = bm.multibrotPower ?? DEFAULT_VIEW.multibrotPower;
    updateZoom();
    updateIterDisplay();
    updatePaletteUI();
    updateFractalTypeUI();
    updateMultibrotUI();
    scheduleRender();
  },
});

// ─── Help modal ───────────────────────────────────────────────────────────────

function initHelp() {
  const btn   = document.getElementById('help-btn');
  const modal = document.getElementById('help-modal');
  const close = document.getElementById('help-close');
  btn?.addEventListener('click',  () => modal?.classList.remove('hidden'));
  close?.addEventListener('click', () => modal?.classList.add('hidden'));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

// ─── Initialise ───────────────────────────────────────────────────────────────

async function init() {
  resizeCanvas();
  updateZoom();
  updateIterDisplay();

  initSettingsPanel();
  initToolbar();
  initHelp();
  audioControls.updateAudioSensitivityUI();
  audioControls.updateAudioPulseUI();

  // Resolve WASM URL relative to base URL (works for GitHub Pages sub-path)
  const base = import.meta.env.BASE_URL;
  const wasmUrl = `${base}mandelbrot.wasm`;

  createWorkerPool(wasmUrl);
  // scheduleRender is called once all workers are ready (in handleWorkerMessage)
}

init();
document.getElementById('path-mode-btn')?.addEventListener('click', interactions.togglePathMode);

window.addEventListener('beforeunload', () => {
  audioControls.stop();
});

