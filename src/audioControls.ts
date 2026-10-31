import {createAudioVisualizer} from './audioVisualizer';
import type {ViewState} from './types';

const AUDIO_RECOLOR_INTERVAL_MS = 33;
const AUDIO_OFFSET_STEP = 0.0012;

function formatTime(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00';
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createAudioControls(options: {
    getView: () => ViewState;
    scheduleRecolor: () => void;
    getPendingRecolorTiles: () => number;
    resetPendingRecolorTiles?: () => void;
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
    let lastRecolorScheduledAt = 0;
    let isSeekingSong = false;

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
        const progressContainer = document.getElementById('song-progress-container');

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
            settingsPlayBtn.textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';
        }

        if (songNameEl) {
            songNameEl.textContent = songName ?? 'No song loaded';
            songNameEl.title = songName ?? '';
        }

        if (progressContainer) {
            progressContainer.style.display = hasSong ? 'block' : 'none';
        }
    }

    function updateAudioPulseUI(status?: string) {
        const micBtn = document.getElementById('audio-visualizer-btn');
        const micCheckbox = document.getElementById('audio-visualizer-checkbox') as HTMLInputElement | null;
        const levelText = document.getElementById('audio-level-text');
        const mode = audioVisualizer.getMode();
        const isMicActive = audioVisualizer.isMicActive();

        if (micBtn) {
            micBtn.classList.toggle('btn-active', isMicActive);
            micBtn.classList.toggle('mic-live', isMicActive);
        }
        if (micCheckbox) {
            micCheckbox.checked = isMicActive;
        }

        if (levelText) {
            if (status) {
                levelText.textContent = status;
            } else if (mode === 'song') {
                levelText.textContent = '🎵 song';
            } else if (isMicActive) {
                levelText.textContent = '🎤 listening...';
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
        if (!audioVisualizer.isActive()) {
            audioPulseActive = false;
            cancelAnimationFrame(audioPulseRaf);
            document.documentElement.style.setProperty('--audio-level', '0');
        }
        updateAudioPulseUI(status);
    }

    audioVisualizer.onSongStateChange((playing) => {
        if (playing) {
            startPulseLoop();
        } else if (!audioVisualizer.isMicActive()) {
            stopPulseLoop();
        } else {
            updateSongUI();
        }
    });

    audioVisualizer.onSongTimeUpdate((current, duration) => {
        if (isSeekingSong) return;
        const slider = document.getElementById('song-progress-slider') as HTMLInputElement | null;
        const timeDisplay = document.getElementById('song-time-display');

        if (slider && duration > 0) {
            slider.value = ((current / duration) * 100).toFixed(1);
        }
        if (timeDisplay) {
            timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
        }
    });

    function runAudioPulse() {
        if (!audioPulseActive && !audioVisualizer.isActive()) return;

        const level = audioVisualizer.sampleLevel();
        document.documentElement.style.setProperty('--audio-level', level.toFixed(3));

        const levelText = document.getElementById('audio-level-text');
        if (levelText) {
            const prefix = audioVisualizer.getMode() === 'song' ? '🎵 ' : '🎤 ';
            levelText.textContent = `${prefix}${Math.round(level * 100)}%`;
        }

        const now = performance.now();
        const pending = options.getPendingRecolorTiles();

        // Deadlock Watchdog: if tiles got dropped or worker generation desynced, unblock the loop
        if (pending > 0 && now - lastRecolorScheduledAt > 350) {
            options.resetPendingRecolorTiles?.();
        }

        if (
            options.getCanPulseRecolor() &&
            options.getPendingRecolorTiles() === 0 &&
            options.getTileCount() > 0
        ) {
            if (now - lastAudioRecolorAt >= AUDIO_RECOLOR_INTERVAL_MS) {
                const view = options.getView();
                view.colorOffset = (view.colorOffset + AUDIO_OFFSET_STEP + level * 0.032) % 1;
                lastRecolorScheduledAt = now;
                lastAudioRecolorAt = now;
                options.scheduleRecolor();
            }
        }

        audioPulseRaf = requestAnimationFrame(runAudioPulse);
    }

    async function setMicEnabled(enabled: boolean) {
        if (enabled) {
            try {
                audioVisualizer.setSensitivity(audioSensitivity);
                await audioVisualizer.startMic();
                startPulseLoop();
            } catch {
                audioVisualizer.stopMic();
                stopPulseLoop('mic unavailable');
            }
            return;
        }

        audioVisualizer.stopMic();
        stopPulseLoop();
    }

    function toggleAudioPulse() {
        // Toggles microphone pulse directly
        void setMicEnabled(!audioVisualizer.isMicActive());
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
            if (!audioVisualizer.isMicActive()) {
                stopPulseLoop();
            }
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
        const volumeSlider = document.getElementById('song-volume-slider') as HTMLInputElement | null;
        const volumeDisplay = document.getElementById('song-volume-display');
        const progressSlider = document.getElementById('song-progress-slider') as HTMLInputElement | null;

        updateAudioSensitivityUI();
        updateAudioPulseUI();

        if (volumeSlider) {
            volumeSlider.value = audioVisualizer.getVolume().toFixed(2);
            if (volumeDisplay) volumeDisplay.textContent = `${Math.round(audioVisualizer.getVolume() * 100)}%`;
            volumeSlider.addEventListener('input', () => {
                const val = parseFloat(volumeSlider.value) || 0;
                audioVisualizer.setVolume(val);
                if (volumeDisplay) volumeDisplay.textContent = `${Math.round(val * 100)}%`;
            });
        }

        if (progressSlider) {
            progressSlider.addEventListener('mousedown', () => {
                isSeekingSong = true;
            });
            progressSlider.addEventListener('touchstart', () => {
                isSeekingSong = true;
            }, {passive: true});

            const handleSeek = () => {
                const percent = parseFloat(progressSlider.value) || 0;
                const dur = audioVisualizer.getSongDuration();
                if (dur > 0) {
                    audioVisualizer.seekSong((percent / 100) * dur);
                }
                isSeekingSong = false;
            };

            progressSlider.addEventListener('change', handleSeek);
            progressSlider.addEventListener('mouseup', handleSeek);
            progressSlider.addEventListener('touchend', handleSeek);
        }

        if (audioVisualizerCheckbox) {
            audioVisualizerCheckbox.checked = audioVisualizer.isMicActive();
            audioVisualizerCheckbox.addEventListener('change', () => {
                void setMicEnabled(audioVisualizerCheckbox.checked);
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
        isAudioPulseActive: () => audioPulseActive || audioVisualizer.isActive(),
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
