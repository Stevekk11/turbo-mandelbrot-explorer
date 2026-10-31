export type AudioSourceMode = 'mic' | 'song' | null;

export interface AudioVisualizerController {
    startMic(): Promise<void>;

    stopMic(): void;

    loadSong(file: File): void;

    playSong(): Promise<void>;

    pauseSong(): void;

    stop(): void;

    hasSong(): boolean;

    isSongPlaying(): boolean;

    isMicActive(): boolean;

    getSongName(): string | null;

    getSongDuration(): number;

    getSongCurrentTime(): number;

    seekSong(seconds: number): void;

    setVolume(value: number): void;

    getVolume(): number;

    getMode(): AudioSourceMode;

    onSongStateChange(cb: (playing: boolean) => void): void;

    onSongTimeUpdate(cb: (currentTime: number, duration: number) => void): void;

    sampleLevel(): number;

    setSensitivity(value: number): void;

    getSensitivity(): number;

    isActive(): boolean;
}

const DEFAULT_SENSITIVITY = 1.4;
const DEFAULT_VOLUME = 0.8;

export function createAudioVisualizer(): AudioVisualizerController {
    let audioContext: AudioContext | null = null;
    let mediaStream: MediaStream | null = null;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let audioEl: HTMLAudioElement | null = null;
    let songSource: MediaElementAudioSourceNode | null = null;
    let songGainNode: GainNode | null = null;
    let songObjectUrl: string | null = null;
    let songName: string | null = null;

    let songStateListeners: Array<(playing: boolean) => void> = [];
    let songTimeListeners: Array<(currentTime: number, duration: number) => void> = [];

    let analyser: AnalyserNode | null = null;
    let freqData: Uint8Array<ArrayBuffer> | null = null;

    let smoothedLevel = 0;
    let dynamicBaseline = 0.05;
    let dynamicPeak = 0.25;
    let sensitivity = DEFAULT_SENSITIVITY;
    let volume = DEFAULT_VOLUME;
    let active = false;
    let mode: AudioSourceMode = null;

    function notifySongState(playing: boolean) {
        for (const cb of songStateListeners) {
            cb(playing);
        }
    }

    function notifySongTimeUpdate() {
        if (!audioEl) return;
        const cur = audioEl.currentTime || 0;
        const dur = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
        for (const cb of songTimeListeners) {
            cb(cur, dur);
        }
    }

    function ensureAudioElement(): HTMLAudioElement {
        if (!audioEl) {
            audioEl = new Audio();
            audioEl.preload = 'auto';
            audioEl.volume = 1.0; // AudioContext gainNode handles volume to preserve clean gain staging

            audioEl.addEventListener('ended', () => {
                if (mode === 'song') {
                    active = false;
                    mode = null;
                    smoothedLevel = 0;
                }
                notifySongState(false);
            });

            audioEl.addEventListener('pause', () => {
                if (mode === 'song') {
                    active = false;
                    mode = null;
                    smoothedLevel = 0;
                }
                notifySongState(false);
            });

            audioEl.addEventListener('play', () => {
                notifySongState(true);
            });

            audioEl.addEventListener('timeupdate', () => {
                notifySongTimeUpdate();
            });

            audioEl.addEventListener('loadedmetadata', () => {
                notifySongTimeUpdate();
            });
        }
        return audioEl;
    }

    function ensureAudioContext(): AudioContext {
        const Ctor = window.AudioContext || (window as typeof window & {
            webkitAudioContext?: typeof AudioContext
        }).webkitAudioContext;
        if (!Ctor) {
            throw new Error('Web Audio API is not supported in this browser.');
        }
        if (!audioContext) {
            audioContext = new Ctor();
        }
        return audioContext;
    }

    function ensureAnalyser(ctx: AudioContext): AnalyserNode {
        if (!analyser || !freqData) {
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.65;
            freqData = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
        }
        return analyser;
    }

    function ensureGainNode(ctx: AudioContext): GainNode {
        if (!songGainNode) {
            songGainNode = ctx.createGain();
            songGainNode.gain.setValueAtTime(volume, ctx.currentTime);
            songGainNode.connect(ctx.destination);
        }
        return songGainNode;
    }

    function stopMic() {
        if (micSource) {
            try {
                micSource.disconnect();
            } catch {
                // ignore
            }
            micSource = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        if (mode === 'mic') {
            active = false;
            mode = null;
            smoothedLevel = 0;
        }
    }

    async function startMic() {
        if (active && mode === 'mic' && audioContext && analyser) {
            if (audioContext.state === 'suspended') await audioContext.resume();
            return;
        }

        // Pause any active song playback before starting microphone
        if (audioEl && !audioEl.paused) {
            audioEl.pause();
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                noiseSuppression: true,
                echoCancellation: false,
                autoGainControl: false,
            },
            video: false,
        });

        let ctx: AudioContext;
        try {
            ctx = ensureAudioContext();
        } catch (err) {
            stream.getTracks().forEach(track => track.stop());
            throw err;
        }

        if (ctx.state === 'suspended') await ctx.resume();

        stopMic();
        const ana = ensureAnalyser(ctx);

        mediaStream = stream;
        const streamSource = ctx.createMediaStreamSource(stream);
        streamSource.connect(ana);
        micSource = streamSource;

        smoothedLevel = 0;
        dynamicBaseline = 0.05;
        dynamicPeak = 0.25;
        mode = 'mic';
        active = true;
    }

    function loadSong(file: File) {
        const el = ensureAudioElement();
        if (!el.paused) {
            el.pause();
        }
        if (songObjectUrl) {
            URL.revokeObjectURL(songObjectUrl);
        }
        songObjectUrl = URL.createObjectURL(file);
        songName = file.name;
        el.src = songObjectUrl;
        el.load();
        notifySongTimeUpdate();
    }

    async function playSong() {
        const el = ensureAudioElement();
        if (!el.src) {
            throw new Error('No song loaded.');
        }

        // Stop microphone if it was active
        stopMic();

        const ctx = ensureAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const ana = ensureAnalyser(ctx);
        const gain = ensureGainNode(ctx);

        if (!songSource) {
            songSource = ctx.createMediaElementSource(el);
            // Connect to analyser PRE-fader (full dynamic range for visualizer)
            songSource.connect(ana);
            // Connect to destination POST-fader (controllable volume for listening)
            songSource.connect(gain);
        }

        // If song ended, seek to start so replaying works seamlessly
        if (el.ended) {
            el.currentTime = 0;
        }

        smoothedLevel = 0;
        dynamicBaseline = 0.05;
        dynamicPeak = 0.25;
        mode = 'song';
        active = true;

        await el.play();
    }

    function pauseSong() {
        if (audioEl && !audioEl.paused) {
            audioEl.pause();
        }
        if (mode === 'song') {
            active = false;
            mode = null;
            smoothedLevel = 0;
        }
    }

    function seekSong(seconds: number) {
        if (!audioEl) return;
        const target = Math.max(0, Math.min(seconds, audioEl.duration || 0));
        audioEl.currentTime = target;
        notifySongTimeUpdate();
    }

    function setVolume(value: number) {
        volume = Math.max(0, Math.min(1, value));
        if (songGainNode && audioContext) {
            songGainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        }
    }

    function getVolume() {
        return volume;
    }

    function getSongDuration() {
        return audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
    }

    function getSongCurrentTime() {
        return audioEl ? audioEl.currentTime : 0;
    }

    function stop() {
        active = false;
        mode = null;
        smoothedLevel = 0;
        dynamicBaseline = 0.05;
        dynamicPeak = 0.25;
        stopMic();
        if (audioEl && !audioEl.paused) {
            audioEl.pause();
        }
    }

    function sampleLevel(): number {
        if (!active || !analyser || !freqData || !audioContext) return 0;

        analyser.getByteFrequencyData(freqData as unknown as Uint8Array<ArrayBuffer>);

        const binWidth = (audioContext.sampleRate * 0.5) / freqData.length;

        // 1) Bass range (20 Hz - 220 Hz): kick drum, 808, basslines
        const bassMin = Math.max(1, Math.floor(20 / binWidth));
        const bassMax = Math.min(freqData.length - 1, Math.ceil(220 / binWidth));
        let bassSum = 0;
        let bassCount = 0;
        for (let i = bassMin; i <= bassMax; i++) {
            bassSum += freqData[i] / 255;
            bassCount++;
        }
        const bassEnergy = bassCount > 0 ? bassSum / bassCount : 0;

        // 2) Mid/High presence (220 Hz - 3500 Hz): vocals, synths, guitars, snares
        const midMin = bassMax + 1;
        const midMax = Math.min(freqData.length - 1, Math.ceil(3500 / binWidth));
        let midSum = 0;
        let midCount = 0;
        for (let i = midMin; i <= midMax; i++) {
            midSum += freqData[i] / 255;
            midCount++;
        }
        const midEnergy = midCount > 0 ? midSum / midCount : 0;

        // Combined raw energy: 75% bass punch, 25% melodic/harmonic presence
        const rawEnergy = bassEnergy * 0.75 + midEnergy * 0.25;

        if (mode === 'mic') {
            // Adaptive noise floor for ambient mic room noise
            if (rawEnergy < dynamicBaseline) {
                dynamicBaseline = dynamicBaseline * 0.85 + rawEnergy * 0.15;
            } else {
                dynamicBaseline = dynamicBaseline * 0.992 + rawEnergy * 0.008;
            }
            const gate = Math.max(0.04, dynamicBaseline + 0.06);
            const gated = Math.max(0, rawEnergy - gate);
            const target = Math.min(1, gated * sensitivity * 2.8);
            const attack = 0.45;
            const release = 0.20;
            const coeff = target > smoothedLevel ? attack : release;
            smoothedLevel += (target - smoothedLevel) * coeff;
        } else {
            // Song mode: dynamic range expansion without artificial cutoff
            if (rawEnergy < dynamicBaseline) {
                dynamicBaseline = dynamicBaseline * 0.9 + rawEnergy * 0.1;
            } else {
                dynamicBaseline = dynamicBaseline * 0.995 + rawEnergy * 0.005;
            }

            if (rawEnergy > dynamicPeak) {
                dynamicPeak = rawEnergy;
            } else {
                dynamicPeak = Math.max(dynamicBaseline + 0.12, dynamicPeak * 0.998);
            }

            const dynamicRange = Math.max(0.12, dynamicPeak - dynamicBaseline);
            const relative = Math.max(0, (rawEnergy - dynamicBaseline) / dynamicRange);

            // Shape with slight power curve so beats pop noticeably
            const peaked = Math.pow(relative, 1.35);
            const target = Math.min(1, peaked * sensitivity);

            const attack = 0.55; // snappy response to downbeats
            const release = 0.18; // smooth musical decay
            const coeff = target > smoothedLevel ? attack : release;
            smoothedLevel += (target - smoothedLevel) * coeff;
        }

        return smoothedLevel;
    }

    function setSensitivity(value: number) {
        sensitivity = Math.min(4, Math.max(0.5, value));
    }

    function getSensitivity() {
        return sensitivity;
    }

    function isActive() {
        return active;
    }

    function hasSong() {
        return Boolean(songObjectUrl && audioEl);
    }

    function isSongPlaying() {
        return Boolean(audioEl && !audioEl.paused && !audioEl.ended);
    }

    function isMicActive() {
        return active && mode === 'mic';
    }

    function getSongName() {
        return songName;
    }

    function getMode() {
        return mode;
    }

    function onSongStateChange(cb: (playing: boolean) => void) {
        songStateListeners.push(cb);
    }

    function onSongTimeUpdate(cb: (currentTime: number, duration: number) => void) {
        songTimeListeners.push(cb);
    }

    return {
        startMic,
        stopMic,
        loadSong,
        playSong,
        pauseSong,
        stop,
        hasSong,
        isSongPlaying,
        isMicActive,
        getSongName,
        getSongDuration,
        getSongCurrentTime,
        seekSong,
        setVolume,
        getVolume,
        getMode,
        onSongStateChange,
        onSongTimeUpdate,
        sampleLevel,
        setSensitivity,
        getSensitivity,
        isActive,
    };
}
