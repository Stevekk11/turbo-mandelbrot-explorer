export type AudioSourceMode = 'mic' | 'song' | null;

export interface AudioVisualizerController {
    start(): Promise<void>;

    stop(): void;

    loadSong(file: File): void;

    playSong(): Promise<void>;

    pauseSong(): void;

    hasSong(): boolean;

    isSongPlaying(): boolean;

    getSongName(): string | null;

    getMode(): AudioSourceMode;

    onSongStateChange(cb: (playing: boolean) => void): void;

    sampleLevel(): number;

    setSensitivity(value: number): void;

    isActive(): boolean;
}

const DEFAULT_SENSITIVITY = 1.4;

export function createAudioVisualizer(): AudioVisualizerController {
    let audioContext: AudioContext | null = null;
    let mediaStream: MediaStream | null = null;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let audioEl: HTMLAudioElement | null = null;
    let songSource: MediaElementAudioSourceNode | null = null;
    let songObjectUrl: string | null = null;
    let songName: string | null = null;
    let songStateListeners: Array<(playing: boolean) => void> = [];

    let lowPass: BiquadFilterNode | null = null;
    let analyser: AnalyserNode | null = null;

    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let smoothedLevel = 0;
    let noiseFloor = 0.03;
    let sensitivity = DEFAULT_SENSITIVITY;
    let active = false;
    let mode: AudioSourceMode = null;

    function notifySongState(playing: boolean) {
        for (const cb of songStateListeners) {
            cb(playing);
        }
    }

    function ensureAudioElement(): HTMLAudioElement {
        if (!audioEl) {
            audioEl = new Audio();
            audioEl.preload = 'auto';
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

    function ensureAnalyserChain(ctx: AudioContext) {
        if (!lowPass || !analyser || !freqData) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 250;
            filter.Q.value = 1.0;

            const analyzerNode = ctx.createAnalyser();
            analyzerNode.fftSize = 1024;
            analyzerNode.smoothingTimeConstant = 0.7;

            filter.connect(analyzerNode);

            lowPass = filter;
            analyser = analyzerNode;
            freqData = new Uint8Array(analyzerNode.frequencyBinCount) as Uint8Array<ArrayBuffer>;
        }
    }

    function disconnectMic() {
        micSource?.disconnect();
        micSource = null;
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
    }

    async function start() {
        if (active && mode === 'mic' && audioContext && analyser) {
            if (audioContext.state === 'suspended') await audioContext.resume();
            return;
        }

        if (audioEl && !audioEl.paused) {
            audioEl.pause();
        }
        if (songSource && lowPass) {
            try {
                songSource.disconnect(lowPass);
            } catch {
                // ignore if not connected
            }
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

        disconnectMic();
        ensureAnalyserChain(ctx);

        mediaStream = stream;
        const streamSource = ctx.createMediaStreamSource(stream);
        streamSource.connect(lowPass!);
        micSource = streamSource;

        smoothedLevel = 0;
        noiseFloor = 0.03;
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
    }

    async function playSong() {
        const el = ensureAudioElement();
        if (!el.src) {
            throw new Error('No song loaded.');
        }

        disconnectMic();

        const ctx = ensureAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        ensureAnalyserChain(ctx);

        if (!songSource) {
            songSource = ctx.createMediaElementSource(el);
        } else {
            songSource.disconnect();
        }

        songSource.connect(lowPass!);
        songSource.connect(ctx.destination);

        smoothedLevel = 0;
        noiseFloor = 0.03;
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

    function stop() {
        active = false;
        mode = null;
        smoothedLevel = 0;
        noiseFloor = 0.03;
        disconnectMic();
        if (audioEl && !audioEl.paused) {
            audioEl.pause();
        }
    }

    function sampleLevel(): number {
        if (!active || !analyser || !freqData || !audioContext) return 0;

        analyser.getByteFrequencyData(freqData as unknown as Uint8Array<ArrayBuffer>);

        const hzPerBin = (audioContext.sampleRate * 0.5) / freqData.length;
        const minBin = Math.max(1, Math.floor(20 / hzPerBin));
        const maxBin = Math.min(freqData.length - 1, Math.ceil(200 / hzPerBin));

        let energy = 0;
        let count = 0;
        for (let i = minBin; i <= maxBin; i++) {
            energy += (freqData[i] / 255);
            count++;
        }

        const rawEnergy = count > 0 ? energy / count : 0;

        // Adaptive gate
        const floorTarget = rawEnergy < noiseFloor ? rawEnergy : noiseFloor;
        noiseFloor = noiseFloor * 0.99 + floorTarget * 0.01;

        const gated = Math.max(0, rawEnergy - (noiseFloor + 0.35));
        const normalized = Math.min(1, gated * sensitivity * 2.0);

        const attack = 0.3;
        const drop = Math.max(0, smoothedLevel - normalized);
        const release = Math.min(0.4, 0.15 + drop * 0.5);
        const coeff = normalized > smoothedLevel ? attack : release;
        smoothedLevel += (normalized - smoothedLevel) * coeff;

        return smoothedLevel;
    }

    function setSensitivity(value: number) {
        sensitivity = Math.min(4, Math.max(0.5, value));
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

    function getSongName() {
        return songName;
    }

    function getMode() {
        return mode;
    }

    function onSongStateChange(cb: (playing: boolean) => void) {
        songStateListeners.push(cb);
    }

    return {
        start,
        stop,
        loadSong,
        playSong,
        pauseSong,
        hasSong,
        isSongPlaying,
        getSongName,
        getMode,
        onSongStateChange,
        sampleLevel,
        setSensitivity,
        isActive,
    };
}
