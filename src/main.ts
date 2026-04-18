/**
 * Turbo Mandelbrot Explorer — Main Application
 *
 * Orchestrates rendering, UI state, worker pool, and interactions.
 */

import './style.css';
import type {Bookmark, RecolorTask, RenderResult, RenderTask, ViewState} from './types';
import {PALETTES} from './colorPalettes';

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
  xMin: -2.5, xMax: 1.0,
  yMin: -1.25, yMax: 1.25,
  maxIter: 1000,
  palette: 0,
  colorSpeed: 3,
  colorOffset: 0.35,
  isJulia: false,
  juliaRe: -0.7269,
  juliaIm: 0.1889,
  zoom: 1,
  orbitTrapMode: 0,
};

let view: ViewState = { ...DEFAULT_VIEW };
let renderGen = 0;          // incremented on each render to cancel stale results
let recolorGen = 0;         // incremented on each recolor request to cancel stale results
let pendingTiles = 0;
let completedTiles = 0;
let totalTiles = 0;
let isRendering = false;
let autoZoomActive = false;
let autoZoomRaf = 0;
let autoZoomFrame = 0;
let colorAnimRaf = 0;
let colorAnimActive = false;

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
  if (autoZoomActive || colorAnimActive) return;
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
    if (offscreen) ctx.drawImage(offscreen, 0, 0);
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
  const aspect = canvas.width / canvas.height;
  const cx = (view.xMin + view.xMax) / 2;
  const cy = (view.yMin + view.yMax) / 2;
  const xRange = view.xMax - view.xMin;
  const yRange = xRange / aspect;
  view.yMin = cy - yRange / 2;
  view.yMax = cy + yRange / 2;

  scheduleRender();
}

window.addEventListener('resize', () => resizeCanvas());

// ─── Tiled rendering ──────────────────────────────────────────────────────────

const TILE_SIZE = 256;

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

  const xRange = view.xMax - view.xMin;
  const yRange = view.yMax - view.yMin;

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
        xMin: view.xMin + (tileX / cw) * xRange,
        yMin: view.yMin + (tileY / ch) * yRange,
        xMax: view.xMin + ((tileX + tileW) / cw) * xRange,
        yMax: view.yMin + ((tileY + tileH) / ch) * yRange,
        maxIter: view.maxIter,
        juliaRe: view.juliaRe,
        juliaIm: view.juliaIm,
        isJulia: view.isJulia,
        palette: view.palette,
        colorSpeed: view.colorSpeed,
        colorOffset: view.colorOffset,
        orbitTrapMode: view.orbitTrapMode,
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

    const shouldAnimate = !autoZoomActive && !colorAnimActive;

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

      dispatchTasks();
    }

    if (isCurrentRecolor) {
      pendingRecolorTiles--;
    }
  }
}

// ─── Coordinate utilities ─────────────────────────────────────────────────────

function screenToFractal(sx: number, sy: number): [number, number] {
  const fx = view.xMin + (sx / canvas.width)  * (view.xMax - view.xMin);
  const fy = view.yMin + (sy / canvas.height) * (view.yMax - view.yMin);
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
      };
      workers[workerIdx].postMessage(task);
      count++;
    }
  }

  pendingRecolorTiles = count;
  startTileAnimation(gen, true);
}

function zoomAt(screenX: number, screenY: number, factor: number, rerender = true) {
  const [fx, fy] = screenToFractal(screenX * devicePixelRatio, screenY * devicePixelRatio);
  const xRange = (view.xMax - view.xMin) * factor;
  const yRange = (view.yMax - view.yMin) * factor;
  view.xMin = fx - xRange * (screenX / canvas.clientWidth);
  view.xMax = fx + xRange * (1 - screenX / canvas.clientWidth);
  view.yMin = fy - yRange * (screenY / canvas.clientHeight);
  view.yMax = fy + yRange * (1 - screenY / canvas.clientHeight);
  updateZoom();
  if (rerender) scheduleRender();
}

function updateZoom() {
  const baseRange = 3.5; // default xMax - xMin
  view.zoom = baseRange / (view.xMax - view.xMin);
  const zoomEl = document.getElementById('zoom-counter');
  if (zoomEl) {
    const z = view.zoom;
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
let dragViewXMin = 0;
let dragViewYMin = 0;
let lastTouchDist = 0;
// Snapshot of the offscreen canvas taken at drag start for instant visual pan
let panSource: OffscreenCanvas | null = null;
// Debounce timer for wheel zoom re-renders
let wheelTimer: ReturnType<typeof setTimeout> | null = null;

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
    const xRange = view.xMax - view.xMin;
    const yRange = view.yMax - view.yMin;
    view.xMin = dragViewXMin - (dx / canvas.clientWidth)  * xRange;
    view.xMax = view.xMin + xRange;
    view.yMin = dragViewYMin - (dy / canvas.clientHeight) * yRange;
    view.yMax = view.yMin + yRange;
  }

  // Update Julia constant from mouse position (when in Julia preview mode)
  if (view.isJulia) {
    const juliaPreview = document.getElementById('julia-coords');
    if (juliaPreview) {
      const [fx, fy] = screenToFractal(e.clientX * devicePixelRatio, e.clientY * devicePixelRatio);
      juliaPreview.textContent = `c = ${fx.toFixed(4)} ${fy >= 0 ? '+' : ''}${fy.toFixed(4)}i`;
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

canvas.addEventListener('mouseup', endDrag);
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

canvas.addEventListener('dblclick', (e) => {
  zoomAt(e.clientX, e.clientY, 0.35);
});

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
    panSource = null;
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

    const xRange = view.xMax - view.xMin;
    const yRange = view.yMax - view.yMin;
    view.xMin = dragViewXMin - (dx / canvas.clientWidth) * xRange;
    view.xMax = view.xMin + xRange;
    view.yMin = dragViewYMin - (dy / canvas.clientHeight) * yRange;
    view.yMax = view.yMin + yRange;
  } else if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    const factor = lastTouchDist / dist;
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    zoomAt(mx, my, factor, false);

    if (offscreen) {
      const dpr = window.devicePixelRatio || 1;
      const zoomX = mx * dpr;
      const zoomY = my * dpr;
      const visualScale = 1 / factor;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(zoomX, zoomY);
      ctx.scale(visualScale, visualScale);
      ctx.translate(-zoomX, -zoomY);
      ctx.drawImage(offscreen, 0, 0);
      ctx.restore();
    }

    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = null; scheduleRender(); }, 120);
    lastTouchDist = dist;
  }
}, { passive: false });

canvas.addEventListener('touchend', () => {
  if (isDragging) endDrag();
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const key = e.key.toLowerCase();
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;

  switch (key) {
    case '+': case '=': view.maxIter = Math.min(4096, Math.round(view.maxIter * 1.5)); updateIterDisplay(); scheduleRender(); break;
    case '-': view.maxIter = Math.max(32, Math.round(view.maxIter / 1.5)); updateIterDisplay(); scheduleRender(); break;
    case 'r': resetView(); break;
    case 'j': toggleJulia(); break;
    case 's': saveScreenshot(); break;
    case 'p': cyclePalette(); break;
    case 'a': toggleAutoZoom(); break;
    case 'c': toggleColorAnim(); break;
    case 'arrowleft':  zoomAt(cx * 0.6, cy, 1); break;
    case 'arrowright': zoomAt(cx * 1.4, cy, 1); break;
    case 'arrowup':    zoomAt(cx, cy * 0.6, 1); break;
    case 'arrowdown':  zoomAt(cx, cy * 1.4, 1); break;
    case 'z': zoomAt(cx, cy, 0.5); break;
    case 'x': zoomAt(cx, cy, 2.0); break;
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
}

function resetView() {
  view = { ...DEFAULT_VIEW };
  const aspect = canvas.width / canvas.height;
  const yRange = 3.5 / aspect;
  view.yMin = -yRange / 2;
  view.yMax = yRange / 2;
  updateZoom();
  updateIterDisplay();
  updatePaletteUI();
  scheduleRender();
}

function toggleJulia() {
  view.isJulia = !view.isJulia;
  const btn = document.getElementById('julia-btn');
  if (btn) {
    btn.textContent = view.isJulia ? '🌀 Mandelbrot' : '🌀 Julia Set';
    btn.classList.toggle('btn-active', view.isJulia);
  }
  const coordsEl = document.getElementById('julia-coords') as HTMLElement;
  if (coordsEl) coordsEl.style.display = view.isJulia ? 'inline-flex' : 'none';
  scheduleRender();
}

function cyclePalette() {
  view.palette = (view.palette + 1) % PALETTES.length;
  updatePaletteUI();
  if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
}

function updatePaletteUI() {
  const sel = document.getElementById('palette-select') as HTMLSelectElement;
  if (sel) sel.value = String(view.palette);
}

// ─── Orbit Trap Mode ──────────────────────────────────────────────────────────

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

// ─── Auto-zoom ────────────────────────────────────────────────────────────────

const AUTO_ZOOM_TARGETS: [number, number][] = [
  [-0.7269, 0.1889],   // Seahorse valley
  [-0.5555, 0.6321],   // Lightning
  [0.2549, 0.0005],    // Elephant valley
  [-1.3736, 0.0877],   // Satellite
];
let autoZoomTargetIdx = 0;

function toggleAutoZoom() {
  autoZoomActive = !autoZoomActive;
  const btn = document.getElementById('auto-zoom-btn');
  if (btn) btn.classList.toggle('btn-active', autoZoomActive);
  if (autoZoomActive) {
    autoZoomFrame = 0;
    runAutoZoom();
  } else {
    cancelAnimationFrame(autoZoomRaf);
  }
}

function runAutoZoom() {
  if (!autoZoomActive) return;
  const [tx, ty] = AUTO_ZOOM_TARGETS[autoZoomTargetIdx % AUTO_ZOOM_TARGETS.length];
  const currentCx = (view.xMin + view.xMax) / 2;
  const currentCy = (view.yMin + view.yMax) / 2;

  // Smaller per-frame step for ~60fps smoothness (equivalent to old 0.003/frame @6fps)
  const moveStep = 0.0035;
  const zoomStep = 0.0005;
  view.xMin += (tx - currentCx) * moveStep - (view.xMax - view.xMin) * zoomStep;
  view.xMax += (tx - currentCx) * moveStep + (view.xMax - view.xMin) * zoomStep;
  view.yMin += (ty - currentCy) * moveStep - (view.yMax - view.yMin) * zoomStep;
  view.yMax += (ty - currentCy) * moveStep + (view.yMax - view.yMin) * zoomStep;
  updateZoom();

  autoZoomFrame++;

  // Every 10 frames trigger a high-quality re-render; in between, scale the existing
  // render to simulate zoom — this gives smooth 60fps motion with ~6fps full renders.
  if (autoZoomFrame % 10 === 0) {
    scheduleRender();
  } else if (offscreen) {
    // Apply a tiny zoom-in scale centred on the canvas for visual continuity
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const s = 1 + zoomStep * 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
  }

  autoZoomRaf = requestAnimationFrame(runAutoZoom);
}

// ─── Color animation ──────────────────────────────────────────────────────────

function toggleColorAnim() {
  colorAnimActive = !colorAnimActive;
  const btn = document.getElementById('color-anim-btn');
  if (btn) btn.classList.toggle('btn-active', colorAnimActive);
  if (colorAnimActive) runColorAnim();
  else cancelAnimationFrame(colorAnimRaf);
}

function runColorAnim() {
  if (!colorAnimActive) return;
  view.colorOffset = (view.colorOffset + 0.002) % 1;
  // Recolour tiles in workers without recomputing the fractal
  scheduleRecolor();
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
  iterSlider.value = String(view.maxIter);
  iterSlider.addEventListener('input', () => {
    view.maxIter = parseInt(iterSlider.value);
    updateIterDisplay();
    scheduleRender();
  });

  // Palette select
  const paletteSelect = document.getElementById('palette-select') as HTMLSelectElement;
  paletteSelect.addEventListener('change', () => {
    view.palette = parseInt(paletteSelect.value);
    // Recolour in place if iteration data is cached; otherwise full re-render
    if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
  });

  // Orbit Trap select
  const orbitTrapSelect = document.getElementById('orbit-trap-select') as HTMLSelectElement;
  orbitTrapSelect.addEventListener('change', () => {
    view.orbitTrapMode = parseInt(orbitTrapSelect.value);
    scheduleRender();
  });

  // Color speed slider
  const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;
  speedSlider.value = String(view.colorSpeed);
  speedSlider.addEventListener('input', () => {
    view.colorSpeed = parseFloat(speedSlider.value);
    const disp = document.getElementById('speed-display');
    if (disp) disp.textContent = speedSlider.value;
    if (tileWorkerMap.size > 0) scheduleRecolor(); else scheduleRender();
  });

  // Julia controls
  const juliaReInput = document.getElementById('julia-re') as HTMLInputElement;
  const juliaImInput = document.getElementById('julia-im') as HTMLInputElement;
  juliaReInput.value = String(view.juliaRe);
  juliaImInput.value = String(view.juliaIm);

  juliaReInput.addEventListener('input', () => {
    view.juliaRe = parseFloat(juliaReInput.value) || 0;
    if (view.isJulia) scheduleRender();
  });
  juliaImInput.addEventListener('input', () => {
    view.juliaIm = parseFloat(juliaImInput.value) || 0;
    if (view.isJulia) scheduleRender();
  });

  // Julia preset buttons
  document.querySelectorAll<HTMLButtonElement>('.julia-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const re = parseFloat(btn.dataset.re ?? '0');
      const im = parseFloat(btn.dataset.im ?? '0');
      view.juliaRe = re;
      view.juliaIm = im;
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
  document.getElementById('auto-zoom-btn')?.addEventListener('click', toggleAutoZoom);
  document.getElementById('color-anim-btn')?.addEventListener('click', toggleColorAnim);

  // Bookmarks
  document.getElementById('bookmark-btn')?.addEventListener('click', saveBookmark);
  renderBookmarks();
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────

const BUILT_IN_BOOKMARKS: Bookmark[] = [
  {
    label: '🏠 Home',
    xMin: -2.5,
    xMax: 1.0,
    yMin: -1.25,
    yMax: 1.25,
    maxIter: 256,
    palette: 3,
    isJulia: false,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
    orbitTrapMode: 0
  },
  {
    label: '🦐 Seahorse',
    xMin: -0.76,
    xMax: -0.72,
    yMin: 0.17,
    yMax: 0.21,
    maxIter: 512,
    palette: 5,
    isJulia: false,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
    orbitTrapMode: 0
  },
  {
    label: '🐘 Elephant',
    xMin: 0.24,
    xMax: 0.28,
    yMin: -0.01,
    yMax: 0.02,
    maxIter: 512,
    palette: 1,
    isJulia: false,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
    orbitTrapMode: 0
  },
  {
    label: '🌀 Spiral',
    xMin: -0.748,
    xMax: -0.740,
    yMin: 0.100,
    yMax: 0.107,
    maxIter: 1024,
    palette: 4,
    isJulia: false,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
    orbitTrapMode: 0
  },
  {
    label: '⚡ Julia Orbit',
    xMin: -1.5,
    xMax: 1.5,
    yMin: -1.0,
    yMax: 1.0,
    maxIter: 256,
    palette: 1,
    isJulia: true,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
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
  const label = prompt('Bookmark name:', `Zoom ${view.zoom.toExponential(2)}×`);
  if (!label) return;
  const bm: Bookmark = { label, ...view };
  const bookmarks = loadBookmarks();
  bookmarks.push(bm);
  localStorage.setItem('mandelbrot-bookmarks', JSON.stringify(bookmarks));
  renderBookmarks();
}

function applyBookmark(bm: Bookmark) {
  view.xMin = bm.xMin; view.xMax = bm.xMax;
  view.yMin = bm.yMin; view.yMax = bm.yMax;
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

  // Resolve WASM URL relative to base URL (works for GitHub Pages sub-path)
  const base = import.meta.env.BASE_URL;
  const wasmUrl = `${base}mandelbrot.wasm`;

  createWorkerPool(wasmUrl);
  // scheduleRender is called once all workers are ready (in handleWorkerMessage)
}

init();
