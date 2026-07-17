/* ============================================================
 *  TrailSpline.js
 *  Generates a Catmull-Rom spline wandering down the -Z axis
 *  to serve as the dirt trail path.
 * ============================================================ */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

export class TrailSpline {
  /**
   * @param {object}  opts
   * @param {number}  opts.length        - How far down -Z the trail extends
   * @param {number}  opts.spacing       - Distance between control points
   * @param {number}  opts.wanderScale   - Max lateral (X) displacement
   * @param {number}  opts.seed          - PRNG seed
   */
  constructor({
    length = 4000,
    spacing = 40,
    wanderScale = 30,
    seed = 99,
  } = {}) {
    // Simple seeded PRNG
    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    const controlPoints = [];
    const pointCount = Math.ceil(length / spacing);

    for (let i = 0; i <= pointCount; i++) {
      const z = -i * spacing;
      const x = noise(0.003 * z, 0.5) * wanderScale;
      controlPoints.push(new THREE.Vector3(x, 0, z));
    }

    // Build the Catmull-Rom curve
    this.curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.5);

    // Pre-sample the spline into line segments for fast distance queries.
    // More samples = more accurate but slightly heavier uniform.
    this.sampleCount = 512;
    this.segments = this._sampleSegments(this.sampleCount);
  }

  /** Return a flat Float32Array of [x1,z1, x2,z2, ...] segment pairs. */
  getSegmentData() {
    return this.segments;
  }

  /** Return the number of line segments. */
  getSegmentCount() {
    return this.sampleCount;
  }

  // ── internal ────────────────────────────────────────────────

  _sampleSegments(count) {
    const pts = this.curve.getSpacedPoints(count);
    // We store pairs: segment i = pts[i] → pts[i+1]
    // Each segment = 4 floats (x1, z1, x2, z2)
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[i + 1] || pts[i];
      data[i * 4 + 0] = a.x;
      data[i * 4 + 1] = a.z;
      data[i * 4 + 2] = b.x;
      data[i * 4 + 3] = b.z;
    }
    return data;
  }

  _mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
