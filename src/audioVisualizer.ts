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
    let lowPass: BiquadFilterNode | null = null;
    let analyser: AnalyserNode | null = null;

    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let smoothedLevel = 0;
    let noiseFloor = 0.03;
    let sensitivity = DEFAULT_SENSITIVITY;
    let active = false;

    function cleanupGraph() {
        source?.disconnect();
        lowPass?.disconnect();
        analyser?.disconnect();
        source = null;
        lowPass = null;
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
                echoCancellation: false,
                autoGainControl: false,
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
        filter.type = 'lowpass';
        filter.frequency.value = 250;
        filter.Q.value = 1.0;

        const analyzerNode = ctx.createAnalyser();
        analyzerNode.fftSize = 1024;
        analyzerNode.smoothingTimeConstant = 0.7;

        streamSource.connect(filter);
        filter.connect(analyzerNode);

        source = streamSource;
        lowPass = filter;
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

        const gated = Math.max(0, rawEnergy - (noiseFloor + 0.4));
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

    return {
        start,
        stop,
        sampleLevel,
        setSensitivity,
        isActive,
    };
}
