/* ============================================================
 *  TerrainBackdrop.js
 *  A large cylinder with noise-displaced top rim to simulate
 *  distant mountains. Uses vertex colors to fade into fog.
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
    const colorData = new Float32Array(posAttr.count * 3);
    
    // The fog color we want the bottom to fade into
    const fogColor = new THREE.Color('#b5b9bc');
    // A slightly atmospheric tinted white for the peaks
    const peakColor = new THREE.Color('#e0e6ed');

    for (let i = 0; i < posAttr.count; i++) {
      let y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      if (y > 0) {
        const angle = Math.atan2(z, x);
        const peakNoise =
          noise(angle * 2.0, 0.0) * 60 +
          noise(angle * 5.0, 1.0) * 25;
        y = y + Math.max(peakNoise, 0);
        posAttr.setY(i, y);
      } else {
        y = -200;
        posAttr.setY(i, y); // Push well below ground to hide gaps
      }

      // Calculate vertex color based on height
      // Bottom (-200) is 100% fog color. Peaks (>0) approach peakColor.
      const normalizedHeight = Math.max(0, Math.min(1, (y + 200) / 400));
      const vertexColor = fogColor.clone().lerp(peakColor, normalizedHeight);
      
      colorData[i * 3] = vertexColor.r;
      colorData[i * 3 + 1] = vertexColor.g;
      colorData[i * 3 + 2] = vertexColor.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    const texLoader = new THREE.TextureLoader();
    const map = texLoader.load('/textures/ground_grass_diffuse.jpg');
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(60, 10);
    map.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshStandardMaterial({
      map: map,
      side: THREE.BackSide,
      vertexColors: true, // Use the colors we calculated to fade into the fog
      fog: false,         // Disable global scene fog so it doesn't wash out completely
      roughness: 0.9,
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
