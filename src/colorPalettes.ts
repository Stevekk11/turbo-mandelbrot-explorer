import type {PaletteDef} from './types';

export const PALETTE_SIZE = 8192;

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

    data[i * 4] = Math.round(lerp(s0[1], s1[1], smooth));
    data[i * 4 + 1] = Math.round(lerp(s0[2], s1[2], smooth));
    data[i * 4 + 2] = Math.round(lerp(s0[3], s1[3], smooth));
    data[i * 4 + 3] = 255;
  }

  return data;
}

// ─── Palette 0 — Ultra Fractal Classic ────────────────────────────────────────
// Rich gradient: black → cobalt → azure → cyan → white → gold → orange → crimson → black
const ultraFractalStops: Stop[] = [
  [0.00, 0, 7, 100],
  [0.10, 15, 40, 150],
  [0.20, 32, 107, 203],
  [0.35, 100, 200, 255],
  [0.50, 237, 255, 255],
  [0.65, 255, 200, 50],
  [0.75, 255, 140, 0],
  [0.85, 200, 40, 0],
  [0.93, 80, 10, 0],
  [1.00, 0, 7, 100],
];

// ─── Palette 1 — Fire ─────────────────────────────────────────────────────────
// Coal black → deep crimson → orange flame → bright yellow → white-hot → coal black
const fireStops: Stop[] = [
  [0.00, 0, 0, 0],
  [0.10, 40, 0, 0],
  [0.20, 80, 0, 0],
  [0.32, 150, 20, 0],
  [0.45, 200, 40, 0],
  [0.58, 255, 100, 0],
  [0.70, 255, 160, 0],
  [0.82, 255, 200, 50],
  [0.90, 255, 240, 100],
  [0.95, 255, 255, 255],
  [1.00, 0, 0, 0],
];

// ─── Palette 2 — Ocean Deep ───────────────────────────────────────────────────
// Midnight abyss → navy → cobalt → cerulean → aqua → seafoam white → midnight abyss
const oceanStops: Stop[] = [
  [0.00, 0, 0, 20],
  [0.08, 0, 5, 50],
  [0.15, 0, 10, 80],
  [0.25, 0, 30, 130],
  [0.35, 0, 60, 180],
  [0.45, 0, 120, 200],
  [0.55, 0, 180, 220],
  [0.65, 30, 210, 220],
  [0.75, 60, 230, 200],
  [0.85, 140, 245, 220],
  [0.95, 240, 255, 255],
  [1.00, 0, 0, 20],
];

// ─── Palette 7 — Cyberpunk Neon ───────────────────────────────────────────────
// Dark → hot pink → cyan → lime → magenta → back to dark
const cyberpunkStops: Stop[] = [
  [0.00, 0, 0, 0],
  [0.12, 100, 0, 100],
  [0.25, 255, 0, 150],
  [0.40, 0, 255, 255],
  [0.55, 50, 255, 50],
  [0.70, 255, 0, 200],
  [0.85, 200, 100, 255],
  [1.00, 0, 0, 0],
];


// ─── Palette 4 — Monochrome Marble ────────────────────────────────────────────
// Smooth sinusoidal black/white oscillation — clean, elegant
function buildMonochrome(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PALETTE_SIZE * 4);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const t = i / PALETTE_SIZE;
    // Two complete sine cycles with slight bias toward lighter tones
    const v = Math.round(128 + 127 * Math.sin(t * Math.PI * 4 - Math.PI / 2));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}

// ─── Palette 11 — Ultra Neon (RGB + Cyberpunk) ────────────────────────────────
// Combines full spectrum with neon highlights for maximum visual impact
const ultraNeonStops: Stop[] = [
  [0.00, 0, 0, 0],
  [0.08, 255, 0, 127],  // Hot Pink
  [0.18, 0, 0, 255],    // Pure Blue
  [0.28, 0, 255, 255],  // Cyan
  [0.38, 0, 255, 0],    // Lime Green
  [0.48, 255, 255, 0],  // Neon Yellow
  [0.58, 255, 127, 0],  // Orange
  [0.68, 255, 0, 0],    // Red
  [0.78, 255, 0, 255],  // Magenta
  [0.88, 127, 0, 255],  // Electric Violet
  [0.95, 255, 255, 255],// White-hot
  [1.00, 0, 0, 0],
];


export const PALETTES: PaletteDef[] = [
  {name: 'Ultra Neon', icon: '🚀', data: buildPalette(ultraNeonStops)},
  {name: 'Cyberpunk', icon: '🌃', data: buildPalette(cyberpunkStops)},
  { name: 'Ultra Fractal', icon: '🌌', data: buildPalette(ultraFractalStops) },
  { name: 'Fire',          icon: '🔥', data: buildPalette(fireStops) },
  { name: 'Ocean Deep',    icon: '🌊', data: buildPalette(oceanStops) },
  { name: 'Monochrome',    icon: '◐',  data: buildMonochrome() },
  { name: 'Random',        icon: '🎲',  data: new Uint8ClampedArray(PALETTE_SIZE * 4) },
];

/** Index of the mutable random palette slot in PALETTES */
export const RANDOM_PALETTE_INDEX = 7;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Generate a vivid random palette and return its RGBA lookup table. */
export function generateRandomPalette(): Uint8ClampedArray {
  const numMidStops = 4 + Math.floor(Math.random() * 18); // 3–7 colorful stops
  const stops: Stop[] = [[0.0, 0, 0, 0]];

  // Evenly spaced positions with small random jitter
  for (let i = 1; i <= numMidStops; i++) {
    const base = i / (numMidStops + 1);
    const pos = Math.max(0.01, Math.min(0.99, base + (Math.random() - 0.5) * 0.12));
    const hue = Math.random() * 360;
    const sat = 0.6 + Math.random() * 0.4;
    const lig = 0.35 + Math.random() * 0.4;
    const [r, g, b] = hslToRgb(hue, sat, lig);
    stops.push([pos, r, g, b]);
  }
  stops.sort((a, b) => a[0] - b[0]);
  stops.push([1.0, 0, 0, 0]);

  return buildPalette(stops);
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
  const fIdx = t * PALETTE_SIZE;
  const idx0 = Math.floor(fIdx) % PALETTE_SIZE;
  const idx1 = (idx0 + 1) % PALETTE_SIZE;
  const frac = fIdx - idx0;
  const b0 = idx0 * 4;
  const b1 = idx1 * 4;
  return [
    (data[b0]     + (data[b1]     - data[b0])     * frac) | 0,
    (data[b0 + 1] + (data[b1 + 1] - data[b0 + 1]) * frac) | 0,
    (data[b0 + 2] + (data[b1 + 2] - data[b0 + 2]) * frac) | 0,
  ];
}
