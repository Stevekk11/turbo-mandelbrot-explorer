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

function threeSum(a: number, b: number, c: number): [number, number, number] {
    const [t1, t2] = twoSum(a, b);
    const [s0, t3] = twoSum(c, t1);
    const [s1, s2] = twoSum(t2, t3);
    return [s0, s1, s2];
}

function threeSum2(a: number, b: number, c: number): [number, number] {
    const [t1, t2] = twoSum(a, b);
    const [s0, t3] = twoSum(c, t1);
    return [s0, t2 + t3];
}

// ─── Renormalization ──────────────────────────────────────────────────────────
// Bottom-up pass from least-significant to most-significant, followed by a
// top-down pass that skips zero components to guarantee non-overlapping form
// even after catastrophic cancellation in subtraction.

function renorm5(c0: number, c1: number, c2: number, c3: number, c4: number): QD {
    if (!Number.isFinite(c0)) return [c0, 0, 0, 0];

    let s0: number, s1: number, s2: number, s3: number, s4: number;

    [s0, s4] = twoSum(c3, c4);
    [s0, s3] = twoSum(c2, s0);
    [s0, s2] = twoSum(c1, s0);
    [s0, s1] = twoSum(c0, s0);

    let b0 = s0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;

    [b0, b1] = twoSum(s0, s1);
    if (b1 !== 0) {
        [b1, b2] = twoSum(b1, s2);
        if (b2 !== 0) {
            [b2, b3] = twoSum(b2, s3);
            if (b3 !== 0) {
                b3 += s4;
            } else {
                [b2, b3] = twoSum(b2, s4);
            }
        } else {
            [b1, b2] = twoSum(b1, s3);
            if (b2 !== 0) {
                [b2, b3] = twoSum(b2, s4);
            } else {
                [b1, b2] = twoSum(b1, s4);
            }
        }
    } else {
        [b0, b1] = twoSum(b0, s2);
        if (b1 !== 0) {
            [b1, b2] = twoSum(b1, s3);
            if (b2 !== 0) {
                [b2, b3] = twoSum(b2, s4);
            } else {
                [b1, b2] = twoSum(b1, s4);
            }
        } else {
            [b0, b1] = twoSum(b0, s3);
            if (b1 !== 0) {
                [b1, b2] = twoSum(b1, s4);
            } else {
                [b0, b1] = twoSum(b0, s4);
            }
        }
    }

    return [b0, b1, b2, b3];
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

// QD + QD  (Hida et al. Algorithm 4)
export function qdAdd(a: QD, b: QD): QD {
    let [s0, t0] = twoSum(a[0], b[0]);
    let [s1, t1] = twoSum(a[1], b[1]);
    let [s2, t2] = twoSum(a[2], b[2]);
    let [s3, t3] = twoSum(a[3], b[3]);

    [s1, t0] = twoSum(s1, t0);
    [s2, t0, t1] = threeSum(s2, t0, t1);
    [s3, t0] = threeSum2(s3, t0, t2);
    t0 = t0 + t1 + t3;

    return renorm5(s0, s1, s2, s3, t0);
}

export function qdSub(a: QD, b: QD): QD {
    return qdAdd(a, [-b[0], -b[1], -b[2], -b[3]]);
}

// QD * double  (Hida et al.)
export function qdMulNum(a: QD, b: number): QD {
    const [p0, q0] = twoProd(a[0], b);
    const [p1, q1] = twoProd(a[1], b);
    const [p2, q2] = twoProd(a[2], b);
    const p3 = a[3] * b;

    const s0 = p0;
    const [s1, t0] = twoSum(q0, p1);
    const [s2, t1, t2] = threeSum(t0, q1, p2);
    const [s3, t3] = threeSum2(t1, q2, p3);
    const s4 = t3 + t2;

    return renorm5(s0, s1, s2, s3, s4);
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

// QD * QD  (Hida et al. — accurate multiply, keeps terms up to order 4)
export function qdMul(a: QD, b: QD): QD {
    let [p0, q0] = twoProd(a[0], b[0]);

    let [p1, q1] = twoProd(a[0], b[1]);
    let [p2, q2] = twoProd(a[1], b[0]);

    let [p3, q3] = twoProd(a[0], b[2]);
    let [p4, q4] = twoProd(a[1], b[1]);
    let [p5, q5] = twoProd(a[2], b[0]);

    // Level 1: accumulate order-1 terms (p1, p2, q0)
    [p1, p2, q0] = threeSum(p1, p2, q0);

    // Level 2: five-three-sum of (p2, q1, q2, p3, p4, p5)
    [p2, q1, q2] = threeSum(p2, q1, q2);
    [p3, p4, p5] = threeSum(p3, p4, p5);
    let [s0, t0] = twoSum(p2, p3);
    let [s1, t1] = twoSum(q1, p4);
    let s2 = q2 + p5;
    [s1, t0] = twoSum(s1, t0);
    s2 += t0 + t1;

    // Level 3: order-3 terms and errors from level 2
    let [p6, q6] = twoProd(a[0], b[3]);
    let [p7, q7] = twoProd(a[1], b[2]);
    let [p8, q8] = twoProd(a[2], b[1]);
    let [p9, q9] = twoProd(a[3], b[0]);

    [q0, q3] = twoSum(q0, q3);
    [q4, q5] = twoSum(q4, q5);
    [p6, p7] = twoSum(p6, p7);
    [p8, p9] = twoSum(p8, p9);

    [q0, p6] = twoSum(q0, p6);
    [q4, p8] = twoSum(q4, p8);

    [q0, q4] = twoSum(q0, q4);
    [s1, q0] = twoSum(s1, q0);

    const s3 =
        q0 + q3 + q5 + p6 + p7 + p8 + p9 + s2 +
        a[1] * b[3] + a[2] * b[2] + a[3] * b[1] +
        q6 + q7 + q8 + q9;

    return renorm5(p0, p1, s0, s1, s3);
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
