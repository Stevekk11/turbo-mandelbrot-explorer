import type {ViewState} from './types';
import type {QD} from './qd';
import {qdFromString, qdHi, qdSub} from './qd';

export interface ComplexPoint {
    re: number;
    im: number;
}

export function computeComplexPower(re: number, im: number, power: number): [number, number] {
    if (power === 2) {
        return [re * re - im * im, 2.0 * re * im];
    }
    if (power === 3) {
        const re2 = re * re;
        const im2 = im * im;
        return [re * (re2 - 3.0 * im2), im * (3.0 * re2 - im2)];
    }
    if (power === 4) {
        const re2 = re * re;
        const im2 = im * im;
        const a = re2 - im2;
        const b = 2.0 * re * im;
        return [a * a - b * b, 2.0 * a * b];
    }
    if (power === -2) {
        const re2 = re * re;
        const im2 = im * im;
        const r2 = re2 + im2;
        if (r2 === 0.0) return [Infinity, Infinity];
        const invR4 = 1.0 / (r2 * r2);
        return [(re2 - im2) * invR4, (-2.0 * re * im) * invR4];
    }
    if (power === -3) {
        const re2 = re * re;
        const im2 = im * im;
        const r2 = re2 + im2;
        if (r2 === 0.0) return [Infinity, Infinity];
        const invR6 = 1.0 / (r2 * r2 * r2);
        const pRe = re * (re2 - 3.0 * im2);
        const pIm = im * (3.0 * re2 - im2);
        return [pRe * invR6, -pIm * invR6];
    }
    if (power === -4) {
        const re2 = re * re;
        const im2 = im * im;
        const r2 = re2 + im2;
        if (r2 === 0.0) return [Infinity, Infinity];
        const a = re2 - im2;
        const b = 2.0 * re * im;
        const invR8 = 1.0 / (r2 * r2 * r2 * r2);
        return [(a * a - b * b) * invR8, (-2.0 * a * b) * invR8];
    }

    const radiusSq = re * re + im * im;
    if (radiusSq === 0.0) {
        return power < 0.0 ? [Infinity, Infinity] : [0.0, 0.0];
    }
    const radiusPow = Math.pow(Math.sqrt(radiusSq), power);
    const angle = Math.atan2(im, re) * power;
    return [radiusPow * Math.cos(angle), radiusPow * Math.sin(angle)];
}

export function estimateEscapeSample(
    re: number,
    im: number,
    maxIter: number,
    fractalType: number,
    juliaRe = 0,
    juliaIm = 0,
    isJulia = false,
    multibrotPower = 2.0
): { inside: boolean; escapeIter: number } {
    let zRe = isJulia ? re : 0;
    let zIm = isJulia ? im : 0;
    const cRe = isJulia ? juliaRe : re;
    const cIm = isJulia ? juliaIm : im;
    const power = Number.isFinite(multibrotPower) ? multibrotPower : 2.0;
    const negativeMultibrotMandelbrot = fractalType === 0 && power < 0 && !isJulia;
    if (negativeMultibrotMandelbrot) {
        zRe = re;
        zIm = im;
    }

    for (let iter = 0; iter < maxIter; iter++) {
        const x2 = zRe * zRe;
        const y2 = zIm * zIm;
        if (x2 + y2 > 4) {
            return {inside: false, escapeIter: iter};
        }

        if (fractalType === 1) {
            zIm = 2 * Math.abs(zRe) * Math.abs(zIm) + cIm;
            zRe = x2 - y2 + cRe;
        } else if (fractalType === 2) {
            zIm = -2 * zRe * zIm + cIm;
            zRe = x2 - y2 + cRe;
        } else {
            const [powRe, powIm] = computeComplexPower(zRe, zIm, power);
            zRe = powRe + cRe;
            zIm = powIm + cIm;
        }
    }

    return {inside: true, escapeIter: maxIter};
}

export function computeOrbitPoints(
    seed: ComplexPoint,
    view: Pick<ViewState, 'maxIter' | 'juliaRe' | 'juliaIm' | 'isJulia' | 'multibrotPower' | 'fractalType'>
): ComplexPoint[] {
    const orbit: ComplexPoint[] = [];
    const maxIter = Math.max(32, Math.min(4000, view.maxIter));
    const juliaRe = Number.parseFloat(view.juliaRe) || 0;
    const juliaIm = Number.parseFloat(view.juliaIm) || 0;
    const power = Number.isFinite(view.multibrotPower) ? view.multibrotPower : 2.0;
    const negativeMultibrotMandelbrot = view.fractalType === 0 && power < 0 && !view.isJulia;
    let zRe = view.isJulia || negativeMultibrotMandelbrot ? seed.re : 0;
    let zIm = view.isJulia || negativeMultibrotMandelbrot ? seed.im : 0;
    const cRe = view.isJulia ? juliaRe : seed.re;
    const cIm = view.isJulia ? juliaIm : seed.im;

    orbit.push({re: zRe, im: zIm});

    for (let iter = 0; iter < maxIter; iter++) {
        if (zRe * zRe + zIm * zIm > 4) break;

        if (view.fractalType === 1) {
            const aRe = Math.abs(zRe);
            const aIm = Math.abs(zIm);
            const nextRe = aRe * aRe - aIm * aIm + cRe;
            const nextIm = 2 * aRe * aIm + cIm;
            zRe = nextRe;
            zIm = nextIm;
        } else if (view.fractalType === 2) {
            const nextRe = zRe * zRe - zIm * zIm + cRe;
            const nextIm = -2 * zRe * zIm + cIm;
            zRe = nextRe;
            zIm = nextIm;
        } else {
            const [powRe, powIm] = computeComplexPower(zRe, zIm, power);
            zRe = powRe + cRe;
            zIm = powIm + cIm;
        }

        orbit.push({re: zRe, im: zIm});
    }

    return orbit;
}

export function buildEscapeGuidedPath(
    start: ComplexPoint,
    end: ComplexPoint,
    options: {
        view: Pick<ViewState, 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'maxIter' | 'multibrotPower' | 'fractalType'>;
        canvasWidth: number;
        canvasHeight: number;
    }
): ComplexPoint[] {
    const dXMin = qdFromString(options.view.xMin);
    const dXMax = qdFromString(options.view.xMax);
    const dYMin = qdFromString(options.view.yMin);
    const dYMax = qdFromString(options.view.yMax);
    const xRange = Math.abs(qdHi(qdSub(dXMax, dXMin)));
    const yRange = Math.abs(qdHi(qdSub(dYMax, dYMin)));
    const maxIter = Math.max(128, Math.min(4000, options.view.maxIter));

    const dx = end.re - start.re;
    const dy = end.im - start.im;
    const len = Math.hypot(dx, dy);
    if (len <= Number.EPSILON) return [start, end];

    const steps = Math.max(48, Math.min(220, Math.round(options.canvasWidth / 10)));
    const points: ComplexPoint[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        points.push({
            re: start.re + dx * t,
            im: start.im + dy * t,
        });
    }

    const baseStep = Math.max(xRange, yRange) * 0.0008;

    function isInteriorPoint(point: ComplexPoint): boolean {
        return estimateEscapeSample(
            point.re,
            point.im,
            maxIter,
            options.view.fractalType,
            0,
            0,
            false,
            options.view.multibrotPower
        ).inside;
    }

    function segmentStaysInterior(a: ComplexPoint, b: ComplexPoint): boolean {
        const samples = [0.2, 0.4, 0.5, 0.6, 0.8];
        for (const t of samples) {
            const probe = {
                re: a.re + (b.re - a.re) * t,
                im: a.im + (b.im - a.im) * t,
            };
            if (!isInteriorPoint(probe)) return false;
        }
        return true;
    }

    function screenDistance(a: ComplexPoint, b: ComplexPoint): number {
        const sx = Math.abs((b.re - a.re) / Math.max(xRange, 1e-18)) * options.canvasWidth;
        const sy = Math.abs((b.im - a.im) / Math.max(yRange, 1e-18)) * options.canvasHeight;
        return Math.hypot(sx, sy);
    }

    function chooseInteriorCandidate(
        target: ComplexPoint,
        prev: ComplexPoint,
        next: ComplexPoint,
        guideRe: number,
        guideIm: number
    ): ComplexPoint {
        const tx = next.re - prev.re;
        const ty = next.im - prev.im;
        const tLen = Math.hypot(tx, ty) || 1;
        const nx = -ty / tLen;
        const ny = tx / tLen;
        const txu = tx / tLen;
        const tyu = ty / tLen;

        let bestPoint: ComplexPoint | null = null;
        let bestScore = Infinity;

        for (let ring = 1; ring <= 18; ring++) {
            const radius = baseStep * ring;
            for (let a = -3; a <= 3; a++) {
                for (let b = -3; b <= 3; b++) {
                    const candRe = target.re + nx * radius * a + txu * radius * b * 0.35;
                    const candIm = target.im + ny * radius * a + tyu * radius * b * 0.35;
                    const candidate = {re: candRe, im: candIm};
                    if (!isInteriorPoint(candidate)) continue;

                    const guideDist = Math.hypot(candidate.re - guideRe, candidate.im - guideIm) / Math.max(baseStep, 1e-18);
                    const continuityDist =
                        Math.hypot(candidate.re - prev.re, candidate.im - prev.im) +
                        Math.hypot(candidate.re - next.re, candidate.im - next.im);
                    const score = guideDist * 0.7 + continuityDist * 0.3;

                    if (score < bestScore) {
                        bestScore = score;
                        bestPoint = candidate;
                    }
                }
            }

            if (bestPoint) return bestPoint;
        }

        return target;
    }

    for (let pass = 0; pass < 10; pass++) {
        for (let i = 1; i < points.length - 1; i++) {
            const prev = points[i - 1];
            const next = points[i + 1];
            const cur = points[i];

            const linearT = i / steps;
            const guideRe = start.re + dx * linearT;
            const guideIm = start.im + dy * linearT;

            const projected = {
                re: cur.re + (guideRe - cur.re) * 0.35,
                im: cur.im + (guideIm - cur.im) * 0.35,
            };

            points[i] = chooseInteriorCandidate(projected, prev, next, guideRe, guideIm);
        }
    }

    function refineInteriorPolyline(input: ComplexPoint[]): ComplexPoint[] {
        const output: ComplexPoint[] = [input[0]];
        const maxDepth = 10;

        function appendSegment(a: ComplexPoint, b: ComplexPoint, depth: number): void {
            if (depth >= maxDepth || (screenDistance(a, b) <= 1.4 && segmentStaysInterior(a, b))) {
                output.push(b);
                return;
            }

            const mid = {
                re: (a.re + b.re) * 0.5,
                im: (a.im + b.im) * 0.5,
            };

            if (!isInteriorPoint(mid)) {
                const snapped = chooseInteriorCandidate(mid, a, b, mid.re, mid.im);
                if (snapped.re !== mid.re || snapped.im !== mid.im) {
                    appendSegment(a, snapped, depth + 1);
                    appendSegment(snapped, b, depth + 1);
                    return;
                }
            }

            appendSegment(a, mid, depth + 1);
            appendSegment(mid, b, depth + 1);
        }

        for (let i = 1; i < input.length; i++) {
            appendSegment(input[i - 1], input[i], 0);
        }

        return output;
    }

    points[0] = start;
    points[points.length - 1] = end;
    return refineInteriorPolyline(points);
}

export function qdPointToNumber(point: [QD, QD]): ComplexPoint {
    return {re: qdHi(point[0]), im: qdHi(point[1])};
}
