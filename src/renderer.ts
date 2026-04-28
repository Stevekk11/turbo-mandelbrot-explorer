import type {PrecisionTier, RecolorTask, RenderResult, RenderTask, ViewState} from './types';
import type {QD} from './qd';
import {qdAdd, qdDiv, qdDivNum, qdFromString, qdHi, qdMulNum, qdSub, qdToString,} from './qd';

const NUM_WORKERS = Math.max(2, Math.min(16, navigator.hardwareConcurrency ?? 4));
const TILE_SIZE = 256;

interface PendingTask {
    task: RenderTask;
    gen: number;
}

export function createRenderer(options: {
    canvas: HTMLCanvasElement;
    getView: () => ViewState;
    onViewChange: (view: ViewState) => void;
    onDrawOverlays: () => void;
    isInteractionIdle: () => boolean;
    isAnimationPaused: () => boolean;
    onProgress: (progress: number) => void;
    onAutoIterChange: () => void;
    onZoomLabelChange: (label: string) => void;
    onPrecisionTierChange: (tier: PrecisionTier) => void;
}) {
    const ctx = options.canvas.getContext('2d')!;
    const workers: Worker[] = [];
    const workerBusy: boolean[] = Array(NUM_WORKERS).fill(false);
    const taskQueue: PendingTask[] = [];
    const tileWorkerMap = new Map<string, number>();

    let workersReady = 0;
    let renderGen = 0;
    let recolorGen = 0;
    let pendingRecolorTiles = 0;
    let completedTiles = 0;
    let totalTiles = 0;
    let isRendering = false;
    let renderSnapshot: OffscreenCanvas | null = null;
    let activeTiles: { canvas: OffscreenCanvas; x: number; y: number; startTime: number }[] = [];
    let fadeRaf = 0;
    let activeTilesGen = 0;
    let activeTilesIsRecolor = false;
    let offscreen: OffscreenCanvas | null = null;
    let offCtx: OffscreenCanvasRenderingContext2D | null = null;

    function getPrecisionTier(xRange: QD): PrecisionTier {
        const dx = Math.abs(qdHi(xRange));
        if (!Number.isFinite(dx) || dx < 1e-28) return 'qd';
        if (dx < 2e-13) return 'dd';
        return 'wasm';
    }

    function startTileAnimation(gen: number, isRecolor: boolean) {
        if (options.isAnimationPaused()) return;
        renderSnapshot = new OffscreenCanvas(options.canvas.width, options.canvas.height);
        renderSnapshot.getContext('2d')!.drawImage(options.canvas, 0, 0);
        activeTiles = [];
        activeTilesGen = gen;
        activeTilesIsRecolor = isRecolor;
        if (fadeRaf) cancelAnimationFrame(fadeRaf);
        fadeRaf = requestAnimationFrame(animateTiles);
    }

    function animateTiles() {
        const currentGen = activeTilesIsRecolor ? recolorGen : renderGen;
        if (activeTilesGen !== currentGen) return;
        if (!options.isInteractionIdle()) return;
        if (!renderSnapshot) return;

        ctx.clearRect(0, 0, options.canvas.width, options.canvas.height);
        ctx.drawImage(renderSnapshot, 0, 0);

        const now = performance.now();
        let allDone = true;

        for (const tile of activeTiles) {
            let alpha = (now - tile.startTime) / 250;
            if (alpha >= 1.0) alpha = 1.0;
            else allDone = false;

            ctx.globalAlpha = alpha;
            ctx.drawImage(tile.canvas, tile.x, tile.y);
        }
        ctx.globalAlpha = 1.0;

        const receivedAll = activeTilesIsRecolor
            ? pendingRecolorTiles === 0
            : completedTiles >= totalTiles;

        if (receivedAll && allDone) {
            if (offscreen) {
                ctx.drawImage(offscreen, 0, 0);
                options.onDrawOverlays();
            }
        } else {
            fadeRaf = requestAnimationFrame(animateTiles);
        }
    }

    function resizeCanvas() {
        const view = options.getView();
        const dpr = window.devicePixelRatio || 1;
        const w = options.canvas.clientWidth;
        const h = options.canvas.clientHeight;
        options.canvas.width = Math.floor(w * dpr);
        options.canvas.height = Math.floor(h * dpr);

        offscreen = new OffscreenCanvas(options.canvas.width, options.canvas.height);
        offCtx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;

        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const cy = qdDivNum(qdAdd(qdFromString(view.yMin), qdFromString(view.yMax)), 2);
        const xRange = qdSub(dXMax, dXMin);
        const yRange = qdDivNum(qdMulNum(xRange, options.canvas.height), options.canvas.width);
        view.yMin = qdToString(qdSub(cy, qdDivNum(yRange, 2)));
        view.yMax = qdToString(qdAdd(cy, qdDivNum(yRange, 2)));
        options.onViewChange(view);

        scheduleRender();
    }

    function screenToFractal(sx: number, sy: number): [QD, QD] {
        const view = options.getView();
        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const dYMin = qdFromString(view.yMin);
        const dYMax = qdFromString(view.yMax);
        const xRange = qdSub(dXMax, dXMin);
        const yRange = qdSub(dYMax, dYMin);
        const fx = qdAdd(dXMin, qdMulNum(qdDivNum(xRange, options.canvas.width), sx));
        const fy = qdAdd(dYMin, qdMulNum(qdDivNum(yRange, options.canvas.height), sy));
        return [fx, fy];
    }

    function updateZoom(overrideIter = true) {
        const view = options.getView();
        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const zoomD = qdDiv([3.5, 0, 0, 0], qdSub(dXMax, dXMin));
        const z = zoomD[0];
        view.zoom = String(z);
        options.onViewChange(view);

        const autoIter = 256 + 256 * Math.log10(Math.max(1, z));
        const clampedIter = Math.min(10000, Math.max(32, autoIter));
        const steppedIter = Math.floor(clampedIter / 32) * 32;
        if (overrideIter && view.maxIter !== steppedIter) {
            view.maxIter = steppedIter;
            options.onViewChange(view);
            options.onAutoIterChange();
        }

        let label: string;
        if (z < 1000) label = `${z.toFixed(1)}×`;
        else if (z < 1e6) label = `${(z / 1000).toFixed(2)}K×`;
        else if (z < 1e9) label = `${(z / 1e6).toFixed(2)}M×`;
        else if (z < 1e12) label = `${(z / 1e9).toFixed(2)}G×`;
        else label = `${z.toExponential(2)}×`;
        options.onZoomLabelChange(label);
    }

    function scheduleRender() {
        if (!offscreen || workersReady < NUM_WORKERS) return;
        const view = options.getView();
        renderGen++;
        const gen = renderGen;

        for (const worker of workers) worker.postMessage({type: 'clearCache'});

        taskQueue.length = 0;
        tileWorkerMap.clear();
        completedTiles = 0;

        const cw = options.canvas.width;
        const ch = options.canvas.height;
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
        options.onPrecisionTierChange(precisionTier);

        const refReStr = qdToString(qdDivNum(qdAdd(dXMin, dXMax), 2));
        const refImStr = qdToString(qdDivNum(qdAdd(dYMin, dYMax), 2));

        let taskId = 0;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const tileX = col * TILE_SIZE;
                const tileY = row * TILE_SIZE;
                const tileW = Math.min(TILE_SIZE, cw - tileX);
                const tileH = Math.min(TILE_SIZE, ch - tileY);
                taskQueue.push({
                    gen,
                    task: {
                        type: 'render',
                        taskId: taskId++,
                        gen,
                        tileX,
                        tileY,
                        tileW,
                        tileH,
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
                    },
                });
            }
        }

        isRendering = true;
        options.onProgress(0);
        startTileAnimation(gen, false);
        dispatchTasks();
    }

    function dispatchTasks() {
        let workerIdx = 0;
        while (workerIdx < NUM_WORKERS && taskQueue.length > 0) {
            if (!workerBusy[workerIdx]) {
                const item = taskQueue.shift()!;
                if (item.gen !== renderGen) continue;
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
            if (workersReady === NUM_WORKERS) scheduleRender();
            return;
        }

        const workerIdx = workers.indexOf(e.target as unknown as Worker);
        if (workerIdx >= 0) workerBusy[workerIdx] = false;

        const result = msg as RenderResult;
        const isCurrentRender = result.gen === renderGen;
        const isCurrentRecolor = result.gen === recolorGen;
        const shouldAnimate = !options.isAnimationPaused();

        if ((isCurrentRender || isCurrentRecolor) && offCtx && offscreen) {
            const imgData = new ImageData(new Uint8ClampedArray(result.imageData), result.tileW, result.tileH);
            offCtx.putImageData(imgData, result.tileX, result.tileY);

            if (shouldAnimate && activeTilesGen === (isCurrentRender ? renderGen : recolorGen)) {
                const tileCanvas = new OffscreenCanvas(result.tileW, result.tileH);
                tileCanvas.getContext('2d')!.putImageData(imgData, 0, 0);
                activeTiles.push({
                    canvas: tileCanvas,
                    x: result.tileX,
                    y: result.tileY,
                    startTime: performance.now(),
                });
            } else {
                ctx.drawImage(offscreen, 0, 0);
                options.onDrawOverlays();
            }
        }

        if (isCurrentRender) {
            completedTiles++;
            options.onProgress(completedTiles / totalTiles);
            if (completedTiles >= totalTiles) {
                isRendering = false;
                options.onProgress(1);
                setTimeout(() => options.onProgress(-1), 500);
            }
        }

        if (isCurrentRecolor) pendingRecolorTiles--;
        dispatchTasks();
    }

    function scheduleRecolor() {
        if (!offscreen || workersReady < NUM_WORKERS || tileWorkerMap.size === 0) return;
        const view = options.getView();
        recolorGen++;
        const gen = recolorGen;
        let count = 0;

        const cw = options.canvas.width;
        const ch = options.canvas.height;
        const cols = Math.ceil(cw / TILE_SIZE);
        const rows = Math.ceil(ch / TILE_SIZE);

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const tileX = col * TILE_SIZE;
                const tileY = row * TILE_SIZE;
                const tileW = Math.min(TILE_SIZE, cw - tileX);
                const tileH = Math.min(TILE_SIZE, ch - tileY);
                const workerIdx = tileWorkerMap.get(`${tileX},${tileY}`);
                if (workerIdx === undefined) continue;

                const task: RecolorTask = {
                    type: 'recolor',
                    taskId: col + row * cols,
                    gen,
                    tileX,
                    tileY,
                    tileW,
                    tileH,
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
        const view = options.getView();
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

        view.xMin = qdToString(qdSub(fx, qdMulNum(qdDivNum(newXRange, options.canvas.clientWidth), screenX)));
        view.xMax = qdToString(qdAdd(qdFromString(view.xMin), newXRange));
        view.yMin = qdToString(qdSub(fy, qdMulNum(qdDivNum(newYRange, options.canvas.clientHeight), screenY)));
        view.yMax = qdToString(qdAdd(qdFromString(view.yMin), newYRange));
        options.onViewChange(view);

        updateZoom();
        if (rerender) scheduleRender();
    }

    function createWorkerPool(wasmUrl: string) {
        for (let i = 0; i < NUM_WORKERS; i++) {
            const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
            worker.onmessage = handleWorkerMessage;
            worker.postMessage({type: 'init', wasmUrl});
            workers.push(worker);
        }
    }

    return {
        broadcastPaletteUpdate(index: number, data: Uint8ClampedArray) {
            workers.forEach((worker) => {
                const buf = data.buffer.slice(0) as ArrayBuffer;
                worker.postMessage({type: 'updatePalette', index, data: buf}, [buf]);
            });
        },
        cancelCurrentRender() {
            renderGen++;
        },
        createWorkerPool,
        ctx,
        getOffscreen: () => offscreen,
        isRendering: () => isRendering,
        pendingRecolorTiles: () => pendingRecolorTiles,
        resizeCanvas,
        scheduleRecolor,
        scheduleRender,
        screenToFractal,
        setBaseImage() {
            if (offscreen) ctx.drawImage(offscreen, 0, 0);
        },
        tileCount: () => tileWorkerMap.size,
        updateZoom,
        zoomAt,
    };
}
