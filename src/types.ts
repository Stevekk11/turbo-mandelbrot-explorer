/** Fractal view state – the complete representation of "where we are" */
export interface ViewState {
  /** Left edge in fractal coordinates */
  xMin: string;
  /** Right edge in fractal coordinates */
  xMax: string;
  /** Top edge in fractal coordinates */
  yMin: string;
  /** Bottom edge in fractal coordinates */
  yMax: string;
  /** Maximum iteration count */
  maxIter: number;
  /** Active color palette index (0‒4) */
  palette: number;
  /** Color cycle speed multiplier */
  colorSpeed: number;
  /** Color offset for animation */
  colorOffset: number;
  /** Julia mode active */
  isJulia: boolean;
  /** Julia constant (real part) */
  juliaRe: string;
  /** Julia constant (imaginary part) */
  juliaIm: string;
  /** Current zoom level (derived, for display) */
  zoom: string;
  /** 3D shadow/lighting overlay enabled */
  shadows: boolean;
  /** Fractal type: 0=Mandelbrot, 1=Burning Ship, 2=Tricorn */
  fractalType: number;
  /** Real exponent d for Multibrot (used with fractalType=0) */
  multibrotPower: number;
}

/** Message sent to a worker requesting tile rendering */
export interface RenderTask {
  type: 'render';
  taskId: number;
  /** Render generation — used to discard stale results */
  gen: number;
  /** Tile position/size in screen pixels */
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  /** Fractal coordinate bounds for this tile */
  xMin: string;
  yMin: string;
  xMax: string;
  yMax: string;
  maxIter: number;
  /** Julia constant (real part) */
  juliaRe: string;
  /** Julia constant (imaginary part) */
  juliaIm: string;
  /** Julia mode active */
  isJulia: boolean;
  /** Active color palette index (0‒4) */
  palette: number;
  /** Color cycle speed multiplier */
  colorSpeed: number;
  /** Color offset for animation */
  colorOffset: number;
  /** 3D shadow/lighting overlay enabled */
  shadows: boolean;
  /** Fractal type: 0=Mandelbrot, 1=Burning Ship, 2=Tricorn */
  fractalType: number;
  /** Real exponent d for Multibrot (used with fractalType=0) */
  multibrotPower: number;
  /** Explicit precision path for this tile. */
  precisionTier?: PrecisionTier;
  /**
   * View-centre coordinates used as the perturbation reference point.
   * DD format: "hi|lo"; QD format: "x0|x1|x2|x3".
   */
  refRe?: string;
  refIm?: string;
}

/** Message sent to a worker to recolor a cached tile without recomputing the fractal */
export interface RecolorTask {
  type: 'recolor';
  taskId: number;
  gen: number;
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  palette: number;
  colorSpeed: number;
  colorOffset: number;
  /** 3D shadow/lighting overlay enabled */
  shadows: boolean;
}

/** Broadcast to all workers: discard their cached iteration data */
export interface ClearCacheMessage {
  type: 'clearCache';
}

/** Broadcast to all workers: replace palette data at the given index */
export interface UpdatePaletteDataMessage {
  type: 'updatePalette';
  index: number;
  /** Raw RGBA lookup table (transferable ArrayBuffer, PALETTE_SIZE × 4 bytes) */
  data: ArrayBuffer;
}

/** Message sent from a worker with a completed tile */
export interface RenderResult {
  type: 'result';
  taskId: number;
  gen: number;
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  /** RGBA pixel data for the tile */
  imageData: ArrayBuffer;
}

/** Worker initialization message */
export interface InitMessage {
  type: 'init';
  wasmUrl: string;
}

/** Worker ready acknowledgement */
export interface ReadyMessage {
  type: 'ready';
}

export type ToWorkerMessage = InitMessage | RenderTask | RecolorTask | ClearCacheMessage | UpdatePaletteDataMessage;
export type FromWorkerMessage = ReadyMessage | RenderResult;

/** Named palette definition */
export interface PaletteDef {
  name: string;
  /** Emoji icon */
  icon: string;
  /** RGBA lookup table (PALETTE_SIZE × 4 bytes) */
  data: Uint8ClampedArray;
}

/** Bookmarked location */
export interface Bookmark {
  label: string;
  xMin: string;
  xMax: string;
  yMin: string;
  yMax: string;
  maxIter: number;
  palette: number;
  isJulia: boolean;
  juliaRe: string;
  juliaIm: string;
  fractalType?: number;
  multibrotPower?: number;
}

/** Precision tiers for rendering paths */
export type PrecisionTier = 'wasm' | 'dd' | 'qd';
