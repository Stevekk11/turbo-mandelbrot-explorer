import type {ViewState} from './types';
import {computeComplexPower} from './fractalMath';

const MINI_VIEWPORT_DEFAULT = {
    xMin: -2.0,
    xMax: 0.5,
    yMin: -1.25,
    yMax: 1.25,
};

export function createMiniMap(options: {
    getView: () => ViewState;
    scheduleRender: () => void;
}) {
    const miniViewport = {...MINI_VIEWPORT_DEFAULT};
    let miniDragActive = false;
    let miniDragStartX = 0;
    let miniDragStartY = 0;
    let miniDragViewport = {...MINI_VIEWPORT_DEFAULT};
    let miniPointerId: number | null = null;

    function getCanvas(): HTMLCanvasElement | null {
        return document.getElementById('mini-mandelbrot-canvas') as HTMLCanvasElement | null;
    }

    function screenToFractal(clientX: number, clientY: number): { re: number; im: number } {
        const canvas = getCanvas();
        if (!canvas) {
            return {re: 0, im: 0};
        }

        const rect = canvas.getBoundingClientRect();
        const relX = (clientX - rect.left) / rect.width;
        const relY = (clientY - rect.top) / rect.height;
        return {
            re: miniViewport.xMin + relX * (miniViewport.xMax - miniViewport.xMin),
            im: miniViewport.yMin + relY * (miniViewport.yMax - miniViewport.yMin),
        };
    }

    function updateViewportFromDrag(clientX: number, clientY: number) {
        const canvas = getCanvas();
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const xRange = miniDragViewport.xMax - miniDragViewport.xMin;
        const yRange = miniDragViewport.yMax - miniDragViewport.yMin;
        const dx = clientX - miniDragStartX;
        const dy = clientY - miniDragStartY;

        miniViewport.xMin = miniDragViewport.xMin - (dx / rect.width) * xRange;
        miniViewport.xMax = miniViewport.xMin + xRange;
        miniViewport.yMin = miniDragViewport.yMin - (dy / rect.height) * yRange;
        miniViewport.yMax = miniViewport.yMin + yRange;
    }

    function zoomAt(clientX: number, clientY: number, factor: number) {
        const canvas = getCanvas();
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const anchor = screenToFractal(clientX, clientY);
        const relX = (clientX - rect.left) / rect.width;
        const relY = (clientY - rect.top) / rect.height;
        const xRange = miniViewport.xMax - miniViewport.xMin;
        const yRange = miniViewport.yMax - miniViewport.yMin;
        const newXRange = xRange * factor;
        const newYRange = yRange * factor;

        miniViewport.xMin = anchor.re - newXRange * relX;
        miniViewport.xMax = miniViewport.xMin + newXRange;
        miniViewport.yMin = anchor.im - newYRange * relY;
        miniViewport.yMax = miniViewport.yMin + newYRange;
    }

    function render() {
        const canvas = getCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const view = options.getView();
        const w = canvas.width;
        const h = canvas.height;
        const img = ctx.createImageData(w, h);
        const data = img.data;
        const power = Number.isFinite(view.multibrotPower) ? view.multibrotPower : 2.0;
        const xRange = miniViewport.xMax - miniViewport.xMin;
        const yRange = miniViewport.yMax - miniViewport.yMin;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let re = miniViewport.xMin + (x / w) * xRange;
                let im = miniViewport.yMin + (y / h) * yRange;
                const negativeMultibrotMandelbrot = power < 0;
                let zRe = negativeMultibrotMandelbrot ? re : 0;
                let zIm = negativeMultibrotMandelbrot ? im : 0;
                let iter = 0;
                const maxIter = 64;
                while (zRe * zRe + zIm * zIm <= 4 && iter < maxIter) {
                    const [powRe, powIm] = computeComplexPower(zRe, zIm, power);
                    zRe = powRe + re;
                    zIm = powIm + im;
                    iter++;
                }

                const pixel = (y * w + x) * 4;
                const color = iter === maxIter ? 0 : 255;
                data[pixel] = color;
                data[pixel + 1] = color;
                data[pixel + 2] = color;
                data[pixel + 3] = 255;
            }
        }

        ctx.putImageData(img, 0, 0);
    }

    function bind() {
        const canvas = getCanvas();
        if (!canvas) return;

        canvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (!options.getView().isJulia) return;

            miniDragActive = true;
            miniPointerId = e.pointerId;
            miniDragStartX = e.clientX;
            miniDragStartY = e.clientY;
            miniDragViewport = {...miniViewport};
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!options.getView().isJulia || !miniDragActive || miniPointerId !== e.pointerId) return;
            e.preventDefault();
            updateViewportFromDrag(e.clientX, e.clientY);
            render();
        });

        canvas.addEventListener('pointerup', (e) => {
            if (!options.getView().isJulia || miniPointerId !== e.pointerId) return;

            const moved = Math.hypot(e.clientX - miniDragStartX, e.clientY - miniDragStartY);
            const wasClick = moved < 5;

            if (canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
            }

            miniDragActive = false;
            miniPointerId = null;

            if (!wasClick) {
                render();
                return;
            }

            const point = screenToFractal(e.clientX, e.clientY);
            const view = options.getView();
            view.juliaRe = String(point.re);
            view.juliaIm = String(point.im);

            const reInput = document.getElementById('julia-re') as HTMLInputElement | null;
            const imInput = document.getElementById('julia-im') as HTMLInputElement | null;
            if (reInput) reInput.value = String(point.re.toFixed(4));
            if (imInput) imInput.value = String(point.im.toFixed(4));

            options.scheduleRender();
        });

        canvas.addEventListener('pointercancel', () => {
            miniDragActive = false;
            miniPointerId = null;
        });

        canvas.addEventListener('wheel', (e) => {
            if (!options.getView().isJulia) return;
            e.preventDefault();
            const factor = Math.exp(e.deltaY * 0.002);
            zoomAt(e.clientX, e.clientY, factor);
            render();
        }, {passive: false});
    }

    bind();

    return {
        render,
    };
}
