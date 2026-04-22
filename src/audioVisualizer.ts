export interface AudioVisualizerController {
    start(): Promise<void>;

    stop(): void;

    sampleLevel(): number;

    setSensitivity(value: number): void;

    isActive(): boolean;
}

const DEFAULT_SENSITIVITY = 1.4;

export function createAudioVisualizer(): AudioVisualizerController {
    let audioContext: AudioContext | null = null;
    let mediaStream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let highPass: BiquadFilterNode | null = null;
    let analyser: AnalyserNode | null = null;

    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let smoothedLevel = 0;
    let noiseFloor = 0.03;
    let sensitivity = DEFAULT_SENSITIVITY;
    let active = false;

    function cleanupGraph() {
        source?.disconnect();
        highPass?.disconnect();
        analyser?.disconnect();
        source = null;
        highPass = null;
        analyser = null;
        freqData = null;
    }

    async function start() {
        if (active && audioContext && analyser) {
            if (audioContext.state === 'suspended') await audioContext.resume();
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                noiseSuppression: true,
                echoCancellation: true,
                autoGainControl: true,
            },
            video: false,
        });

        const Ctor = window.AudioContext || (window as typeof window & {
            webkitAudioContext?: typeof AudioContext
        }).webkitAudioContext;
        if (!Ctor) {
            stream.getTracks().forEach(track => track.stop());
            throw new Error('Web Audio API is not supported in this browser.');
        }

        const ctx = audioContext ?? new Ctor();
        if (ctx.state === 'suspended') await ctx.resume();

        audioContext = ctx;
        mediaStream = stream;

        const streamSource = ctx.createMediaStreamSource(stream);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 80;
        filter.Q.value = 0.7;

        const analyzerNode = ctx.createAnalyser();
        analyzerNode.fftSize = 1024;
        analyzerNode.smoothingTimeConstant = 0.7;

        streamSource.connect(filter);
        filter.connect(analyzerNode);

        source = streamSource;
        highPass = filter;
        analyser = analyzerNode;
        freqData = new Uint8Array(analyzerNode.frequencyBinCount) as Uint8Array<ArrayBuffer>;

        smoothedLevel = 0;
        noiseFloor = 0.03;
        active = true;
    }

    function stop() {
        active = false;
        smoothedLevel = 0;
        noiseFloor = 0.03;
        cleanupGraph();
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
    }

    function sampleLevel(): number {
        if (!active || !analyser || !freqData || !audioContext) return 0;

        analyser.getByteFrequencyData(freqData as unknown as Uint8Array<ArrayBuffer>);

        const hzPerBin = (audioContext.sampleRate * 0.5) / freqData.length;
        const minBin = Math.max(1, Math.floor(85 / hzPerBin));
        const maxBin = Math.min(freqData.length - 1, Math.ceil(4200 / hzPerBin));

        let weighted = 0;
        let weightSum = 0;
        for (let i = minBin; i <= maxBin; i++) {
            const hz = i * hzPerBin;
            const bandWeight = hz < 220 ? 0.7 : (hz < 1700 ? 1.45 : 1.05);
            weighted += (freqData[i] / 255) * bandWeight;
            weightSum += bandWeight;
        }

        const rawEnergy = weightSum > 0 ? weighted / weightSum : 0;

        // Adaptive gate so laptop mics do not constantly pulse on room hiss.
        const floorTarget = rawEnergy < noiseFloor ? rawEnergy : noiseFloor;
        noiseFloor = noiseFloor * 0.985 + floorTarget * 0.015;

        const gated = Math.max(0, rawEnergy - (noiseFloor + 0.01));
        const normalized = Math.min(1, gated * sensitivity * 3.25);

        const attack = 0.38;
        const release = 0.08;
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

    return {
        start,
        stop,
        sampleLevel,
        setSensitivity,
        isActive,
    };
}
