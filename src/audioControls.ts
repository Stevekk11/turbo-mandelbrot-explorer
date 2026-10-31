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

    function updateSongUI() {
        const hasSong = audioVisualizer.hasSong();
        const isPlaying = audioVisualizer.isSongPlaying();
        const songName = audioVisualizer.getSongName();

        const playBtn = document.getElementById('song-play-btn') as HTMLButtonElement | null;
        const settingsPlayBtn = document.getElementById('settings-song-play-btn') as HTMLButtonElement | null;
        const songNameEl = document.getElementById('song-name-display');

        if (playBtn) {
            playBtn.style.display = hasSong ? 'inline-flex' : 'none';
            playBtn.classList.toggle('btn-active', isPlaying);
            playBtn.classList.toggle('mic-live', isPlaying);
            playBtn.innerHTML = isPlaying
                ? '⏸️ <span class="btn-label">Pause</span>'
                : '▶️ <span class="btn-label">Play</span>';
            playBtn.title = songName ? `${isPlaying ? 'Pause' : 'Play'} ${songName}` : 'Play/Pause song';
        }

        if (settingsPlayBtn) {
            settingsPlayBtn.disabled = !hasSong;
            settingsPlayBtn.classList.toggle('btn-active', isPlaying);
            settingsPlayBtn.textContent = isPlaying ? '⏸️ Pause Song' : '▶️ Play Song';
        }

        if (songNameEl) {
            songNameEl.textContent = songName ?? 'No song selected';
            songNameEl.title = songName ?? '';
        }
    }

    function updateAudioPulseUI(status?: string) {
        const btn = document.getElementById('audio-visualizer-btn');
        const checkbox = document.getElementById('audio-visualizer-checkbox') as HTMLInputElement | null;
        const levelText = document.getElementById('audio-level-text');
        const mode = audioVisualizer.getMode();
        const isMicActive = audioPulseActive && mode === 'mic';

        if (btn) {
            btn.classList.toggle('btn-active', audioPulseActive);
            btn.classList.toggle('mic-live', audioPulseActive);
        }
        if (checkbox) checkbox.checked = isMicActive;
        if (levelText) {
            if (status) {
                levelText.textContent = status;
            } else if (audioPulseActive) {
                levelText.textContent = mode === 'song' ? 'playing...' : 'listening...';
            } else {
                levelText.textContent = audioVisualizer.hasSong() ? 'song paused' : 'mic off';
            }
        }
        updateSongUI();
    }

    function startPulseLoop() {
        if (colorAnimActive) {
            colorAnimActive = false;
            cancelAnimationFrame(colorAnimRaf);
            document.getElementById('color-anim-btn')?.classList.remove('btn-active');
        }
        audioPulseActive = true;
        cancelAnimationFrame(audioPulseRaf);
        updateAudioPulseUI();
        runAudioPulse();
    }

    function stopPulseLoop(status?: string) {
        audioPulseActive = false;
        cancelAnimationFrame(audioPulseRaf);
        document.documentElement.style.setProperty('--audio-level', '0');
        updateAudioPulseUI(status);
    }

    audioVisualizer.onSongStateChange((playing) => {
        if (playing) {
            startPulseLoop();
        } else if (audioVisualizer.getMode() !== 'mic') {
            stopPulseLoop();
        } else {
            updateSongUI();
        }
    });

    function runAudioPulse() {
        if (!audioPulseActive) return;

        const level = audioVisualizer.sampleLevel();
        document.documentElement.style.setProperty('--audio-level', level.toFixed(3));

        const levelText = document.getElementById('audio-level-text');
        if (levelText) {
            const prefix = audioVisualizer.getMode() === 'song' ? '🎵 ' : '';
            levelText.textContent = `${prefix}${Math.round(level * 100)}%`;
        }

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
                audioVisualizer.setSensitivity(audioSensitivity);
                await audioVisualizer.start();
                startPulseLoop();
            } catch {
                audioVisualizer.stop();
                stopPulseLoop('mic unavailable');
            }
            return;
        }

        audioVisualizer.stop();
        stopPulseLoop();
    }

    function toggleAudioPulse() {
        if (audioPulseActive) {
            void setAudioPulseEnabled(false);
        } else if (audioVisualizer.hasSong()) {
            void playLoadedSong();
        } else {
            void setAudioPulseEnabled(true);
        }
    }

    async function playLoadedSong() {
        if (!audioVisualizer.hasSong()) return;
        try {
            audioVisualizer.setSensitivity(audioSensitivity);
            await audioVisualizer.playSong();
            startPulseLoop();
        } catch {
            stopPulseLoop('playback error');
        }
    }

    function toggleSongPlayback() {
        if (!audioVisualizer.hasSong()) {
            triggerSongUpload();
            return;
        }
        if (audioVisualizer.isSongPlaying()) {
            audioVisualizer.pauseSong();
            stopPulseLoop();
        } else {
            void playLoadedSong();
        }
    }

    function triggerSongUpload() {
        const fileInput = document.getElementById('audio-file-input') as HTMLInputElement | null;
        fileInput?.click();
    }

    async function handleSongFileSelected(file: File) {
        audioVisualizer.loadSong(file);
        updateSongUI();
        await playLoadedSong();
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
        const fileInput = document.getElementById('audio-file-input') as HTMLInputElement | null;
        const settingsUploadBtn = document.getElementById('settings-song-upload-btn');
        const settingsPlayBtn = document.getElementById('settings-song-play-btn');

        updateAudioSensitivityUI();
        updateAudioPulseUI();

        if (audioVisualizerCheckbox) {
            audioVisualizerCheckbox.checked = audioPulseActive && audioVisualizer.getMode() === 'mic';
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

        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (file) {
                    void handleSongFileSelected(file);
                }
                fileInput.value = '';
            });
        }

        settingsUploadBtn?.addEventListener('click', triggerSongUpload);
        settingsPlayBtn?.addEventListener('click', toggleSongPlayback);
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
        toggleSongPlayback,
        triggerSongUpload,
        updateAudioPulseUI,
        updateAudioSensitivityUI,
    };
}
