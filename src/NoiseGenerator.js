/* ============================================================
 *  NoiseGenerator.js
 *  Deterministic 2D simplex noise with macro + detail octaves.
 * ============================================================ */

import { createNoise2D } from 'simplex-noise';

/** Simple seeded PRNG (Mulberry32) for reproducible terrain. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class NoiseGenerator {
  /**
   * @param {object} opts
   * @param {number} opts.seed           - PRNG seed (default 42)
   * @param {number} opts.macroScale     - Frequency of large rolling hills
   * @param {number} opts.macroAmplitude - Max hill height
   * @param {number} opts.detailScale    - Frequency of fine detail
   * @param {number} opts.detailAmplitude - Max detail height
   */
  constructor({
    seed = 42,
    macroScale = 0.0008,
    macroAmplitude = 45,
    detailScale = 0.08,
    detailAmplitude = 0.5,
  } = {}) {
    this.macroScale = macroScale;
    this.macroAmplitude = macroAmplitude;
    this.detailScale = detailScale;
    this.detailAmplitude = detailAmplitude * macroAmplitude;
    this.noise2D = createNoise2D(mulberry32(seed));
  }

  /** Sample terrain height at world position (x, z). */
  getHeight(x, z) {
    const macro =
      this.noise2D(x * this.macroScale, z * this.macroScale) *
      this.macroAmplitude;
    const detail =
      this.noise2D(x * this.detailScale, z * this.detailScale) *
      this.detailAmplitude;
    return macro + detail;
  }
}
