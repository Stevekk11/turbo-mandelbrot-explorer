/**
 * Quad-double (QD) arithmetic — ~62 decimal digits of precision.
 *
 * QD is represented as an expansion of four non-overlapping float64 values:
 *   [x0, x1, x2, x3], with value = x0 + x1 + x2 + x3
 *
 * This is a lightweight implementation intended for fractal viewport math
 * (center/range transforms, coordinate mapping), not full transcendental math.
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

function renorm5(a0: number, a1: number, a2: number, a3: number, a4: number): QD {
    let s: number, e: number;

    [s, e] = quickTwoSum(a3, a4);
    a3 = s;
    a4 = e;

    [s, e] = quickTwoSum(a2, a3);
    a2 = s;
    a3 = e + a4;

    [s, e] = quickTwoSum(a1, a2);
    a1 = s;
    a2 = e + a3;

    [s, e] = quickTwoSum(a0, a1);
    a0 = s;
    a1 = e + a2;

    [a0, a1] = quickTwoSum(a0, a1);
    [a1, a2] = quickTwoSum(a1, a2);
    [a2, a3] = quickTwoSum(a2, a3);

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

export function qdAdd(a: QD, b: QD): QD {
    const [s0, e0] = twoSum(a[0], b[0]);
    const [s1, e1] = twoSum(a[1], b[1]);
    const [s2, e2] = twoSum(a[2], b[2]);
    const [s3, e3] = twoSum(a[3], b[3]);

    const t0 = s0;
    const t1 = e0 + s1;
    const t2 = e1 + s2;
    const t3 = e2 + s3;
    const t4 = e3;

    return renorm5(t0, t1, t2, t3, t4);
}

export function qdSub(a: QD, b: QD): QD {
    return qdAdd(a, [-b[0], -b[1], -b[2], -b[3]]);
}

export function qdMulNum(a: QD, b: number): QD {
    const [p0, e0] = twoProd(a[0], b);
    const [p1, e1] = twoProd(a[1], b);
    const [p2, e2] = twoProd(a[2], b);
    const [p3, e3] = twoProd(a[3], b);

    return renorm5(
        p0,
        e0 + p1,
        e1 + p2,
        e2 + p3,
        e3
    );
}

export function qdDivNum(a: QD, b: number): QD {
    // Newton-like compensated divide by scalar.
    const q0 = a[0] / b;
    let r = qdSub(a, qdMulNum(qdFromNum(q0), b));

    const q1 = r[0] / b;
    r = qdSub(r, qdMulNum(qdFromNum(q1), b));

    const q2 = r[0] / b;
    r = qdSub(r, qdMulNum(qdFromNum(q2), b));

    const q3 = r[0] / b;

    return renorm4(q0, q1, q2, q3);
}

export function qdMul(a: QD, b: QD): QD {
    // Truncated expansion product: sufficient for viewport transforms.
    const [p00, e00] = twoProd(a[0], b[0]);
    const [p01, e01] = twoProd(a[0], b[1]);
    const [p10, e10] = twoProd(a[1], b[0]);
    const [p02, e02] = twoProd(a[0], b[2]);
    const [p11, e11] = twoProd(a[1], b[1]);
    const [p20, e20] = twoProd(a[2], b[0]);
    const [p03, e03] = twoProd(a[0], b[3]);
    const [p12, e12] = twoProd(a[1], b[2]);
    const [p21, e21] = twoProd(a[2], b[1]);
    const [p30, e30] = twoProd(a[3], b[0]);

    const s0 = p00;
    const s1 = e00 + p01 + p10;
    const s2 = e01 + e10 + p02 + p11 + p20;
    const s3 = e02 + e11 + e20 + p03 + p12 + p21 + p30;
    const s4 = e03 + e12 + e21 + e30;

    return renorm5(s0, s1, s2, s3, s4);
}

export function qdDiv(a: QD, b: QD): QD {
    // 4-term long division
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
    // Backward-compatible numeric parse
    return [Number(s), 0, 0, 0];
}