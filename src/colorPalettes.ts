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

    data[i * 4 + 0] = Math.round(lerp(s0[1], s1[1], smooth));
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
    data[i * 4 + 0] = v;
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

// ─── Palette 12 — Super 50 ───────────────────────────────────────────────────
// A massive 50-stop palette for extreme detail and color density
const super50Stops: Stop[] = [
  [0.00, 0, 0, 0],   // Black
  [0.02, 20, 0, 50],   // Deep Night
  [0.04, 40, 0, 100],   // Navy
  [0.06, 60, 10, 150],   // Indigo
  [0.08, 80, 20, 200],   // Royal
  [0.10, 100, 40, 255],   // Electric Blue
  [0.12, 50, 80, 255],   // Sky
  [0.14, 0, 120, 255],   // Azure
  [0.16, 0, 160, 240],   // Deep Cyan
  [0.18, 0, 200, 220],   // Turquoise
  [0.20, 0, 255, 180],   // Mint
  [0.22, 0, 255, 100],   // Spring
  [0.24, 0, 255, 0],   // Lime
  [0.26, 80, 255, 0],   // Chartreuse
  [0.28, 160, 255, 0],   // Bright Green
  [0.30, 220, 255, 0],   // Yellow-Green
  [0.32, 255, 255, 0],   // Yellow
  [0.34, 255, 220, 0],   // Golden
  [0.36, 255, 180, 0],   // Amber
  [0.38, 255, 140, 0],   // Orange
  [0.40, 255, 100, 0],   // Deep Orange
  [0.42, 255, 60, 0],   // Orange-Red
  [0.44, 255, 0, 0],   // Red
  [0.46, 255, 0, 60],   // Crimson
  [0.48, 255, 0, 120],   // Rose
  [0.50, 255, 0, 180],   // Magenta
  [0.52, 255, 0, 255],   // Fuchsia
  [0.54, 200, 0, 255],   // Purple
  [0.56, 150, 0, 255],   // Violet
  [0.58, 100, 0, 255],   // Deep Purple
  [0.60, 50, 0, 255],   // Dark Violet
  [0.62, 80, 50, 200],   // Twilight
  [0.64, 110, 80, 180],   // Lavender
  [0.66, 150, 120, 220],   // Pastel Purple
  [0.68, 180, 160, 255],   // Periwinkle
  [0.70, 200, 200, 255],   // Off White
  [0.72, 255, 255, 255],   // White
  [0.74, 255, 230, 230],   // Pinkish White
  [0.76, 255, 200, 200],   // Soft Pink
  [0.78, 255, 150, 150],   // Coral
  [0.80, 255, 100, 100],   // Light Red
  [0.82, 180, 50, 50],   // Maroon
  [0.84, 120, 20, 20],   // Dark Red
  [0.86, 80, 10, 10],   // Blood
  [0.88, 40, 5, 5],   // Deep Maroon
  [0.90, 20, 20, 20],   // Gray
  [0.92, 60, 60, 60],   // Light Gray
  [0.94, 120, 120, 120],   // Silver
  [0.96, 200, 200, 220],   // Steel
  [1.00, 0, 0, 0],   // back to Black
];

export const PALETTES: PaletteDef[] = [
  {name: 'Super 50', icon: '💎', data: buildPalette(super50Stops)},
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
  const numMidStops = 3 + Math.floor(Math.random() * 5); // 3–7 colourful stops
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

/**
 * Map a smooth iteration value to an RGBA color.
 * `val` is the smooth iteration count (float), or -1 for interior (→ black).
 */
export function samplePalette(
  palette: PaletteDef,
  val: number,
  _maxIter: number,
  colorSpeed: number,
  colorOffset: number
): [number, number, number] {
  if (val < 0) return [0, 0, 0]; // interior → black

  // Map to palette index with speed and offset
  const t = ((val * colorSpeed * 0.01 + colorOffset) % 1 + 1) % 1;
  const fIdx = t * PALETTE_SIZE;
  const idx0 = Math.floor(fIdx) % PALETTE_SIZE;
  const idx1 = (idx0 + 1) % PALETTE_SIZE;
  const frac = fIdx - idx0;
  const d = palette.data;
  const b0 = idx0 * 4;
  const b1 = idx1 * 4;
  return [
    (d[b0]     + (d[b1]     - d[b0])     * frac) | 0,
    (d[b0 + 1] + (d[b1 + 1] - d[b0 + 1]) * frac) | 0,
    (d[b0 + 2] + (d[b1 + 2] - d[b0 + 2]) * frac) | 0,
  ];
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
