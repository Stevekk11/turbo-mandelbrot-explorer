/** Fractal view state – the complete representation of "where we are" */
export interface ViewState {
  /** Left edge in fractal coordinates */
  xMin: number;
  /** Right edge in fractal coordinates */
  xMax: number;
  /** Top edge in fractal coordinates */
  yMin: number;
  /** Bottom edge in fractal coordinates */
  yMax: number;
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
  juliaRe: number;
  /** Julia constant (imaginary part) */
  juliaIm: number;
  /** Current zoom level (derived, for display) */
  zoom: number;
  orbitTrapMode: number;
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
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  maxIter: number;
  /** Julia constant (real part) */
  juliaRe: number;
  /** Julia constant (imaginary part) */
  juliaIm: number;
  /** Julia mode active */
  isJulia: boolean;
  /** Active color palette index (0‒4) */
  palette: number;
  /** Color cycle speed multiplier */
  colorSpeed: number;
  /** Color offset for animation */
  colorOffset: number;
  orbitTrapMode: number;
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
}

/** Broadcast to all workers: discard their cached iteration data */
export interface ClearCacheMessage {
  type: 'clearCache';
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

export type ToWorkerMessage = InitMessage | RenderTask | RecolorTask | ClearCacheMessage;
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
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  maxIter: number;
  palette: number;
  isJulia: boolean;
  juliaRe: number;
  juliaIm: number;
  orbitTrapMode: number;
}
