/**
 * Turbo Mandelbrot Explorer — Main Application
 *
 * Orchestrates rendering, UI state, worker pool, and interactions.
 */

import './style.css';
import type {Bookmark, PrecisionTier, RecolorTask, RenderResult, RenderTask, ViewState} from './types';
import {generateRandomPalette, PALETTES, RANDOM_PALETTE_INDEX} from './colorPalettes';
import {createAudioVisualizer} from './audioVisualizer';
import {type QD, qdAdd, qdDiv, qdDivNum, qdFromString, qdHi, qdMul, qdMulNum, qdSub, qdToNumber, qdToString,} from './qd';

// ─── Worker pool ──────────────────────────────────────────────────────────────

const NUM_WORKERS = Math.max(2, Math.min(8, navigator.hardwareConcurrency ?? 4));
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
  palette: 0,
  colorSpeed: 0.8,
  colorOffset: 0.35,
  isJulia: false,
  juliaRe: '-0.7269',
  juliaIm: '0.1889',
  zoom: '1',
  orbitTrapMode: 0,
  shadows: false,
  fractalType: 0,
};

let view: ViewState = { ...DEFAULT_VIEW };
let renderGen = 0;          // incremented on each render to cancel stale results
let recolorGen = 0;         // incremented on each recolor request to cancel stale results
let pendingTiles = 0;
let completedTiles = 0;
let totalTiles = 0;
let isRendering = false;
let colorAnimRaf = 0;
let colorAnimActive = false;

const audioVisualizer = createAudioVisualizer();
const AUDIO_RECOLOR_INTERVAL_MS = 33;
const AUDIO_OFFSET_STEP = 0.0012;

let audioPulseRaf = 0;
let audioPulseActive = false;
let audioSensitivity = 1.4;
let lastAudioRecolorAt = 0;

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
  if (colorAnimActive || audioPulseActive) return;
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
  if (isDragging || wheelTimer !== null) return;

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
      drawPath();
      drawMeasurements();
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
        orbitTrapMode: view.orbitTrapMode,
        shadows: view.shadows,
        fractalType: view.fractalType,
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

    const shouldAnimate = !colorAnimActive && !audioPulseActive;

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
        drawPath();
        drawMeasurements();
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


function placePathAtClientPoint(clientX: number, clientY: number) {
  if (!pathDrawingMode) return;
  if (view.isJulia) return;

  const dpr = window.devicePixelRatio || 1;
  // Convert screen coordinates to fractal coordinates
  const [fx, fy] = screenToFractal(clientX * dpr, clientY * dpr);

  // Better: store in fractal space
  const start = { re: fx[0], im: fy[0] };
  const end = { re: -0.5, im: 0 };

  pathPoints = fractalToScreenPath(start, end);
  redrawOverlays();
}

canvas.addEventListener('dblclick', (e) => {
  placePathAtClientPoint(e.clientX, e.clientY);
});

canvas.addEventListener('contextmenu', (e) => {
  if (measureMode && measurePoints.length > 0) {
    e.preventDefault();
    measurePoints = [];
    redrawOverlays();
    return;
  }
  if (pathPoints) {
    e.preventDefault();
    pathPoints = null;
    scheduleRender();
  }
});

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

// ─── Mouse / touch interactions ───────────────────────────────────────────────

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragViewXMin = '0';
let dragViewYMin = '0';
let lastTouchDist = 0;
// Snapshot of the offscreen canvas taken at drag start for instant visual pan
let panSource: OffscreenCanvas | null = null;
// Debounce timer for wheel zoom re-renders
let wheelTimer: ReturnType<typeof setTimeout> | null = null;
let pathDrawingMode = false;
let measureMode = false;
let measurePoints: { re: QD; im: QD }[] = [];
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragViewXMin = view.xMin;
  dragViewYMin = view.yMin;
  canvas.style.cursor = 'grabbing';

  // Snapshot the current canvas so we can pan it visually without re-rendering
  panSource = new OffscreenCanvas(canvas.width, canvas.height);
  const psCtx = panSource.getContext('2d') as OffscreenCanvasRenderingContext2D;
  psCtx.drawImage(canvas, 0, 0);

  // Cancel any in-progress render — we'll issue a fresh one on mouseup
  renderGen++;
});

canvas.addEventListener('mousemove', (e) => {
  if (isDragging) {
    const dpr = window.devicePixelRatio || 1;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    // Pan the snapshot visually — instant, no worker involvement
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (panSource) ctx.drawImage(panSource, Math.round(dx * dpr), Math.round(dy * dpr));

    // Keep view coordinates up to date
    const dXMin = qdFromString(view.xMin);
    const dXMax = qdFromString(view.xMax);
    const dYMin = qdFromString(view.yMin);
    const dYMax = qdFromString(view.yMax);
    const xRange = qdSub(dXMax, dXMin);
    const yRange = qdSub(dYMax, dYMin);
    const dragDXMin = qdFromString(dragViewXMin);
    const dragDYMin = qdFromString(dragViewYMin);

    // Calculate shift in fractal units: shift = (pixelDelta / clientDimension) * range
    const shiftX = qdMulNum(qdDivNum(xRange, canvas.clientWidth), dx);
    const shiftY = qdMulNum(qdDivNum(yRange, canvas.clientHeight), dy);

    const newXMin = qdSub(dragDXMin, shiftX);
    const newYMin = qdSub(dragDYMin, shiftY);
    view.xMin = qdToString(newXMin);
    view.xMax = qdToString(qdAdd(newXMin, xRange));
    view.yMin = qdToString(newYMin);
    view.yMax = qdToString(qdAdd(newYMin, yRange));
  }

  // Update Julia constant from mouse position (when in Julia preview mode)
  if (view.isJulia) {
    const juliaPreview = document.getElementById('julia-coords');
    if (juliaPreview) {
      const [fx, fy] = screenToFractal(e.clientX * devicePixelRatio, e.clientY * devicePixelRatio);
      juliaPreview.textContent = `c = ${fx[0].toFixed(4)} ${fy[0] >= 0 ? '+' : ''}${fy[0].toFixed(4)}i`;
    }
  }
});

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  panSource = null;
  canvas.style.cursor = 'crosshair';
  scheduleRender();
}

canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const moved = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
  if (measureMode && moved < 5) {
    // Treat as a measurement click — do not re-render the fractal
    isDragging = false;
    panSource = null;
    const dpr = window.devicePixelRatio || 1;
    const [fx, fy] = screenToFractal(e.clientX * dpr, e.clientY * dpr);
    measurePoints.push({ re: fx, im: fy });
    redrawOverlays();
    return;
  }
  endDrag();
});
canvas.addEventListener('mouseleave', endDrag);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Use exponential factor for smooth high-resolution trackpad scrolling
  const factor = Math.exp(e.deltaY * 0.002);

  // Update view coordinates without triggering a full re-render yet
  zoomAt(e.clientX, e.clientY, factor, false);

  // Scale the existing canvas content around the zoom point for instant feedback
  if (offscreen) {
    const dpr = window.devicePixelRatio || 1;
    const zoomX = e.clientX * dpr;
    const zoomY = e.clientY * dpr;
    const visualScale = 1 / factor;

    // Accumulate the visual scale using the current canvas rather than static offscreen
    const temp = new OffscreenCanvas(canvas.width, canvas.height);
    temp.getContext('2d')!.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(zoomX, zoomY);
    ctx.scale(visualScale, visualScale);
    ctx.translate(-zoomX, -zoomY);
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
  }

  // Debounce the actual re-render so rapid scroll events don't each start a render
  if (wheelTimer !== null) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelTimer = null;
    scheduleRender();
  }, 120);
}, { passive: false });


// Touch support
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    dragViewXMin = view.xMin;
    dragViewYMin = view.yMin;

    panSource = new OffscreenCanvas(canvas.width, canvas.height);
    const psCtx = panSource.getContext('2d') as OffscreenCanvasRenderingContext2D;
    psCtx.drawImage(canvas, 0, 0);
    renderGen++;
  } else if (e.touches.length === 2) {
    isDragging = false;

      // Snapshot the current canvas for pinch visual feedback
      panSource = new OffscreenCanvas(canvas.width, canvas.height);
      const psCtx = panSource.getContext('2d') as OffscreenCanvasRenderingContext2D;
      psCtx.drawImage(canvas, 0, 0);

    lastTouchDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 1 && isDragging) {
    const dpr = window.devicePixelRatio || 1;
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (panSource) ctx.drawImage(panSource, Math.round(dx * dpr), Math.round(dy * dpr));

    const dXMin = qdFromString(view.xMin);
    const dXMax = qdFromString(view.xMax);
    const dYMin = qdFromString(view.yMin);
    const dYMax = qdFromString(view.yMax);
    const xRange = qdSub(dXMax, dXMin);
    const yRange = qdSub(dYMax, dYMin);
    const dragDXMin = qdFromString(dragViewXMin);
    const dragDYMin = qdFromString(dragViewYMin);

    const newXMin = qdSub(dragDXMin, qdMulNum(xRange, dx / canvas.clientWidth));
    const newYMin = qdSub(dragDYMin, qdMulNum(yRange, dy / canvas.clientHeight));
    view.xMin = qdToString(newXMin);
    view.xMax = qdToString(qdAdd(newXMin, xRange));
    view.yMin = qdToString(newYMin);
    view.yMax = qdToString(qdAdd(newYMin, yRange));
  } else if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    const factor = lastTouchDist / dist;
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    zoomAt(mx, my, factor, false);

    const temp = new OffscreenCanvas(canvas.width, canvas.height);
    temp.getContext('2d')!.drawImage(canvas, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const zoomX = mx * dpr;
    const zoomY = my * dpr;
    const visualScale = 1 / factor;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(zoomX, zoomY);
    ctx.scale(visualScale, visualScale);
    ctx.translate(-zoomX, -zoomY);
    ctx.drawImage(temp, 0, 0);
    ctx.restore();

    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = null; scheduleRender(); }, 120);
    lastTouchDist = dist;
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();

  if (isDragging) {
    const touch = e.changedTouches[0];
    const moved = touch
      ? Math.hypot(touch.clientX - dragStartX, touch.clientY - dragStartY)
      : Infinity;

    if (measureMode && moved < 5) {
      // Treat a tap as a measurement point on touch devices
      isDragging = false;
      panSource = null;
      const dpr = window.devicePixelRatio || 1;
      const [fx, fy] = screenToFractal(touch.clientX * dpr, touch.clientY * dpr);
      measurePoints.push({ re: fx, im: fy });
      redrawOverlays();
      return;
    }

    if (pathDrawingMode && moved < 5) {
      const now = performance.now();
      const isDoubleTap =
        now - lastTapTime < 320 &&
        Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 24;

      lastTapTime = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;

      if (isDoubleTap) {
        isDragging = false;
        panSource = null;
        placePathAtClientPoint(touch.clientX, touch.clientY);
        return;
      }
    }

    endDrag();
  } else if (e.touches.length === 0) {
    // End of pinch
    lastTouchDist = 0;
    scheduleRender();
  }
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  if (isDragging) {
    endDrag();
  }
  lastTouchDist = 0;
}, { passive: false });

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const key = e.key.toLowerCase();
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;

  switch (key) {
    case '+':
    case '=':
      view.maxIter = Math.min(10000, Math.round(view.maxIter * 1.5));
      updateIterDisplay();
      scheduleRender();
      break;
    case '-': view.maxIter = Math.max(32, Math.round(view.maxIter / 1.5)); updateIterDisplay(); scheduleRender(); break;
    case 'r': resetView(); break;
    case 'j': toggleJulia(); break;
    case 's': saveScreenshot(); break;
    case 'p': cyclePalette(); break;
    case 'h': toggleShadows(); break;
    case 'c': toggleColorAnim(); break;
    case 'arrowleft':  zoomAt(cx * 0.6, cy, 1); break;
    case 'arrowright': zoomAt(cx * 1.4, cy, 1); break;
    case 'arrowup':    zoomAt(cx, cy * 0.6, 1); break;
    case 'arrowdown':  zoomAt(cx, cy * 1.4, 1); break;
    case 'z': zoomAt(cx, cy, 0.5); break;
    case 'x': zoomAt(cx, cy, 2.0); break;
    case 'm':
      togglePathMode();
      break;
    case 'escape':
      if (measureMode && measurePoints.length > 0) {
        measurePoints = [];
        redrawOverlays();
      }
      break;
  }
});

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
  view = { ...DEFAULT_VIEW };
  view.palette = savedPalette;
  view.colorSpeed = savedColorSpeed;
  view.fractalType = savedFractalType;
  const aspect = canvas.width / canvas.height;
  const yRange = 3.5 / aspect;
  view.yMin = String(-yRange / 2);
  view.yMax = String(yRange / 2);
  updateZoom();
  updateIterDisplay();
  updatePaletteUI();
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
    if (view.isJulia) renderMiniMandelbrot();
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


function renderMiniMandelbrot() {
  const canvas = document.getElementById('mini-mandelbrot-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  // No explicit background fill needed for black/white rendering

  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  const xMin = -2.0;
  const xMax = 0.5;
  const yMin = -1.25;
  const yMax = 1.25;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let re = xMin + (x / w) * (xMax - xMin);
      let im = yMin + (y / h) * (yMax - yMin);
      let zRe = 0, zIm = 0;
      let iter = 0;
      const maxIter = 64;
      while (zRe * zRe + zIm * zIm <= 4 && iter < maxIter) {
        let tmp = zRe * zRe - zIm * zIm + re;
        zIm = 2 * zRe * zIm + im;
        zRe = tmp;
        iter++;
      }

      const pixel = (y * w + x) * 4;
      // Black and white contrast: inside is black, outside is white
      if (iter === maxIter) {
        data[pixel] = 0;
        data[pixel + 1] = 0;
        data[pixel + 2] = 0;
        data[pixel + 3] = 255;
      } else {
        data[pixel] = 255;
        data[pixel + 1] = 255;
        data[pixel + 2] = 255;
        data[pixel + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

document.getElementById('mini-mandelbrot-canvas')?.addEventListener('click', (e) => {
  const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const w = rect.width;
  const h = rect.height;

  const re = -2.0 + (x / w) * 2.5;
  const im = -1.25 + (y / h) * 2.5;

  view.juliaRe = String(re);
  view.juliaIm = String(im);

  const reInput = document.getElementById('julia-re') as HTMLInputElement;
  const imInput = document.getElementById('julia-im') as HTMLInputElement;
  if (reInput) reInput.value = String(re.toFixed(4));
  if (imInput) imInput.value = String(im.toFixed(4));

  scheduleRender();
});

const ORBIT_TRAP_MODES = [
  {label: 'None', value: 0},
  {label: 'Celtic', value: 1},
  {label: 'Spiral', value: 2},
  {label: 'Square', value: 3},
];

function updateOrbitTrapUI() {
  const sel = document.getElementById('orbit-trap-select') as HTMLSelectElement;
  if (!sel) return;

  sel.innerHTML = ORBIT_TRAP_MODES.map(m => `
    <option value="${m.value}" ${m.value === view.orbitTrapMode ? 'selected' : ''}>
      ${m.label}
    </option>
  `).join('');
}

updateOrbitTrapUI();

// ─── Screenshot ───────────────────────────────────────────────────────────────

function saveScreenshot() {
  const link = document.createElement('a');
  link.download = `mandelbrot-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function fractalToScreenPath(start: { re: number, im: number }, end: { re: number, im: number }): {
  x: number,
  y: number
}[] {
  const dXMin = qdFromString(view.xMin);
  const dXMax = qdFromString(view.xMax);
  const dYMin = qdFromString(view.yMin);
  const dYMax = qdFromString(view.yMax);

  const xRange = qdSub(dXMax, dXMin);
  const yRange = qdSub(dYMax, dYMin);

  const w = canvas.width;
  const h = canvas.height;

  const xMinNum = qdHi(dXMin);
  const xRangeNum = qdHi(xRange);
  const yMinNum = qdHi(dYMin);
  const yRangeNum = qdHi(yRange);

  const startX = (start.re - xMinNum) / xRangeNum * w;
  const startY = (start.im - yMinNum) / yRangeNum * h;
  const endX = (end.re - xMinNum) / xRangeNum * w;
  const endY = (end.im - yMinNum) / yRangeNum * h;

  return [{x: startX, y: startY}, {x: endX, y: endY}];
}

let pathPoints: { x: number, y: number }[] | null = null;

function drawPath() {
  if (!pathPoints || view.isJulia) return;
  ctx.save();
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
  for (let i = 1; i < pathPoints.length; i++) {
    ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

// ─── Measurement mode ─────────────────────────────────────────────────────────

/**
 * Format a fractal-coordinate distance using SI prefixes so the label remains
 * readable at any zoom level (from km at low zoom down to qm at QD precision).
 */
function formatDistance(d: number): string {
  if (!isFinite(d) || d < 0) return '—';
  if (d === 0) return '0 m';

  const prefixes: [number, string][] = [
    [1e3,  'km'],
    [1,    'm' ],
    [1e-3, 'mm'],
    [1e-6, 'μm'],
    [1e-9, 'nm'],
    [1e-12,'pm'],
    [1e-15,'fm'],
    [1e-18,'am'],
    [1e-21,'zm'],
    [1e-24,'ym'],
    [1e-27,'rm'],
    [1e-30,'qm'],
  ];

  for (const [scale, unit] of prefixes) {
    if (d >= scale) {
      return `${(d / scale).toFixed(3)} ${unit}`;
    }
  }

  // Beyond standard SI prefix range — use scientific notation
  return `${d.toExponential(3)} m`;
}

function fractalToScreenPoint(re: number, im: number): { x: number; y: number } {
  const xMinNum = qdHi(qdFromString(view.xMin));
  const xMaxNum = qdHi(qdFromString(view.xMax));
  const yMinNum = qdHi(qdFromString(view.yMin));
  const yMaxNum = qdHi(qdFromString(view.yMax));
  const x = (re - xMinNum) / (xMaxNum - xMinNum) * canvas.width;
  const y = (im - yMinNum) / (yMaxNum - yMinNum) * canvas.height;
  return { x, y };
}

function drawMeasurements() {
  if (!measureMode || measurePoints.length === 0) return;

  const pts = measurePoints.map(p => fractalToScreenPoint(qdHi(p.re), qdHi(p.im)));

  ctx.save();

  // Lines between consecutive points
  if (pts.length >= 2) {
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Dots at each point
  ctx.fillStyle = '#00e5ff';
  for (const pt of pts) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Total distance label
  if (measurePoints.length >= 2) {
    let total = 0;
    for (let i = 1; i < measurePoints.length; i++) {
      const dx = qdSub(measurePoints[i].re, measurePoints[i - 1].re);
      const dy = qdSub(measurePoints[i].im, measurePoints[i - 1].im);
      total += Math.sqrt(qdToNumber(qdAdd(qdMul(dx, dx), qdMul(dy, dy))));
    }
    const label = formatDistance(total);

    const last = pts[pts.length - 1];
    const fontSize = 14;
    ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
    const tw = ctx.measureText(label).width;
    const pad = 6;
    const bx = last.x + 12;
    const by = last.y - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(bx - pad, by - fontSize, tw + pad * 2, fontSize + pad * 2);
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(label, bx, by);
  }

  ctx.restore();
}

function redrawOverlays() {
  if (offscreen) {
    ctx.drawImage(offscreen, 0, 0);
    drawPath();
    drawMeasurements();
  }
}

function toggleMeasureMode() {
  measureMode = !measureMode;
  const btn = document.getElementById('measure-btn');
  if (btn) btn.classList.toggle('btn-active', measureMode);
  if (!measureMode) {
    measurePoints = [];
    redrawOverlays();
  }
}

function toggleShadows() {
  view.shadows = !view.shadows;
  const btn = document.getElementById('shadows-btn');
  if (btn) btn.classList.toggle('btn-active', view.shadows);
  const checkbox = document.getElementById('shadows-checkbox') as HTMLInputElement | null;
  if (checkbox) checkbox.checked = view.shadows;
  if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
}

// ─── Color animation ──────────────────────────────────────────────────────────

function updateAudioSensitivityUI() {
  const slider = document.getElementById('audio-sensitivity-slider') as HTMLInputElement | null;
  const display = document.getElementById('audio-sensitivity-display');
  if (slider) slider.value = audioSensitivity.toFixed(1);
  if (display) display.textContent = audioSensitivity.toFixed(1);
}

function updateAudioPulseUI(status?: string) {
  const btn = document.getElementById('audio-visualizer-btn');
  const checkbox = document.getElementById('audio-visualizer-checkbox') as HTMLInputElement | null;
  const levelText = document.getElementById('audio-level-text');

  if (btn) {
    btn.classList.toggle('btn-active', audioPulseActive);
    btn.classList.toggle('mic-live', audioPulseActive);
  }
  if (checkbox) checkbox.checked = audioPulseActive;
  if (levelText) {
    levelText.textContent = status ?? (audioPulseActive ? 'listening...' : 'mic off');
  }
}

function runAudioPulse() {
  if (!audioPulseActive) return;

  const level = audioVisualizer.sampleLevel();
  document.documentElement.style.setProperty('--audio-level', level.toFixed(3));

  const levelText = document.getElementById('audio-level-text');
  if (levelText) levelText.textContent = `${Math.round(level * 100)}%`;

  // Keep pulse recolor off while the view is still moving/rendering to avoid mixed generations.
  const canRecolor = !isRendering && !isDragging && wheelTimer === null;
  if (canRecolor && pendingRecolorTiles === 0 && tileWorkerMap.size > 0) {
    const now = performance.now();
    if (now - lastAudioRecolorAt >= AUDIO_RECOLOR_INTERVAL_MS) {
      view.colorOffset = (view.colorOffset + AUDIO_OFFSET_STEP + level * 0.03) % 1;
      scheduleRecolor();
      lastAudioRecolorAt = now;
    }
  }

  audioPulseRaf = requestAnimationFrame(runAudioPulse);
}

async function setAudioPulseEnabled(enabled: boolean) {
  if (enabled) {
    try {
      // Only one recolor loop should run at once; pulse replaces manual color animation.
      if (colorAnimActive) {
        colorAnimActive = false;
        cancelAnimationFrame(colorAnimRaf);
        document.getElementById('color-anim-btn')?.classList.remove('btn-active');
      }
      audioVisualizer.setSensitivity(audioSensitivity);
      await audioVisualizer.start();
      audioPulseActive = true;
      updateAudioPulseUI();
      runAudioPulse();
    } catch {
      audioPulseActive = false;
      updateAudioPulseUI('mic unavailable');
      document.documentElement.style.setProperty('--audio-level', '0');
    }
    return;
  }

  audioPulseActive = false;
  cancelAnimationFrame(audioPulseRaf);
  audioVisualizer.stop();
  document.documentElement.style.setProperty('--audio-level', '0');
  updateAudioPulseUI();
}

function toggleAudioPulse() {
  void setAudioPulseEnabled(!audioPulseActive);
}

function toggleColorAnim() {
  colorAnimActive = !colorAnimActive;
  const btn = document.getElementById('color-anim-btn');
  if (btn) btn.classList.toggle('btn-active', colorAnimActive);
  if (colorAnimActive) runColorAnim();
  else cancelAnimationFrame(colorAnimRaf);
}

function runColorAnim() {
  if (!colorAnimActive) return;
  if (pendingRecolorTiles === 0) {
    view.colorOffset = (view.colorOffset + 0.005) % 1;
    // Recolour tiles in workers without recomputing the fractal
    scheduleRecolor();
  }
  colorAnimRaf = requestAnimationFrame(runColorAnim);
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
      scheduleRender();
    });
  }

  // Orbit Trap select (kept for bookmark compatibility — no UI exposed)

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

  const audioVisualizerCheckbox = document.getElementById('audio-visualizer-checkbox') as HTMLInputElement | null;
  const audioSensitivitySlider = document.getElementById('audio-sensitivity-slider') as HTMLInputElement | null;
  updateAudioSensitivityUI();
  updateAudioPulseUI();

  if (audioVisualizerCheckbox) {
    audioVisualizerCheckbox.checked = audioPulseActive;
    audioVisualizerCheckbox.addEventListener('change', () => {
      void setAudioPulseEnabled(audioVisualizerCheckbox.checked);
    });
  }

  if (audioSensitivitySlider) {
    audioSensitivitySlider.value = audioSensitivity.toFixed(1);
    audioSensitivitySlider.addEventListener('input', () => {
      audioSensitivity = parseFloat(audioSensitivitySlider.value) || 1.4;
      audioVisualizer.setSensitivity(audioSensitivity);
      updateAudioSensitivityUI();
    });
  }

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
    if (view.isJulia) scheduleRender();
  });
  juliaImInput.addEventListener('input', () => {
    view.juliaIm = String(parseFloat(juliaImInput.value) || 0);
    if (view.isJulia) scheduleRender();
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
      if (!view.isJulia) toggleJulia();
      else scheduleRender();
    });
  });
}

// ─── Toolbar button wiring ────────────────────────────────────────────────────

function initToolbar() {
  document.getElementById('reset-btn')?.addEventListener('click', resetView);
  document.getElementById('julia-btn')?.addEventListener('click', toggleJulia);
  document.getElementById('screenshot-btn')?.addEventListener('click', saveScreenshot);
  document.getElementById('color-anim-btn')?.addEventListener('click', toggleColorAnim);
  document.getElementById('audio-visualizer-btn')?.addEventListener('click', toggleAudioPulse);
  document.getElementById('shadows-btn')?.addEventListener('click', toggleShadows);
  document.getElementById('random-palette-btn')?.addEventListener('click', randomizePalette);
  document.getElementById('measure-btn')?.addEventListener('click', toggleMeasureMode);

  // Bookmarks
  document.getElementById('bookmark-btn')?.addEventListener('click', saveBookmark);
  renderBookmarks();
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────

const BUILT_IN_BOOKMARKS: Bookmark[] = [
  {
    label: '🏠 Home',
    xMin: '-2.5',
    xMax: '1.0',
    yMin: '-1.25',
    yMax: '1.25',
    maxIter: 256,
    palette: 3,
    isJulia: false,
    juliaRe: '-0.7269',
    juliaIm: '0.1889',
    orbitTrapMode: 0
  },
  {
    label: '🦐 Seahorse',
    xMin: '-0.76',
    xMax: '-0.72',
    yMin: '0.17',
    yMax: '0.21',
    maxIter: 512,
    palette: 5,
    isJulia: false,
    juliaRe: '-0.7269',
    juliaIm: '0.1889',
    orbitTrapMode: 0
  },
  {
    label: '🐘 Elephant',
    xMin: '0.24',
    xMax: '0.28',
    yMin: '-0.01',
    yMax: '0.02',
    maxIter: 512,
    palette: 1,
    isJulia: false,
    juliaRe: '-0.7269',
    juliaIm: '0.1889',
    orbitTrapMode: 0
  },
  {
    label: '🌀 Spiral',
    xMin: '-0.748',
    xMax: '-0.740',
    yMin: '0.100',
    yMax: '0.107',
    maxIter: 1024,
    palette: 4,
    isJulia: false,
    juliaRe: '-0.7269',
    juliaIm: '0.1889',
    orbitTrapMode: 0
  },
  {
    label: '⚡ Julia Orbit',
    xMin: '-1.5',
    xMax: '1.5',
    yMin: '-1.0',
    yMax: '1.0',
    maxIter: 256,
    palette: 1,
    isJulia: true,
    juliaRe: '-0.7269',
    juliaIm: '0.1889',
    orbitTrapMode: 0
  },
];

function loadBookmarks(): Bookmark[] {
  try {
    const stored = localStorage.getItem('mandelbrot-bookmarks');
    if (stored) return JSON.parse(stored) as Bookmark[];
  } catch { /* ignore */ }
  return [];
}

function saveBookmark() {
  const label = prompt('Bookmark name:', `Zoom ${Number(view.zoom).toExponential(2)}×`);
  if (!label) return;
  const bm: Bookmark = { label, ...view };
  const bookmarks = loadBookmarks();
  bookmarks.push(bm);
  localStorage.setItem('mandelbrot-bookmarks', JSON.stringify(bookmarks));
  renderBookmarks();
}

function applyBookmark(bm: Bookmark) {
  view.xMin = String(bm.xMin);
  view.xMax = String(bm.xMax);
  view.yMin = String(bm.yMin);
  view.yMax = String(bm.yMax);
  view.maxIter = bm.maxIter;
  view.palette = bm.palette;
  view.isJulia = bm.isJulia;
  view.juliaRe = bm.juliaRe;
  view.juliaIm = bm.juliaIm;
  view.orbitTrapMode = bm.orbitTrapMode || 0;
  updateZoom(); updateIterDisplay(); updatePaletteUI();

  const orbitTrapSelect = document.getElementById('orbit-trap-select') as HTMLSelectElement;
  if (orbitTrapSelect) orbitTrapSelect.value = String(view.orbitTrapMode);
  
  scheduleRender();
}

function renderBookmarks() {
  const container = document.getElementById('bookmark-list');
  if (!container) return;
  const custom = loadBookmarks();
  const all = [...BUILT_IN_BOOKMARKS, ...custom];

  container.innerHTML = all.map((bm, i) => `
    <div class="flex items-center gap-1">
      <button
        class="flex-1 text-left text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 truncate"
        data-bm="${i}">${bm.label}
      </button>
      ${i >= BUILT_IN_BOOKMARKS.length
        ? `<button class="text-red-400 hover:text-red-300 px-1 del-bm" data-bm="${i - BUILT_IN_BOOKMARKS.length}">×</button>`
        : ''}
    </div>
  `).join('');

  container.querySelectorAll<HTMLButtonElement>('button[data-bm]').forEach(btn => {
    if (btn.classList.contains('del-bm')) {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.bm!);
        const bms = loadBookmarks();
        bms.splice(idx, 1);
        localStorage.setItem('mandelbrot-bookmarks', JSON.stringify(bms));
        renderBookmarks();
      });
    } else {
      btn.addEventListener('click', () => {
        applyBookmark(all[parseInt(btn.dataset.bm!)]);
      });
    }
  });
}

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
  updateAudioSensitivityUI();
  updateAudioPulseUI();

  // Resolve WASM URL relative to base URL (works for GitHub Pages sub-path)
  const base = import.meta.env.BASE_URL;
  const wasmUrl = `${base}mandelbrot.wasm`;

  createWorkerPool(wasmUrl);
  // scheduleRender is called once all workers are ready (in handleWorkerMessage)
}

init();

function togglePathMode() {
  pathDrawingMode = !pathDrawingMode;
  const btn = document.getElementById('path-mode-btn');
  if (btn) btn.classList.toggle('btn-active', pathDrawingMode);
}

document.getElementById('path-mode-btn')?.addEventListener('click', togglePathMode);

window.addEventListener('beforeunload', () => {
  audioVisualizer.stop();
});

