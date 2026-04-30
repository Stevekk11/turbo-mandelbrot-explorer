import type {QD} from './qd';
import {qdAdd, qdDiv, qdFromString, qdHi, qdMul, qdSub, qdToNumber} from './qd';
import type {ViewState} from './types';
import {buildEscapeGuidedPath, computeOrbitPoints} from './fractalMath';

interface QDPoint {
    re: QD;
    im: QD;
}

export function createOverlays(options: {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    getView: () => ViewState;
    screenToFractal: (sx: number, sy: number) => [QD, QD];
    redrawBase: () => void;
    scheduleRender: () => void;
}) {
    let pathPoints: { re: number; im: number }[] | null = null;
    let orbitPoints: { re: number; im: number }[] | null = null;
    let axisGridVisible = false;
    let measureMode = false;
    let measurePoints: QDPoint[] = [];
    let orbitModeActive = false;

    function fractalToScreenPoint(re: number, im: number): { x: number; y: number } {
        const view = options.getView();
        const xMinNum = qdHi(qdFromString(view.xMin));
        const xMaxNum = qdHi(qdFromString(view.xMax));
        const yMinNum = qdHi(qdFromString(view.yMin));
        const yMaxNum = qdHi(qdFromString(view.yMax));
        const x = (re - xMinNum) / (xMaxNum - xMinNum) * options.canvas.width;
        const y = (im - yMinNum) / (yMaxNum - yMinNum) * options.canvas.height;
        return {x, y};
    }

    function fractalToScreenPointQD(re: QD, im: QD): { x: number; y: number } {
        const view = options.getView();
        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const dYMin = qdFromString(view.yMin);
        const dYMax = qdFromString(view.yMax);
        const xRange = qdSub(dXMax, dXMin);
        const yRange = qdSub(dYMax, dYMin);
        const dx = qdSub(re, dXMin);
        const dy = qdSub(im, dYMin);
        const xNorm = qdToNumber(qdDiv(dx, xRange));
        const yNorm = qdToNumber(qdDiv(dy, yRange));
        const x = (Number.isFinite(xNorm) ? xNorm : 0) * options.canvas.width;
        const y = (Number.isFinite(yNorm) ? yNorm : 0) * options.canvas.height;
        return {x, y};
    }

    function drawPath() {
        const view = options.getView();
        if (!pathPoints || view.isJulia) return;
        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const dYMin = qdFromString(view.yMin);
        const dYMax = qdFromString(view.yMax);
        const xRange = qdSub(dXMax, dXMin);
        const yRange = qdSub(dYMax, dYMin);
        const w = options.canvas.width;
        const h = options.canvas.height;
        const xMinNum = qdHi(dXMin);
        const xRangeNum = qdHi(xRange);
        const yMinNum = qdHi(dYMin);
        const yRangeNum = qdHi(yRange);
        const screenPath = pathPoints.map((p) => ({
            x: (p.re - xMinNum) / xRangeNum * w,
            y: (p.im - yMinNum) / yRangeNum * h,
        }));
        options.ctx.save();
        options.ctx.strokeStyle = 'red';
        options.ctx.lineWidth = 10;
        options.ctx.beginPath();
        options.ctx.moveTo(screenPath[0].x, screenPath[0].y);
        for (let i = 1; i < screenPath.length; i++) {
            options.ctx.lineTo(screenPath[i].x, screenPath[i].y);
        }
        options.ctx.stroke();
        options.ctx.restore();
    }

    function drawOrbit() {
        if (!orbitPoints) return;

        const screenOrbit = orbitPoints.map((p) => fractalToScreenPoint(p.re, p.im));
        if (screenOrbit.length === 0) return;

        options.ctx.save();
        options.ctx.strokeStyle = '#ff2e2e';
        options.ctx.fillStyle = '#ff2e2e';
        options.ctx.lineWidth = 3;
        options.ctx.beginPath();
        options.ctx.moveTo(screenOrbit[0].x, screenOrbit[0].y);
        for (let i = 1; i < screenOrbit.length; i++) {
            options.ctx.lineTo(screenOrbit[i].x, screenOrbit[i].y);
        }
        options.ctx.stroke();

        for (const pt of screenOrbit) {
            options.ctx.beginPath();
            options.ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
            options.ctx.fill();
        }
        options.ctx.restore();
    }

    function formatAxisLabel(value: number, step: number): string {
        const absValue = Math.abs(value);
        const absStep = Math.abs(step);

        if (!Number.isFinite(value)) return '';
        if (absValue !== 0 && (absValue >= 1e6 || absValue < 1e-4)) {
            return value.toExponential(2);
        }

        const decimals = absStep >= 1 ? 0 : Math.min(8, Math.max(0, Math.ceil(-Math.log10(absStep)) + 1));
        return value.toFixed(decimals);
    }

    function niceTickStep(range: number, targetTicks: number): number {
        const safeRange = Math.abs(range);
        if (!Number.isFinite(safeRange) || safeRange === 0) return 1;

        const rawStep = safeRange / Math.max(1, targetTicks);
        const exponent = Math.floor(Math.log10(rawStep));
        const fraction = rawStep / Math.pow(10, exponent);

        let niceFraction = 1;
        if (fraction < 1.5) niceFraction = 1;
        else if (fraction < 3) niceFraction = 2;
        else if (fraction < 7) niceFraction = 5;
        else niceFraction = 10;

        return niceFraction * Math.pow(10, exponent);
    }

    function drawAxisGrid() {
        if (!axisGridVisible) return;

        const view = options.getView();
        const dXMin = qdFromString(view.xMin);
        const dXMax = qdFromString(view.xMax);
        const dYMin = qdFromString(view.yMin);
        const dYMax = qdFromString(view.yMax);

        const xMin = qdHi(dXMin);
        const xMax = qdHi(dXMax);
        const yMin = qdHi(dYMin);
        const yMax = qdHi(dYMax);
        const xRange = xMax - xMin;
        const yRange = yMax - yMin;
        if (!Number.isFinite(xRange) || !Number.isFinite(yRange) || xRange <= 0 || yRange <= 0) return;

        const w = options.canvas.width;
        const h = options.canvas.height;
        const xScale = w / xRange;
        const yScale = h / yRange;
        const gridStepX = niceTickStep(xRange, Math.max(4, Math.round(w / 130)));
        const gridStepY = niceTickStep(yRange, Math.max(4, Math.round(h / 130)));
        const labelFontSize = Math.max(10, Math.min(13, Math.round(w / 120)));
        const labelPad = 4;
        const xLabelBottomMargin = Math.max(48, Math.round(h * 0.1));

        const toScreenX = (x: number) => (x - xMin) * xScale;
        const toScreenY = (y: number) => (y - yMin) * yScale;

        options.ctx.save();
        options.ctx.font = `600 ${labelFontSize}px ui-monospace, monospace`;
        options.ctx.textBaseline = 'middle';
        options.ctx.textAlign = 'center';

        const visibleXStart = Math.ceil(xMin / gridStepX) * gridStepX;
        const visibleYStart = Math.ceil(yMin / gridStepY) * gridStepY;

        // Zamrznutí / infinite loop prevence při obřím zoomu vlivem ztráty přesnosti float64
        if (visibleXStart + gridStepX === visibleXStart || visibleYStart + gridStepY === visibleYStart) {
            options.ctx.restore();
            return;
        }

        for (let x = visibleXStart; x <= xMax + gridStepX * 0.5; x += gridStepX) {
            const sx = toScreenX(x);
            if (sx < -1 || sx > w + 1) continue;

            options.ctx.strokeStyle = Math.abs(x) < gridStepX * 0.5 ? 'rgba(255,255,255,0.50)' : 'rgba(255,0,85,0.50)';
            options.ctx.lineWidth = Math.abs(x) < gridStepX * 0.5 ? 3 : 2.1;
            options.ctx.beginPath();
            options.ctx.moveTo(sx, 0);
            options.ctx.lineTo(sx, h);
            options.ctx.stroke();

            const label = formatAxisLabel(x, gridStepX);
            if (label) {
                const ly = Math.max(labelFontSize + 8, h - xLabelBottomMargin);
                options.ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
                const metrics = options.ctx.measureText(label);
                options.ctx.fillRect(sx - metrics.width / 2 - labelPad, ly - labelFontSize / 2 - labelPad, metrics.width + labelPad * 2, labelFontSize + labelPad * 2);
                options.ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
                options.ctx.fillText(label, sx, ly);
            }
        }

        options.ctx.textBaseline = 'alphabetic';
        options.ctx.textAlign = 'left';

        for (let y = visibleYStart; y <= yMax + gridStepY * 0.5; y += gridStepY) {
            const sy = toScreenY(y);
            if (sy < -1 || sy > h + 1) continue;

            options.ctx.strokeStyle = Math.abs(y) < gridStepY * 0.5 ? 'rgba(255,255,255,0.50)' : 'rgba(255, 0, 85, 0.50)';
            options.ctx.lineWidth = Math.abs(y) < gridStepY * 0.5 ? 2.1 : 1.4;
            options.ctx.beginPath();
            options.ctx.moveTo(0, sy);
            options.ctx.lineTo(w, sy);
            options.ctx.stroke();

            const label = formatAxisLabel(y, gridStepY);
            if (label) {
                const lx = 8;
                const ly = sy - 2;
                const metrics = options.ctx.measureText(label);
                options.ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
                options.ctx.fillRect(lx - labelPad, ly - labelFontSize, metrics.width + labelPad * 2, labelFontSize + labelPad * 2);
                options.ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
                options.ctx.fillText(label, lx, ly);
            }
        }

        const zeroX = toScreenX(0);
        const zeroY = toScreenY(0);
        if (zeroX >= 0 && zeroX <= w) {
            options.ctx.strokeStyle = 'rgba(255,255,255,0.75)';
            options.ctx.lineWidth = 2.8;
            options.ctx.beginPath();
            options.ctx.moveTo(zeroX, 0);
            options.ctx.lineTo(zeroX, h);
            options.ctx.stroke();
        }
        if (zeroY >= 0 && zeroY <= h) {
            options.ctx.strokeStyle = 'rgba(255,255,255,0.75)';
            options.ctx.lineWidth = 2.8;
            options.ctx.beginPath();
            options.ctx.moveTo(0, zeroY);
            options.ctx.lineTo(w, zeroY);
            options.ctx.stroke();
        }

        options.ctx.restore();
    }

    function formatDistance(d: number): string {
        if (!isFinite(d) || d < 0) return '—';
        if (d === 0) return '0 m';
        const prefixes: [number, string][] = [
            [1e3, 'km'],
            [1, 'm'],
            [1e-3, 'mm'],
            [1e-6, 'μm'],
            [1e-9, 'nm'],
            [1e-12, 'pm'],
            [1e-15, 'fm'],
            [1e-18, 'am'],
            [1e-21, 'zm'],
            [1e-24, 'ym'],
            [1e-27, 'rm'],
            [1e-30, 'qm'],
        ];

        for (const [scale, unit] of prefixes) {
            if (d >= scale) {
                return `${(d / scale).toFixed(3)} ${unit}`;
            }
        }

        return `${d.toExponential(3)} m`;
    }

    function drawMeasurements() {
        if (!measureMode || measurePoints.length === 0) return;

        const pts = measurePoints.map((p) => fractalToScreenPointQD(p.re, p.im));

        options.ctx.save();

        if (pts.length >= 2) {
            options.ctx.strokeStyle = '#00e5ff';
            options.ctx.lineWidth = 2;
            options.ctx.setLineDash([6, 3]);
            options.ctx.beginPath();
            options.ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) options.ctx.lineTo(pts[i].x, pts[i].y);
            options.ctx.stroke();
            options.ctx.setLineDash([]);
        }

        options.ctx.fillStyle = '#00e5ff';
        for (const pt of pts) {
            options.ctx.beginPath();
            options.ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
            options.ctx.fill();
        }

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
            options.ctx.font = `bold ${fontSize}px ui-monospace, monospace`;
            const tw = options.ctx.measureText(label).width;
            const pad = 6;
            const bx = last.x + 12;
            const by = last.y - 8;
            options.ctx.fillStyle = 'rgba(0,0,0,0.75)';
            options.ctx.fillRect(bx - pad, by - fontSize, tw + pad * 2, fontSize + pad * 2);
            options.ctx.fillStyle = '#00e5ff';
            options.ctx.fillText(label, bx, by);
        }

        options.ctx.restore();
    }

    function drawAll() {
        drawAxisGrid();
        drawPath();
        drawOrbit();
        drawMeasurements();
    }

    function redraw() {
        options.redrawBase();
        drawAll();
    }

    function toggleAxisGrid() {
        axisGridVisible = !axisGridVisible;
        const btn = document.getElementById('grid-btn');
        if (btn) btn.classList.toggle('btn-active', axisGridVisible);
        redraw();
    }

    function toggleMeasureMode() {
        measureMode = !measureMode;
        const btn = document.getElementById('measure-btn');
        if (btn) btn.classList.toggle('btn-active', measureMode);
        if (!measureMode) {
            measurePoints = [];
            redraw();
        }
    }

    function toggleOrbitMode() {
        orbitModeActive = !orbitModeActive;
        const btn = document.getElementById('orbit-btn');
        if (btn) btn.classList.toggle('btn-active', orbitModeActive);
        if (!orbitModeActive) {
            orbitPoints = null;
            redraw();
        }
    }

    return {
        addMeasurementPoint(point: QDPoint) {
            measurePoints.push(point);
            redraw();
        },
        clearMeasurements() {
            measurePoints = [];
            redraw();
        },
        clearOrbit() {
            orbitPoints = null;
            redraw();
        },
        clearPath() {
            pathPoints = null;
            redraw();
        },
        drawAll,
        drawAxisGrid,
        hasMeasurements: () => measurePoints.length > 0,
        hasPath: () => pathPoints !== null,
        isMeasureMode: () => measureMode,
        isOrbitModeActive: () => orbitModeActive,
        placePathAtClientPoint(clientX: number, clientY: number) {
            if (options.getView().isJulia) return;
            const dpr = window.devicePixelRatio || 1;
            const [fx, fy] = options.screenToFractal(clientX * dpr, clientY * dpr);
            const start = {re: fx[0], im: fy[0]};
            const end = {re: -0.5, im: 0};

            pathPoints = buildEscapeGuidedPath(start, end, {
                view: options.getView(),
                canvasWidth: options.canvas.width,
                canvasHeight: options.canvas.height,
            });
            redraw();
        },
        redraw,
        showOrbitAtClientPoint(clientX: number, clientY: number) {
            const dpr = window.devicePixelRatio || 1;
            const [fx, fy] = options.screenToFractal(clientX * dpr, clientY * dpr);
            orbitPoints = computeOrbitPoints({re: fx[0], im: fy[0]}, options.getView());
            redraw();
        },
        toggleAxisGrid,
        toggleMeasureMode,
        toggleOrbitMode,
    };
}
