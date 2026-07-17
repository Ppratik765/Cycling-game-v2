/* ============================================================
 *  TerrainBackdrop.js
 *  A large cylinder with noise-displaced top rim to simulate
 *  distant mountains. Loads its own textures independently.
 * ============================================================ */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

export class TerrainBackdrop {
  constructor({
    scene,
    radius = 800,
    height = 400,
    segments = 64,
    seed = 77
  }) {
    this.scene = scene;

    // Simple seeded PRNG
    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    // Open-ended cylinder
    const geo = new THREE.CylinderGeometry(
      radius,  // radiusTop
      radius,  // radiusBottom
      height,  // height
      segments, // radialSegments
      16,      // heightSegments — smooth mesh
      true     // openEnded
    );

    const posAttr = geo.attributes.position;

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      if (y > 0) {
        const angle = Math.atan2(z, x);
        const peakNoise =
          noise(angle * 2.0, 0.0) * 60 +
          noise(angle * 5.0, 1.0) * 25;
        posAttr.setY(i, y + Math.max(peakNoise, 0));
      } else {
        posAttr.setY(i, -200); // Push well below ground to hide gaps
      }
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      color: 0x8a8678, // Muted, hazy dirt — blends with overcast fog
      side:  THREE.BackSide,
      fog:   true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow    = false;
    this.mesh.position.y    = -50; // Bury the base so no gap appears below terrain
    this.scene.add(this.mesh);
  }

  /** Call each frame — follows camera X, Z for parallax. */
  update(camera) {
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
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
