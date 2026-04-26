import {createAudioVisualizer} from './audioVisualizer';
import type {ViewState} from './types';

const AUDIO_RECOLOR_INTERVAL_MS = 33;
const AUDIO_OFFSET_STEP = 0.0012;

export function createAudioControls(options: {
    getView: () => ViewState;
    scheduleRecolor: () => void;
    getPendingRecolorTiles: () => number;
    getTileCount: () => number;
    getCanPulseRecolor: () => boolean;
}) {
    const audioVisualizer = createAudioVisualizer();
    let colorAnimRaf = 0;
    let colorAnimActive = false;
    let audioPulseRaf = 0;
    let audioPulseActive = false;
    let audioSensitivity = 1.4;
    let lastAudioRecolorAt = 0;

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

        if (
            options.getCanPulseRecolor() &&
            options.getPendingRecolorTiles() === 0 &&
            options.getTileCount() > 0
        ) {
            const now = performance.now();
            if (now - lastAudioRecolorAt >= AUDIO_RECOLOR_INTERVAL_MS) {
                const view = options.getView();
                view.colorOffset = (view.colorOffset + AUDIO_OFFSET_STEP + level * 0.03) % 1;
                options.scheduleRecolor();
                lastAudioRecolorAt = now;
            }
        }

        audioPulseRaf = requestAnimationFrame(runAudioPulse);
    }

    async function setAudioPulseEnabled(enabled: boolean) {
        if (enabled) {
            try {
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

    function runColorAnim() {
        if (!colorAnimActive) return;
        if (options.getPendingRecolorTiles() === 0) {
            const view = options.getView();
            view.colorOffset = (view.colorOffset + 0.005) % 1;
            options.scheduleRecolor();
        }
        colorAnimRaf = requestAnimationFrame(runColorAnim);
    }

    function toggleColorAnim() {
        colorAnimActive = !colorAnimActive;
        const btn = document.getElementById('color-anim-btn');
        if (btn) btn.classList.toggle('btn-active', colorAnimActive);
        if (colorAnimActive) runColorAnim();
        else cancelAnimationFrame(colorAnimRaf);
    }

    function bindSettingsControls() {
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
    }

    function stop() {
        cancelAnimationFrame(colorAnimRaf);
        cancelAnimationFrame(audioPulseRaf);
        audioVisualizer.stop();
    }

    return {
        bindSettingsControls,
        isAudioPulseActive: () => audioPulseActive,
        isColorAnimActive: () => colorAnimActive,
        stop,
        toggleAudioPulse,
        toggleColorAnim,
        updateAudioPulseUI,
        updateAudioSensitivityUI,
    };
}
