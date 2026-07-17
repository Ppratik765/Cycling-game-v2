/* ============================================================
 *  TerrainBackdrop.js
 *  A large cylinder with noise-displaced top rim to simulate
 *  distant mountains. Follows the camera for parallax.
 * ============================================================ */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

export class TerrainBackdrop {
  /**
   * @param {object}     opts
   * @param {THREE.Scene} opts.scene
   * @param {number}     opts.radius    - Cylinder radius
   * @param {number}     opts.height    - Cylinder height above ground
   * @param {number}     opts.segments  - Radial segments
   * @param {number}     opts.seed      - Noise seed
   */
  constructor({ 
    scene, 
    diffuseMap, 
    normalMap, 
    roughnessMap,
    radius = 800, 
    height = 200, 
    segments = 64, 
    seed = 77 
  }) {
    this.scene = scene;

    // Simple seeded PRNG
    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    // Open-ended cylinder: no top cap, no bottom cap
    const geo = new THREE.CylinderGeometry(
      radius,    // radiusTop
      radius,    // radiusBottom
      height,    // height
      segments,  // radialSegments
      16,        // heightSegments (increased for smoother mesh)
      true       // openEnded
    );

    const posAttr = geo.attributes.position;

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      if (y > 0) {
        // Top vertices → displace upward with noise (mountain peaks)
        const angle = Math.atan2(z, x);
        const peakNoise = noise(angle * 2.0, 0.0) * 60 +
                          noise(angle * 5.0, 1.0) * 25;
        posAttr.setY(i, y + Math.max(peakNoise, 0));
      } else {
        // Bottom vertices → push well below ground
        posAttr.setY(i, -100);
      }
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    // Configure texture wrapping for the huge cylinder
    [diffuseMap, normalMap, roughnessMap].forEach(tex => {
      if (tex) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(30, 10);
      }
    });

    const mat = new THREE.MeshStandardMaterial({
      map: diffuseMap,
      normalMap: normalMap,
      roughnessMap: roughnessMap,
      color: 0xffffff, // Pure white so textures show correctly
      roughness: 0.9,
      metalness: 0.0,
      flatShading: false,
      side: THREE.BackSide, // We are inside the cylinder looking out
      fog: true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
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
