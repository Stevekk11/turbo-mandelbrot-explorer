import type { PaletteDef } from './types';

export const PALETTE_SIZE = 4096;

/** [position 0‒1, r, g, b] */
type Stop = [number, number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth cosine interpolation between palette stops */
function buildPalette(stops: Stop[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PALETTE_SIZE * 4);

  for (let i = 0; i < PALETTE_SIZE; i++) {
    const t = i / PALETTE_SIZE;

    // Find the two surrounding stops
    let s0: Stop = stops[0];
    let s1: Stop = stops[stops.length - 1];

    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) {
        s0 = stops[j];
        s1 = stops[j + 1];
        break;
      }
    }

    const range = s1[0] - s0[0];
    const segT = range > 0 ? (t - s0[0]) / range : 0;
    // Cosine easing for ultra-smooth gradient
    const smooth = (1 - Math.cos(segT * Math.PI)) / 2;

    data[i * 4 + 0] = Math.round(lerp(s0[1], s1[1], smooth));
    data[i * 4 + 1] = Math.round(lerp(s0[2], s1[2], smooth));
    data[i * 4 + 2] = Math.round(lerp(s0[3], s1[3], smooth));
    data[i * 4 + 3] = 255;
  }

  return data;
}

// ─── Palette 0 — Ultra Fractal Classic ────────────────────────────────────────
// The timeless fractal coloring: black → cobalt → azure → cyan → white → gold → orange → crimson → black
const ultraFractalStops: Stop[] = [
  [0.00, 0, 7, 100],
  [0.16, 32, 107, 203],
  [0.42, 237, 255, 255],
  [0.6425, 255, 170, 0],
  [0.8575, 0, 2, 0],
  [1.00, 0, 7, 100],
];

// ─── Palette 1 — Fire ─────────────────────────────────────────────────────────
// Coal black → deep crimson → orange flame → bright yellow → white-hot
const fireStops: Stop[] = [
  [0.00, 0, 0, 0],
  [0.20, 80, 0, 0],
  [0.40, 200, 40, 0],
  [0.60, 255, 140, 0],
  [0.80, 255, 240, 50],
  [1.00, 255, 255, 255],
];

// ─── Palette 2 — Ocean Deep ───────────────────────────────────────────────────
// Midnight abyss → navy → cobalt → cerulean → aqua → seafoam white
const oceanStops: Stop[] = [
  [0.00, 0, 0, 20],
  [0.15, 0, 10, 80],
  [0.35, 0, 60, 180],
  [0.55, 0, 180, 220],
  [0.75, 60, 230, 200],
  [0.90, 180, 255, 240],
  [1.00, 240, 255, 255],
];

// ─── Palette 3 — Electric Dreams ──────────────────────────────────────────────
// Void black → deep violet → electric purple → magenta → hot pink → neon yellow → white
const electricStops: Stop[] = [
  [0.00, 0, 0, 0],
  [0.12, 20, 0, 60],
  [0.28, 90, 0, 200],
  [0.45, 200, 0, 200],
  [0.60, 255, 0, 100],
  [0.75, 255, 200, 0],
  [0.88, 255, 255, 100],
  [1.00, 255, 255, 255],
];

// ─── Palette 4 — Monochrome Marble ────────────────────────────────────────────
// Smooth sinusoidal black/white oscillation — clean, elegant
function buildMonochrome(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PALETTE_SIZE * 4);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const t = i / PALETTE_SIZE;
    // Two complete sine cycles with slight bias toward lighter tones
    const v = Math.round(128 + 127 * Math.sin(t * Math.PI * 4 - Math.PI / 2));
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}

export const PALETTES: PaletteDef[] = [
  { name: 'Ultra Fractal', icon: '🌌', data: buildPalette(ultraFractalStops) },
  { name: 'Fire',          icon: '🔥', data: buildPalette(fireStops) },
  { name: 'Ocean Deep',    icon: '🌊', data: buildPalette(oceanStops) },
  { name: 'Electric',      icon: '⚡', data: buildPalette(electricStops) },
  { name: 'Monochrome',    icon: '◐',  data: buildMonochrome() },
];

/**
 * Map a smooth iteration value to an RGBA color.
 * `val` is the smooth iteration count (float), or -1 for interior (→ black).
 */
export function samplePalette(
  palette: PaletteDef,
  val: number,
  maxIter: number,
  colorSpeed: number,
  colorOffset: number
): [number, number, number] {
  if (val < 0) return [0, 0, 0]; // interior → black

  // Map to palette index with speed and offset
  const t = ((val * colorSpeed * 0.01 + colorOffset) % 1 + 1) % 1;
  const idx = Math.floor(t * PALETTE_SIZE) % PALETTE_SIZE;
  const base = idx * 4;
  const d = palette.data;
  return [d[base], d[base + 1], d[base + 2]];
}

/** Version used inside Web Workers (avoids importing PALETTES objects) */
export function samplePaletteData(
  data: Uint8ClampedArray,
  val: number,
  colorSpeed: number,
  colorOffset: number
): [number, number, number] {
  if (val < 0) return [0, 0, 0];
  const t = ((val * colorSpeed * 0.01 + colorOffset) % 1 + 1) % 1;
  const idx = Math.floor(t * PALETTE_SIZE) % PALETTE_SIZE;
  const base = idx * 4;
  return [data[base], data[base + 1], data[base + 2]];
}
