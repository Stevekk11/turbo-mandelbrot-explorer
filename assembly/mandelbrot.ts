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
 * @param multibrotPower Real exponent d used for Multibrot when fractalType is 0
 * @param fractalType Fractal formula (0=Mandelbrot, 1=Burning Ship, 2=Tricorn)
 */
export function computeTile(
    xMin: f64, yMin: f64, xMax: f64, yMax: f64,
    width: i32, height: i32, maxIter: i32,
    juliaRe: f64, juliaIm: f64, isJulia: i32,
  multibrotPower: f64,
    fractalType: i32
): void {
  const dx: f64 = (xMax - xMin) / <f64>width;
  const dy: f64 = (yMax - yMin) / <f64>height;
  const isJ: bool = isJulia != 0;
  const multibrotMode: i32 = multibrotPower == 2.0 ? 2 : multibrotPower == 3.0 ? 3 : multibrotPower == 4.0 ? 4 : 0;
  const smoothBase: f64 = fractalType == 0 && multibrotPower > 1.000001 ? multibrotPower : 2.0;
  const logBase: f64 = Math.log(smoothBase);

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

      while (x2 + y2 <= 100000.0 && iter < maxIter) {
        if (fractalType == 1) {
          // Burning Ship: take absolute values before squaring
          zIm = 2.0 * Math.abs(zRe) * Math.abs(zIm) + cIm;
          zRe = x2 - y2 + cRe;
        } else if (fractalType == 2) {
          // Tricorn (Mandelbar): z_{n+1} = conj(z_n)² + c
          zIm = -2.0 * zRe * zIm + cIm;
          zRe = x2 - y2 + cRe;
        } else {
          // Multibrot: z_{n+1} = z_n^d + c, where d is a real exponent
          switch (multibrotMode) {
            case 2:
              zIm = 2.0 * zRe * zIm + cIm;
              zRe = x2 - y2 + cRe;
              break;
            case 3: {
              const nextRe: f64 = zRe * (x2 - 3.0 * y2);
              const nextIm: f64 = zIm * (3.0 * x2 - y2);
              zRe = nextRe + cRe;
              zIm = nextIm + cIm;
              break;
            }
            case 4: {
              const xy: f64 = zRe * zIm;
              const a: f64 = x2 - y2;
              const b: f64 = 2.0 * xy;
              zRe = (a * a - b * b) + cRe;
              zIm = 2.0 * a * b + cIm;
              break;
            }
            default: {
              const radiusSq: f64 = x2 + y2;
              if (radiusSq == 0.0) {
                zRe = cRe;
                zIm = cIm;
              } else {
                const radiusPow: f64 = Math.pow(Math.sqrt(radiusSq), multibrotPower);
                const angle: f64 = Math.atan2(zIm, zRe) * multibrotPower;
                zRe = radiusPow * Math.cos(angle) + cRe;
                zIm = radiusPow * Math.sin(angle) + cIm;
              }
            }
          }
        }
        x2 = zRe * zRe;
        y2 = zIm * zIm;
        iter++;
      }

      let val: f32;
      if (iter >= maxIter) {
        // Interior of set → black
        val = -1.0;
      } else {
        // Smooth iteration count with large escape radius
        const log_zn: f64 = Math.log(x2 + y2) * 0.5;
        const nu: f64 = Math.log(log_zn / logBase) / logBase;
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