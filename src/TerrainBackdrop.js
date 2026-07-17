/* ============================================================
 *  TerrainBackdrop.js
 *  A large cylinder with noise-displaced top rim to simulate
 *  distant mountains. Uses height-based vertex colors for a
 *  photorealistic, massive scale look instead of textures.
 * ============================================================ */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

export class TerrainBackdrop {
  constructor({
    scene,
    radius = 800,
    height = 200,
    segments = 64,
    seed = 77
  }) {
    this.scene = scene;

    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    const geo = new THREE.CylinderGeometry(
      radius,
      radius,
      height,
      segments,
      16,
      true
    );

    const posAttr = geo.attributes.position;
    
    // We will build an array for vertex colors
    const colors = new Float32Array(posAttr.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Define colors for the biome gradient
    const colorSnow = new THREE.Color(0xdbe9f4);   // Crisp snowy peak
    const colorRock = new THREE.Color(0x4a5359);   // Slate gray rock
    const colorForest = new THREE.Color(0x182e22); // Deep distant pine green
    const colorFog = new THREE.Color(0x8cb8d4);    // Fog color for the deep base

    const tempColor = new THREE.Color();

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      let finalY = y;

      if (y > 0) {
        // Displace the top half to create peaks
        const angle = Math.atan2(z, x);
        const peakNoise =
          noise(angle * 2.0, 0.0) * 60 +
          noise(angle * 5.0, 1.0) * 25 +
          noise(angle * 12.0, 2.0) * 10; // Extra detail octave
        
        finalY = y + Math.max(peakNoise, 0);
        posAttr.setY(i, finalY);
      } else {
        finalY = -100;
        posAttr.setY(i, finalY);
      }

      // Height-based coloring for scale realism
      if (finalY > 75) {
        // Snow to rock
        const t = THREE.MathUtils.clamp((finalY - 75) / 25, 0, 1);
        tempColor.lerpColors(colorRock, colorSnow, t);
      } else if (finalY > 30) {
        // Rock to forest
        const t = THREE.MathUtils.clamp((finalY - 30) / 45, 0, 1);
        tempColor.lerpColors(colorForest, colorRock, t);
      } else {
        // Forest fading into atmospheric fog color at the bottom
        const t = THREE.MathUtils.clamp((finalY - (-50)) / 80, 0, 1);
        tempColor.lerpColors(colorFog, colorForest, t);
      }

      // Add a tiny bit of noise to the color for texture
      const colorNoise = noise(x * 0.1, z * 0.1) * 0.05;
      tempColor.r = THREE.MathUtils.clamp(tempColor.r + colorNoise, 0, 1);
      tempColor.g = THREE.MathUtils.clamp(tempColor.g + colorNoise, 0, 1);
      tempColor.b = THREE.MathUtils.clamp(tempColor.b + colorNoise, 0, 1);

      colors[i * 3 + 0] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    // Use MeshStandardMaterial with vertexColors enabled
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.8,
      metalness: 0.1, // Slight metalness gives rock a nice specular bounce
      flatShading: false,
      side: THREE.BackSide,
      fog: false, // We manually fade into fog color at the base
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.scene.add(this.mesh);
  }

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
