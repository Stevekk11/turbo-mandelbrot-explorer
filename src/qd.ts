/**
 * Quad-double (QD) arithmetic — ~62 decimal digits of precision.
 *
 * QD is represented as an expansion of four non-overlapping float64 values:
 *   [x0, x1, x2, x3], with value = x0 + x1 + x2 + x3,  |x1| <= ulp(x0)/2, etc.
 *
 * Algorithms follow Hida, Li & Bailey "Library for Double-Double and
 * Quad-Double Arithmetic" (2000), and the QD C++ library source.
 */

export type QD = [number, number, number, number];

// ─── Error-free primitives ────────────────────────────────────────────────────

const SPLITTER = 134217729; // 2^27 + 1

function twoSum(a: number, b: number): [number, number] {
    const s = a + b;
    const bb = s - a;
    return [s, (a - (s - bb)) + (b - bb)];
}

function quickTwoSum(a: number, b: number): [number, number] {
    const s = a + b;
    return [s, b - (s - a)];
}

function split(a: number): [number, number] {
    const t = SPLITTER * a;
    const hi = t - (t - a);
    return [hi, a - hi];
}

function twoProd(a: number, b: number): [number, number] {
    const p = a * b;
    const [ah, al] = split(a);
    const [bh, bl] = split(b);
    return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

// ─── Renormalization ──────────────────────────────────────────────────────────
// Single forward pass: accumulate from most-significant to least-significant,
// then a second forward pass to ensure non-overlapping property.

function renorm5(a0: number, a1: number, a2: number, a3: number, a4: number): QD {
    let s: number, e: number;

    // Forward pass: propagate carries from a0 downward
    [s, e] = quickTwoSum(a0, a1);
    a0 = s;
    a1 = e;
    [s, e] = quickTwoSum(a1, a2);
    a1 = s;
    a2 = e;
    [s, e] = quickTwoSum(a2, a3);
    a2 = s;
    a3 = e;
    [s, e] = quickTwoSum(a3, a4);
    a3 = s;
    a4 = e;

    // Second forward pass to clean up
    [s, e] = quickTwoSum(a0, a1);
    a0 = s;
    a1 = e;
    [s, e] = quickTwoSum(a1, a2);
    a1 = s;
    a2 = e;
    [s, e] = quickTwoSum(a2, a3);
    a2 = s;
    a3 = e;

    return [a0, a1, a2, a3];
}

function renorm4(a0: number, a1: number, a2: number, a3: number): QD {
    return renorm5(a0, a1, a2, a3, 0);
}

// ─── Constructors / conversions ──────────────────────────────────────────────

export function qdFromNum(v: number): QD {
    return [v, 0, 0, 0];
}

export function qdHi(a: QD): number {
    return a[0];
}

export function qdToNumber(a: QD): number {
    return a[0] + a[1] + a[2] + a[3];
}

// ─── Core arithmetic ──────────────────────────────────────────────────────────

// QD + QD  (Hida et al. Algorithm 4 — sloppy add)
export function qdAdd(a: QD, b: QD): QD {
    let [s0, e0] = twoSum(a[0], b[0]);
    let [s1, e1] = twoSum(a[1], b[1]);
    let [s2, e2] = twoSum(a[2], b[2]);
    let [s3, e3] = twoSum(a[3], b[3]);

    // Cascade the errors into the next component
    [s1, e0] = twoSum(s1, e0);
    [s2, e1] = twoSum(s2, e1);
    [s3, e2] = twoSum(s3, e2);
    const s4 = e3 + e2;

    [s2, e0] = twoSum(s2, e0);
    [s3, e1] = twoSum(s3, e1);
    const s5 = s4 + e1;

    [s3, e0] = twoSum(s3, e0);
    const s6 = s5 + e0;

    return renorm5(s0, s1, s2, s3, s6);
}

export function qdSub(a: QD, b: QD): QD {
    return qdAdd(a, [-b[0], -b[1], -b[2], -b[3]]);
}

// QD * double  (Hida et al.)
export function qdMulNum(a: QD, b: number): QD {
    const [p0, e0] = twoProd(a[0], b);
    const [p1, e1] = twoProd(a[1], b);
    const [p2, e2] = twoProd(a[2], b);
    const [p3, e3] = twoProd(a[3], b);

    let s0 = p0;
    let [s1, t0] = quickTwoSum(p1, e0);
    let [s2, t1] = twoSum(p2, e1);
    let [s3, t2] = twoSum(p3, e2);

    [s2, t0] = twoSum(s2, t0);
    [s3, t1] = twoSum(s3, t1);
    const s4 = t2 + e3;
    [s3, t0] = twoSum(s3, t0);
    const s5 = t1 + s4;
    const s6 = t0 + s5;

    return renorm5(s0, s1, s2, s3, s6);
}

export function qdDivNum(a: QD, b: number): QD {
    const q0 = a[0] / b;
    let r = qdSub(a, qdMulNum(qdFromNum(q0), b));

    const q1 = r[0] / b;
    r = qdSub(r, qdMulNum(qdFromNum(q1), b));

    const q2 = r[0] / b;
    r = qdSub(r, qdMulNum(qdFromNum(q2), b));

    const q3 = r[0] / b;

    return renorm4(q0, q1, q2, q3);
}

// QD * QD  (Hida et al. — sloppy multiply, keeps terms up to order 4)
export function qdMul(a: QD, b: QD): QD {
    const [p0, q0] = twoProd(a[0], b[0]);

    let [p1, q1] = twoProd(a[0], b[1]);
    let [p2, q2] = twoProd(a[1], b[0]);

    let [p3, q3] = twoProd(a[0], b[2]);
    let [p4, q4] = twoProd(a[1], b[1]);
    let [p5, q5] = twoProd(a[2], b[0]);

    // Level 1: accumulate order-1 terms
    let [s1, r0] = twoSum(q0, p1);
    [s1, r0] = twoSum(s1, p2);

    // Level 2: accumulate order-2 terms
    let [s2, r1] = twoSum(r0, p3);
    [s2, r1] = twoSum(s2, p4);
    [s2, r1] = twoSum(s2, p5);
    // Include the errors from level 1
    [s2, r1] = twoSum(s2, q1);
    [s2, r1] = twoSum(s2, q2);

    // Order-3 terms (only high parts needed)
    const p6 = a[0] * b[3];
    const p7 = a[1] * b[2];
    const p8 = a[2] * b[1];
    const p9 = a[3] * b[0];

    // Order-3 accumulation
    let [s3, r2] = twoSum(r1, p6);
    [s3, r2] = twoSum(s3, p7);
    [s3, r2] = twoSum(s3, p8);
    [s3, r2] = twoSum(s3, p9);
    // Include errors from level 2
    [s3, r2] = twoSum(s3, q3);
    [s3, r2] = twoSum(s3, q4);
    [s3, r2] = twoSum(s3, q5);

    return renorm5(p0, s1, s2, s3, r2);
}

export function qdDiv(a: QD, b: QD): QD {
    const q0 = a[0] / b[0];
    let r = qdSub(a, qdMul(b, qdFromNum(q0)));

    const q1 = r[0] / b[0];
    r = qdSub(r, qdMul(b, qdFromNum(q1)));

    const q2 = r[0] / b[0];
    r = qdSub(r, qdMul(b, qdFromNum(q2)));

    const q3 = r[0] / b[0];

    return renorm4(q0, q1, q2, q3);
}

// ─── String serialization ─────────────────────────────────────────────────────

/**
 * Exact round-trip format:
 *   "x0|x1|x2|x3"
 * Also accepts plain numeric string for backward compatibility.
 */
export function qdToString(a: QD): string {
    if (a[1] === 0 && a[2] === 0 && a[3] === 0) return String(a[0]);
    return `${a[0]}|${a[1]}|${a[2]}|${a[3]}`;
}

export function qdFromString(s: string): QD {
    const parts = s.split('|');
    if (parts.length === 4) {
        return [
            Number(parts[0]),
            Number(parts[1]),
            Number(parts[2]),
            Number(parts[3]),
        ];
    }
    if (parts.length === 2) {
        return [
            Number(parts[0]),
            Number(parts[1]),
            0,
            0,
        ];
    }
    return [Number(s), 0, 0, 0];
}
