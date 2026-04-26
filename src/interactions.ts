import {estimateEscapeSample} from './fractalMath';
import type {QD} from './qd';
import {qdAdd, qdDivNum, qdFromString, qdHi, qdMulNum, qdSub, qdToString} from './qd';
import type {ViewState} from './types';

export function createInteractions(options: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    getView: () => ViewState;
    screenToFractal: (sx: number, sy: number) => [QD, QD];
    zoomAt: (screenX: number, screenY: number, factor: number, rerender?: boolean) => void;
    scheduleRender: () => void;
    getOffscreen: () => OffscreenCanvas | null;
    getRedrawOverlays: () => () => void;
    getDrawAxisGrid: () => () => void;
    getOverlayState: () => {
        isMeasureMode: () => boolean;
        hasMeasurements: () => boolean;
        isOrbitModeActive: () => boolean;
        showOrbitAtClientPoint: (x: number, y: number) => void;
        addMeasurementPoint: (point: { re: QD; im: QD }) => void;
        clearMeasurements: () => void;
        hasPath: () => boolean;
        clearPath: () => void;
        placePathAtClientPoint: (x: number, y: number) => void;
    };
    onCancelRenderDuringDrag: () => void;
    updateIterDisplay: () => void;
    resetView: () => void;
    toggleJulia: () => void;
    saveScreenshot: () => void;
    cyclePalette: () => void;
    toggleShadows: () => void;
    togglePathModeUI: (active: boolean) => void;
    toggleColorAnim: () => void;
}) {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragViewXMin = '0';
    let dragViewYMin = '0';
    let lastTouchDist = 0;
    let panSource: OffscreenCanvas | null = null;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    let pathDrawingMode = false;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    function updateHoverInfo(clientX: number, clientY: number) {
        const dpr = window.devicePixelRatio || 1;
        const [fx, fy] = options.screenToFractal(clientX * dpr, clientY * dpr);
        const view = options.getView();

        const hoverIterEl = document.getElementById('hover-iter');
        if (hoverIterEl) {
            const res = estimateEscapeSample(
                qdHi(fx),
                qdHi(fy),
                view.maxIter,
                view.fractalType,
                Number(view.juliaRe),
                Number(view.juliaIm),
                view.isJulia,
                view.multibrotPower
            );
            hoverIterEl.textContent = `⟳ ${res.inside ? '∞' : res.escapeIter}`;
        }

        if (view.isJulia) {
            const juliaPreview = document.getElementById('julia-coords');
            if (juliaPreview) {
                juliaPreview.textContent = `c = ${qdHi(fx).toFixed(4)} ${qdHi(fy) >= 0 ? '+' : ''}${qdHi(fy).toFixed(4)}i`;
            }
        }
    }

    function startDrag(clientX: number, clientY: number) {
        const view = options.getView();
        isDragging = true;
        dragStartX = clientX;
        dragStartY = clientY;
        dragViewXMin = view.xMin;
        dragViewYMin = view.yMin;
        options.canvas.style.cursor = 'grabbing';

        panSource = new OffscreenCanvas(options.canvas.width, options.canvas.height);
        const psCtx = panSource.getContext('2d') as OffscreenCanvasRenderingContext2D;
        psCtx.drawImage(options.canvas, 0, 0);
        options.onCancelRenderDuringDrag();
    }

    function updateDrag(clientX: number, clientY: number, touchMode: boolean) {
        const dpr = window.devicePixelRatio || 1;
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        const view = options.getView();

        options.ctx.clearRect(0, 0, options.canvas.width, options.canvas.height);
        if (panSource) options.ctx.drawImage(panSource, Math.round(dx * dpr), Math.round(dy * dpr));

        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const dYMin = qdFromString(view.yMin);
        const dYMax = qdFromString(view.yMax);
        const xRange = qdSub(dXMax, dXMin);
        const yRange = qdSub(dYMax, dYMin);
        const dragDXMin = qdFromString(dragViewXMin);
        const dragDYMin = qdFromString(dragViewYMin);

        const newXMin = touchMode
            ? qdSub(dragDXMin, qdMulNum(xRange, dx / options.canvas.clientWidth))
            : qdSub(dragDXMin, qdMulNum(qdDivNum(xRange, options.canvas.clientWidth), dx));
        const newYMin = touchMode
            ? qdSub(dragDYMin, qdMulNum(yRange, dy / options.canvas.clientHeight))
            : qdSub(dragDYMin, qdMulNum(qdDivNum(yRange, options.canvas.clientHeight), dy));

        view.xMin = qdToString(newXMin);
        view.xMax = qdToString(qdAdd(newXMin, xRange));
        view.yMin = qdToString(newYMin);
        view.yMax = qdToString(qdAdd(newYMin, yRange));

        options.getDrawAxisGrid()();
    }

    function endDrag() {
        if (!isDragging) return;
        isDragging = false;
        panSource = null;
        options.canvas.style.cursor = 'crosshair';
        options.scheduleRender();
    }

    function scheduleWheelRender() {
        if (wheelTimer !== null) clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
            wheelTimer = null;
            options.scheduleRender();
        }, 120);
    }

    function renderVisualZoom(clientX: number, clientY: number, factor: number) {
        const offscreen = options.getOffscreen();
        if (!offscreen) return;

        const temp = new OffscreenCanvas(options.canvas.width, options.canvas.height);
        temp.getContext('2d')!.drawImage(options.canvas, 0, 0);

        const dpr = window.devicePixelRatio || 1;
        const zoomX = clientX * dpr;
        const zoomY = clientY * dpr;
        const visualScale = 1 / factor;
        options.ctx.clearRect(0, 0, options.canvas.width, options.canvas.height);
        options.ctx.save();
        options.ctx.translate(zoomX, zoomY);
        options.ctx.scale(visualScale, visualScale);
        options.ctx.translate(-zoomX, -zoomY);
        options.ctx.drawImage(temp, 0, 0);
        options.ctx.restore();
        options.getDrawAxisGrid()();
    }

    function bindCanvasEvents() {
        const canvas = options.canvas;

        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            startDrag(e.clientX, e.clientY);
        });

        canvas.addEventListener('mousemove', (e) => {
            if (isDragging) updateDrag(e.clientX, e.clientY, false);
            updateHoverInfo(e.clientX, e.clientY);
        });

        canvas.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            const overlays = options.getOverlayState();
            const moved = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
            if (overlays.isMeasureMode() && moved < 5) {
                isDragging = false;
                panSource = null;
                const dpr = window.devicePixelRatio || 1;
                const [fx, fy] = options.screenToFractal(e.clientX * dpr, e.clientY * dpr);
                overlays.addMeasurementPoint({re: fx, im: fy});
                return;
            }

            if (overlays.isOrbitModeActive() && !pathDrawingMode && moved < 5) {
                isDragging = false;
                panSource = null;
                options.canvas.style.cursor = 'crosshair';
                overlays.showOrbitAtClientPoint(e.clientX, e.clientY);
                return;
            }

            endDrag();
        });
        canvas.addEventListener('mouseleave', endDrag);

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = Math.exp(e.deltaY * 0.002);
            options.zoomAt(e.clientX, e.clientY, factor, false);
            renderVisualZoom(e.clientX, e.clientY, factor);
            scheduleWheelRender();
        }, {passive: false});

        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (e.touches.length === 1) {
                startDrag(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                isDragging = false;
                panSource = new OffscreenCanvas(options.canvas.width, options.canvas.height);
                const psCtx = panSource.getContext('2d') as OffscreenCanvasRenderingContext2D;
                psCtx.drawImage(options.canvas, 0, 0);
                lastTouchDist = Math.hypot(
                    e.touches[1].clientX - e.touches[0].clientX,
                    e.touches[1].clientY - e.touches[0].clientY
                );
            }
        }, {passive: false});

        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1 && isDragging) {
                updateDrag(e.touches[0].clientX, e.touches[0].clientY, true);
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[1].clientX - e.touches[0].clientX,
                    e.touches[1].clientY - e.touches[0].clientY
                );
                const factor = lastTouchDist / dist;
                const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                options.zoomAt(mx, my, factor, false);
                renderVisualZoom(mx, my, factor);
                scheduleWheelRender();
                lastTouchDist = dist;
            }
        }, {passive: false});

        canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            const overlays = options.getOverlayState();

            if (isDragging) {
                const touch = e.changedTouches[0];
                const moved = touch
                    ? Math.hypot(touch.clientX - dragStartX, touch.clientY - dragStartY)
                    : Infinity;

                if (overlays.isMeasureMode() && moved < 5) {
                    isDragging = false;
                    panSource = null;
                    const dpr = window.devicePixelRatio || 1;
                    const [fx, fy] = options.screenToFractal(touch.clientX * dpr, touch.clientY * dpr);
                    overlays.addMeasurementPoint({re: fx, im: fy});
                    return;
                }

                if (overlays.isOrbitModeActive() && !pathDrawingMode && moved < 5) {
                    isDragging = false;
                    panSource = null;
                    overlays.showOrbitAtClientPoint(touch.clientX, touch.clientY);
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
                        if (overlays.hasPath()) overlays.clearPath();
                        else overlays.placePathAtClientPoint(touch.clientX, touch.clientY);
                        return;
                    }
                }

                endDrag();
            } else if (e.touches.length === 0) {
                lastTouchDist = 0;
                options.scheduleRender();
            }
        }, {passive: false});

        canvas.addEventListener('touchcancel', () => {
            if (isDragging) endDrag();
            lastTouchDist = 0;
        }, {passive: false});

        canvas.addEventListener('dblclick', (e) => {
            if (!pathDrawingMode) return;
            options.getOverlayState().placePathAtClientPoint(e.clientX, e.clientY);
        });

        canvas.addEventListener('contextmenu', (e) => {
            const overlays = options.getOverlayState();
            if (overlays.isMeasureMode() && overlays.hasMeasurements()) {
                e.preventDefault();
                overlays.clearMeasurements();
                return;
            }
            if (overlays.hasPath()) {
                e.preventDefault();
                overlays.clearPath();
                options.scheduleRender();
            }
        });
    }

    function bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
            const key = e.key.toLowerCase();
            const cx = options.canvas.clientWidth / 2;
            const cy = options.canvas.clientHeight / 2;
            const overlays = options.getOverlayState();
            const view = options.getView();

            switch (key) {
                case '+':
                case '=':
                    view.maxIter = Math.min(10000, Math.round(view.maxIter * 1.5));
                    options.updateIterDisplay();
                    options.scheduleRender();
                    break;
                case '-':
                    view.maxIter = Math.max(32, Math.round(view.maxIter / 1.5));
                    options.updateIterDisplay();
                    options.scheduleRender();
                    break;
                case 'r':
                    options.resetView();
                    break;
                case 'j':
                    options.toggleJulia();
                    break;
                case 's':
                    options.saveScreenshot();
                    break;
                case 'p':
                    options.cyclePalette();
                    break;
                case 'h':
                    options.toggleShadows();
                    break;
                case 'c':
                    options.toggleColorAnim();
                    break;
                case 'arrowleft':
                    options.zoomAt(cx * 0.6, cy, 1);
                    break;
                case 'arrowright':
                    options.zoomAt(cx * 1.4, cy, 1);
                    break;
                case 'arrowup':
                    options.zoomAt(cx, cy * 0.6, 1);
                    break;
                case 'arrowdown':
                    options.zoomAt(cx, cy * 1.4, 1);
                    break;
                case 'z':
                    options.zoomAt(cx, cy, 0.5);
                    break;
                case 'x':
                    options.zoomAt(cx, cy, 2.0);
                    break;
                case 'm':
                    pathDrawingMode = !pathDrawingMode;
                    options.togglePathModeUI(pathDrawingMode);
                    break;
                case 'escape':
                    if (overlays.isMeasureMode() && overlays.hasMeasurements()) {
                        overlays.clearMeasurements();
                    } else if (overlays.hasPath()) {
                        overlays.clearPath();
                    }
                    break;
            }
        });
    }

    bindCanvasEvents();
    bindKeyboardShortcuts();

    return {
        isDragging: () => isDragging,
        isPathDrawingMode: () => pathDrawingMode,
        togglePathMode() {
            pathDrawingMode = !pathDrawingMode;
            options.togglePathModeUI(pathDrawingMode);
        },
        wheelTimerIsIdle: () => wheelTimer === null,
    };
}
