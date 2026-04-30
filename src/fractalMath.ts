import type {ViewState} from './types';

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

export function stepFractalIteration(
    zRe: number,
    zIm: number,
    cRe: number,
    cIm: number,
    fractalType: number,
    multibrotPower: number
): [number, number] {
    if (fractalType === 1) {
        const aRe = Math.abs(zRe);
        const aIm = Math.abs(zIm);
        return [aRe * aRe - aIm * aIm + cRe, 2 * aRe * aIm + cIm];
    }
    if (fractalType === 2) {
        return [zRe * zRe - zIm * zIm + cRe, -2 * zRe * zIm + cIm];
    }
    const [powRe, powIm] = computeComplexPower(zRe, zIm, multibrotPower);
    return [powRe + cRe, powIm + cIm];
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

        [zRe, zIm] = stepFractalIteration(zRe, zIm, cRe, cIm, fractalType, power);
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

        [zRe, zIm] = stepFractalIteration(zRe, zIm, cRe, cIm, view.fractalType, power);

        orbit.push({re: zRe, im: zIm});
    }

    return orbit;
}
