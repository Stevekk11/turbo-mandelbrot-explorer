import {generateRandomPalette, PALETTES, RANDOM_PALETTE_INDEX} from './colorPalettes';
import type {ViewState} from './types';

export function createUiControls(options: {
    defaultView: ViewState;
    getView: () => ViewState;
    setView: (view: ViewState) => void;
    canvas: HTMLCanvasElement;
    miniMap: { render: () => void };
    overlays: {
        clearOrbit: () => void;
        toggleAxisGrid: () => void;
        toggleOrbitMode: () => void;
        toggleMeasureMode: () => void;
    };
    audioControls: {
        bindSettingsControls: () => void;
        toggleAudioPulse: () => void;
        toggleColorAnim: () => void;
        updateAudioSensitivityUI: () => void;
        updateAudioPulseUI: (status?: string) => void;
    };
    bookmarks: {
        renderBookmarks: () => void;
        saveBookmark: () => void;
    };
    scheduleRender: () => void;
    scheduleRecolor: () => void;
}) {
    function updateProgressBar(progress: number) {
        const bar = document.getElementById('progress-bar') as HTMLElement | null;
        const container = document.getElementById('progress-container') as HTMLElement | null;
        if (!bar || !container) return;

        if (progress < 0) {
            container.classList.add('hidden-bar');
            return;
        }
        container.classList.remove('hidden-bar');
        bar.style.width = `${Math.round(progress * 100)}%`;
    }

    function updateIterDisplay() {
        const view = options.getView();
        const el = document.getElementById('iter-counter');
        if (el) el.textContent = `${view.maxIter}`;
        const display = document.getElementById('iter-display');
        if (display) display.textContent = `${view.maxIter}`;
        const slider = document.getElementById('iter-slider') as HTMLInputElement | null;
        if (slider) slider.value = String(view.maxIter);
        const quickSlider = document.getElementById('quick-iter-slider') as HTMLInputElement | null;
        if (quickSlider) quickSlider.value = String(view.maxIter);
    }

    function updateSpeedUI() {
        const view = options.getView();
        const speedSlider = document.getElementById('speed-slider') as HTMLInputElement | null;
        if (speedSlider) speedSlider.value = String(view.colorSpeed);
        const quickSpeedSlider = document.getElementById('quick-speed-slider') as HTMLInputElement | null;
        if (quickSpeedSlider) quickSpeedSlider.value = String(view.colorSpeed);
        const speedDisplay = document.getElementById('speed-display');
        if (speedDisplay) speedDisplay.textContent = String(view.colorSpeed);
    }

    function updatePaletteUI() {
        const sel = document.getElementById('palette-select') as HTMLSelectElement | null;
        if (sel) sel.value = String(options.getView().palette);
    }

    function updateFractalTypeUI() {
        const sel = document.getElementById('fractal-type-select') as HTMLSelectElement | null;
        if (sel) sel.value = String(options.getView().fractalType);
    }

    function updateMultibrotUI() {
        const view = options.getView();
        const input = document.getElementById('multibrot-power') as HTMLInputElement | null;
        if (!input) return;
        input.value = view.multibrotPower.toFixed(2);
        input.disabled = view.fractalType !== 0;
    }

    function toggleJulia() {
        const view = options.getView();
        view.isJulia = !view.isJulia;
        options.setView(view);
        options.overlays.clearOrbit();

        const btn = document.getElementById('julia-btn');
        if (btn) {
            btn.textContent = view.isJulia ? '🌀 M' : '🌀 J';
            btn.classList.toggle('btn-active', view.isJulia);
        }

        const coordsEl = document.getElementById('julia-coords') as HTMLElement | null;
        if (coordsEl) coordsEl.style.display = view.isJulia ? 'inline-flex' : 'none';

        const miniContainer = document.getElementById('mini-mandelbrot-container') as HTMLElement | null;
        if (miniContainer) {
            miniContainer.style.display = view.isJulia ? 'block' : 'none';
            if (view.isJulia) options.miniMap.render();
        }

        options.scheduleRender();
    }

    function resetView(updateZoom: () => void) {
        const view = options.getView();
        const nextView = {...options.defaultView};
        nextView.palette = view.palette;
        nextView.colorSpeed = view.colorSpeed;
        nextView.fractalType = view.fractalType;
        nextView.multibrotPower = view.multibrotPower;
        const aspect = options.canvas.width / options.canvas.height;
        const yRange = 3.5 / aspect;
        nextView.yMin = String(-yRange / 2);
        nextView.yMax = String(yRange / 2);
        options.setView(nextView);
        updateZoom();
        updateIterDisplay();
        updatePaletteUI();
        updateFractalTypeUI();
        updateMultibrotUI();
        updateSpeedUI();
        options.scheduleRender();
    }

    function cyclePalette(hasCachedTiles: () => boolean) {
        const view = options.getView();
        view.palette = (view.palette + 1) % PALETTES.length;
        options.setView(view);
        updatePaletteUI();
        if (hasCachedTiles()) options.scheduleRecolor();
        else options.scheduleRender();
    }

    function randomizePalette(
        broadcastPaletteUpdate: (index: number, data: Uint8ClampedArray) => void,
        hasCachedTiles: () => boolean
    ) {
        const newData = generateRandomPalette();
        PALETTES[RANDOM_PALETTE_INDEX].data = newData;
        broadcastPaletteUpdate(RANDOM_PALETTE_INDEX, newData);

        const view = options.getView();
        view.palette = RANDOM_PALETTE_INDEX;
        options.setView(view);
        updatePaletteUI();
        if (hasCachedTiles()) options.scheduleRecolor();
        else options.scheduleRender();
    }

    function toggleShadows(hasCachedTiles: () => boolean) {
        const view = options.getView();
        view.shadows = !view.shadows;
        options.setView(view);

        const btn = document.getElementById('shadows-btn');
        if (btn) btn.classList.toggle('btn-active', view.shadows);
        const checkbox = document.getElementById('shadows-checkbox') as HTMLInputElement | null;
        if (checkbox) checkbox.checked = view.shadows;
        if (hasCachedTiles()) options.scheduleRecolor();
        else options.scheduleRender();
    }

    function initSettingsPanel(deps: {
        hasCachedTiles: () => boolean;
        toggleJulia: () => void;
    }) {
        const view = options.getView();
        const settingsToggle = document.getElementById('settings-toggle');
        const settingsPanel = document.getElementById('settings-panel');
        settingsToggle?.addEventListener('click', () => settingsPanel?.classList.toggle('panel-open'));
        document.getElementById('settings-close')?.addEventListener('click', () => settingsPanel?.classList.remove('panel-open'));

        document.addEventListener('click', (e) => {
            if (
                settingsPanel &&
                settingsToggle &&
                !settingsPanel.contains(e.target as Node) &&
                e.target !== settingsToggle &&
                !settingsToggle.contains(e.target as Node)
            ) {
                settingsPanel.classList.remove('panel-open');
            }
        });

        const iterSlider = document.getElementById('iter-slider') as HTMLInputElement | null;
        const quickIterSlider = document.getElementById('quick-iter-slider') as HTMLInputElement | null;
        if (iterSlider) iterSlider.value = String(view.maxIter);
        if (quickIterSlider) quickIterSlider.value = String(view.maxIter);
        const handleIterInput = (val: string) => {
            const nextView = options.getView();
            nextView.maxIter = parseInt(val, 10);
            options.setView(nextView);
            updateIterDisplay();
            options.scheduleRender();
        };
        iterSlider?.addEventListener('input', () => handleIterInput(iterSlider.value));
        quickIterSlider?.addEventListener('input', () => handleIterInput(quickIterSlider.value));

        const paletteSelect = document.getElementById('palette-select') as HTMLSelectElement | null;
        paletteSelect?.addEventListener('change', () => {
            const nextView = options.getView();
            nextView.palette = parseInt(paletteSelect.value, 10);
            options.setView(nextView);
            if (deps.hasCachedTiles()) options.scheduleRecolor();
            else options.scheduleRender();
        });

        const fractalTypeSelect = document.getElementById('fractal-type-select') as HTMLSelectElement | null;
        if (fractalTypeSelect) {
            fractalTypeSelect.value = String(view.fractalType);
            fractalTypeSelect.addEventListener('change', () => {
                const nextView = options.getView();
                nextView.fractalType = parseInt(fractalTypeSelect.value, 10);
                options.setView(nextView);
                updateMultibrotUI();
                options.overlays.clearOrbit();
                if (nextView.isJulia) options.miniMap.render();
                options.scheduleRender();
            });
        }

        const multibrotInput = document.getElementById('multibrot-power') as HTMLInputElement | null;
        if (multibrotInput) {
            updateMultibrotUI();
            multibrotInput.addEventListener('input', () => {
                const parsed = Number.parseFloat(multibrotInput.value);
                if (!Number.isFinite(parsed)) return;
                const nextView = options.getView();
                nextView.multibrotPower = Math.min(500, Math.max(-16, parsed));
                options.setView(nextView);
                if (nextView.isJulia) options.miniMap.render();
                if (nextView.fractalType === 0) {
                    options.overlays.clearOrbit();
                    options.scheduleRender();
                }
            });
            multibrotInput.addEventListener('change', updateMultibrotUI);
        }

        const speedSlider = document.getElementById('speed-slider') as HTMLInputElement | null;
        const quickSpeedSlider = document.getElementById('quick-speed-slider') as HTMLInputElement | null;
        if (speedSlider) speedSlider.value = String(view.colorSpeed);
        if (quickSpeedSlider) quickSpeedSlider.value = String(view.colorSpeed);
        const handleSpeedInput = (val: string) => {
            const nextView = options.getView();
            nextView.colorSpeed = parseFloat(val);
            options.setView(nextView);
            updateSpeedUI();
            if (deps.hasCachedTiles()) options.scheduleRecolor();
            else options.scheduleRender();
        };
        speedSlider?.addEventListener('input', () => handleSpeedInput(speedSlider.value));
        quickSpeedSlider?.addEventListener('input', () => handleSpeedInput(quickSpeedSlider.value));

        options.audioControls.bindSettingsControls();

        const shadowsCheckbox = document.getElementById('shadows-checkbox') as HTMLInputElement | null;
        if (shadowsCheckbox) {
            shadowsCheckbox.checked = view.shadows;
            shadowsCheckbox.addEventListener('change', () => {
                const nextView = options.getView();
                nextView.shadows = shadowsCheckbox.checked;
                options.setView(nextView);
                const btn = document.getElementById('shadows-btn');
                if (btn) btn.classList.toggle('btn-active', nextView.shadows);
                if (deps.hasCachedTiles()) options.scheduleRecolor();
                else options.scheduleRender();
            });
        }

        const juliaReInput = document.getElementById('julia-re') as HTMLInputElement | null;
        const juliaImInput = document.getElementById('julia-im') as HTMLInputElement | null;
        if (juliaReInput) juliaReInput.value = String(view.juliaRe);
        if (juliaImInput) juliaImInput.value = String(view.juliaIm);

        juliaReInput?.addEventListener('input', () => {
            const nextView = options.getView();
            nextView.juliaRe = String(parseFloat(juliaReInput.value) || 0);
            options.setView(nextView);
            if (nextView.isJulia) {
                options.overlays.clearOrbit();
                options.scheduleRender();
            }
        });

        juliaImInput?.addEventListener('input', () => {
            const nextView = options.getView();
            nextView.juliaIm = String(parseFloat(juliaImInput.value) || 0);
            options.setView(nextView);
            if (nextView.isJulia) {
                options.overlays.clearOrbit();
                options.scheduleRender();
            }
        });

        document.querySelectorAll<HTMLButtonElement>('.julia-preset').forEach((btn) => {
            btn.addEventListener('click', () => {
                const re = parseFloat(btn.dataset.re ?? '0');
                const im = parseFloat(btn.dataset.im ?? '0');
                const nextView = options.getView();
                nextView.juliaRe = String(re);
                nextView.juliaIm = String(im);
                options.setView(nextView);
                if (juliaReInput) juliaReInput.value = String(re);
                if (juliaImInput) juliaImInput.value = String(im);
                options.overlays.clearOrbit();
                if (!nextView.isJulia) deps.toggleJulia();
                else options.scheduleRender();
            });
        });
    }

    function initToolbar(deps: {
        toggleJulia: () => void;
        saveScreenshot: () => void;
        toggleShadows: () => void;
        randomizePalette: () => void;
        resetView: () => void;
    }) {
        const topBar = document.getElementById('top-bar');
        const menuBtn = document.getElementById('topbar-menu-btn');
        menuBtn?.addEventListener('click', () => {
            if (!topBar) return;
            const isOpen = topBar.classList.toggle('top-bar-open');
            menuBtn.setAttribute('aria-expanded', String(isOpen));
        });
        document.getElementById('orbit-btn')?.addEventListener('click', options.overlays.toggleOrbitMode);
        document.getElementById('grid-btn')?.addEventListener('click', options.overlays.toggleAxisGrid);
        document.getElementById('reset-btn')?.addEventListener('click', deps.resetView);
        document.getElementById('julia-btn')?.addEventListener('click', deps.toggleJulia);
        document.getElementById('screenshot-btn')?.addEventListener('click', deps.saveScreenshot);
        document.getElementById('color-anim-btn')?.addEventListener('click', options.audioControls.toggleColorAnim);
        document.getElementById('audio-visualizer-btn')?.addEventListener('click', options.audioControls.toggleAudioPulse);
        document.getElementById('shadows-btn')?.addEventListener('click', deps.toggleShadows);
        document.getElementById('random-palette-btn')?.addEventListener('click', deps.randomizePalette);
        document.getElementById('measure-btn')?.addEventListener('click', options.overlays.toggleMeasureMode);
        document.getElementById('bookmark-btn')?.addEventListener('click', options.bookmarks.saveBookmark);
        options.bookmarks.renderBookmarks();
    }

    function initHelp() {
        const btn = document.getElementById('help-btn');
        const modal = document.getElementById('help-modal');
        const close = document.getElementById('help-close');
        btn?.addEventListener('click', () => modal?.classList.remove('hidden'));
        close?.addEventListener('click', () => modal?.classList.add('hidden'));
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    }

    return {
        cyclePalette,
        initHelp,
        initSettingsPanel,
        initToolbar,
        randomizePalette,
        resetView,
        toggleJulia,
        toggleShadows,
        updateFractalTypeUI,
        updateIterDisplay,
        updateMultibrotUI,
        updatePaletteUI,
        updateProgressBar,
        updateSpeedUI,
    };
}
