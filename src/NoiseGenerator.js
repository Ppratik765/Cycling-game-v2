/* ============================================================
 *  NoiseGenerator.js
 *  Deterministic 2D simplex noise — 3 octaves for smooth terrain.
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
  constructor({ seed = 42 } = {}) {
    this.noise2D = createNoise2D(mulberry32(seed));
  }

  /** Sample terrain height at world position (x, z). */
  getHeight(x, z) {
    // 1. Macro hills — large, gentle rolling terrain
    const macro = this.noise2D(x * 0.0008, z * 0.0008) * 45.0;

    // 2. Low-frequency variation — medium undulation
    const low = this.noise2D(x * 0.004, z * 0.004) * 18.0;

    // 3. High-frequency bumps — subtle surface texture (exactly 0.5)
    const bump = this.noise2D(x * 0.08, z * 0.08) * 0.5;

    return macro + low + bump;
  }
}
