/**
 * Double-double (DD) arithmetic — ~31 decimal digits of precision.
 *
 * Each DD number is a pair [hi, lo] where the true value is hi + lo,
 * with |lo| ≤ ulp(hi) / 2.  Based on the Dekker (1971) and Knuth (1997)
 * error-free-transformation algorithms.
 * giving a dramatic speed improvement while preserving enough
 * precision to zoom to roughly 10^31.
 */

export type DD = [number, number];

// ─── Error-free primitives ────────────────────────────────────────────────────

/** Exact sum: returns [sum, rounding-error] such that sum + err = a + b exactly. */
function twoSum(a: number, b: number): DD {
  const s = a + b;
  const v = s - a;
  return [s, (a - (s - v)) + (b - v)];
}

/** Veltkamp split: split a 53-bit float into two non-overlapping 26-bit halves. */
const SPLITTER = 134217729; // 2^27 + 1
function veltkampSplit(a: number): [number, number] {
  const t = SPLITTER * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}

/** Exact product: returns [product, rounding-error] such that p + err = a*b exactly. */
function twoProd(a: number, b: number): DD {
  const p = a * b;
  const [ahi, alo] = veltkampSplit(a);
  const [bhi, blo] = veltkampSplit(b);
  return [p, ((ahi * bhi - p) + ahi * blo + alo * bhi) + alo * blo];
}

// ─── Public DD arithmetic API ─────────────────────────────────────────────────

/** DD + DD */
export function ddAdd(a: DD, b: DD): DD {
  const [s, se] = twoSum(a[0], b[0]);
  return twoSum(s, se + a[1] + b[1]);
}

/** DD − DD */
export function ddSub(a: DD, b: DD): DD {
  const [s, se] = twoSum(a[0], -b[0]);
  return twoSum(s, se + a[1] - b[1]);
}

/** DD × DD */
export function ddMul(a: DD, b: DD): DD {
  const [p, pe] = twoProd(a[0], b[0]);
  return twoSum(p, pe + a[0] * b[1] + a[1] * b[0]);
}

/** DD × scalar (faster than full ddMul) */
export function ddMulNum(a: DD, b: number): DD {
  const [p, pe] = twoProd(a[0], b);
  return twoSum(p, pe + a[1] * b);
}

/** DD ÷ scalar */
export function ddDivNum(a: DD, b: number): DD {
  const q = a[0] / b;
  const [ph, pe] = twoProd(q, b);
  return twoSum(q, (a[0] - ph - pe + a[1]) / b);
}

// ─── String serialisation ─────────────────────────────────────────────────────

/**
 * Parse a decimal string to DD.
 *
 * Accepts two formats:
 *  - "hi|lo" — compact exact round-trip (produced by ddToString)
 *  - Any standard decimal / scientific-notation string
 */
export function ddFromString(s: string): DD {
  // Fast path: hi|lo or QD-style x0|x1|x2|x3
  const parts = s.split('|');
  if (parts.length === 2) {
    return [Number(parts[0]), Number(parts[1])];
  }
  if (parts.length === 4) {
    const hi = Number(parts[0]);
    const lo = Number(parts[1]) + Number(parts[2]) + Number(parts[3]);
    return twoSum(hi, lo);
  }

  const neg = s.charCodeAt(0) === 45; // '-'
  let str = neg ? s.slice(1) : s;

  // Split off optional exponent part
  const eIdx = str.search(/[eE]/);
  let exp = 0;
  if (eIdx >= 0) {
    exp = parseInt(str.slice(eIdx + 1)) | 0;
    str = str.slice(0, eIdx);
  }

  // Remove decimal point and track its position
  const dotIdx = str.indexOf('.');
  if (dotIdx >= 0) {
    exp -= str.length - dotIdx - 1;
    str = str.slice(0, dotIdx) + str.slice(dotIdx + 1);
  }

  // Horner accumulation in DD: result = result * 10 + digit
  let hi = 0, lo = 0;
  for (let i = 0; i < str.length; i++) {
    const [mh, me] = twoProd(hi, 10);
    const d = str.charCodeAt(i) - 48;
    const [sh, se] = twoSum(mh, d);
    hi = sh;
    lo = me + lo * 10 + se;
  }
  [hi, lo] = twoSum(hi, lo);

  // Apply the base-10 exponent
  for (let i = 0; i < exp; i++) {
    const [mh, me] = twoProd(hi, 10);
    [hi, lo] = twoSum(mh, me + lo * 10);
  }
  for (let i = 0; i > exp; i--) {
    const q = hi / 10;
    const [ph, pe] = twoProd(q, 10);
    [hi, lo] = twoSum(q, (hi - ph - pe + lo) / 10);
  }

  return neg ? [-hi, -lo] : [hi, lo];
}

