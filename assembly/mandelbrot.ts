/**
 * High-performance Mandelbrot/Julia set computation in AssemblyScript (WASM)
 * Uses smooth iteration count for beautiful color gradients.
 */

// Shared output buffer for tile results (smooth iteration counts as f32)
let _buf: Float32Array = new Float32Array(0);
let _bufSize: i32 = 0;

/**
 * Allocate (or reuse) output buffer for a tile of given dimensions.
 * Returns the data start pointer so JS can read results directly from WASM memory.
 */
export function allocBuffer(width: i32, height: i32): i32 {
  const size = width * height;
  if (size > _bufSize) {
    _buf = new Float32Array(size);
    _bufSize = size;
  }
  return <i32>_buf.dataStart;
}

/**
 * Compute Mandelbrot or Julia set for a rectangular tile.
 * Results (smooth iteration count, or -1 for interior) written to shared buffer.
 *
 * @param xMin    Left edge of this tile in fractal coordinates
 * @param yMin    Top edge of this tile in fractal coordinates
 * @param xMax    Right edge of this tile in fractal coordinates
 * @param yMax    Bottom edge of this tile in fractal coordinates
 * @param width   Tile width in pixels
 * @param height  Tile height in pixels
 * @param maxIter Maximum iteration count
 * @param juliaRe Real part of Julia constant (ignored for Mandelbrot)
 * @param juliaIm Imaginary part of Julia constant (ignored for Mandelbrot)
 * @param isJulia Non-zero for Julia set, zero for Mandelbrot
 */
export function computeTile(
  xMin: f64, yMin: f64, xMax: f64, yMax: f64,
  width: i32, height: i32, maxIter: i32,
  juliaRe: f64, juliaIm: f64, isJulia: i32
): void {
  const dx: f64 = (xMax - xMin) / <f64>width;
  const dy: f64 = (yMax - yMin) / <f64>height;
  const isJ: bool = isJulia != 0;

  for (let py: i32 = 0; py < height; py++) {
    const im: f64 = yMin + <f64>py * dy;
    const rowBase: i32 = py * width;

    for (let px: i32 = 0; px < width; px++) {
      const re: f64 = xMin + <f64>px * dx;

      let zRe: f64 = isJ ? re : 0.0;
      let zIm: f64 = isJ ? im : 0.0;
      const cRe: f64 = isJ ? juliaRe : re;
      const cIm: f64 = isJ ? juliaIm : im;

      let iter: i32 = 0;
      let x2: f64 = zRe * zRe;
      let y2: f64 = zIm * zIm;

      while (x2 + y2 <= 4.0 && iter < maxIter) {
        zIm = 2.0 * zRe * zIm + cIm;
        zRe = x2 - y2 + cRe;
        x2 = zRe * zRe;
        y2 = zIm * zIm;
        iter++;
      }

      let val: f32;
      if (iter >= maxIter) {
        // Interior of set → black
        val = -1.0;
      } else {
        // Smooth iteration count (Binet's formula-derived)
        // Avoids discrete color banding
        const log_zn: f64 = Math.log(x2 + y2) * 0.5;
        const nu: f64 = Math.log(log_zn / Math.LN2) / Math.LN2;
        val = <f32>(<f64>iter + 1.0 - nu);
      }

      unchecked(_buf[rowBase + px] = val);
    }
  }
}

/**
 * Get current buffer size (number of elements, not bytes).
 */
export function getBufferSize(): i32 {
  return _bufSize;
}
