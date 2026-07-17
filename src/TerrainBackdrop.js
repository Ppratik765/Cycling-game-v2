/* ============================================================
 *  TerrainBackdrop.js
 *  A sweeping valley bowl that connects the central terrain chunks
 *  to distant procedural mountains. Uses realistic brown/green
 *  vertex colors to match the terrain.
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

    // We use a cylinder as a base, but we will deform all vertices
    // to form a sweeping bowl/valley shape.
    const geo = new THREE.CylinderGeometry(
      radius,    // top radius (will be modified)
      radius,    // bottom radius (will be modified)
      height,    // height (Y from -height/2 to height/2)
      segments,
      32,        // more height segments for a smooth sweeping curve
      true
    );

    const posAttr = geo.attributes.position;
    
    // We will build an array for vertex colors
    const colors = new Float32Array(posAttr.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Realistic dry grass / mountain colors to match the brown-green terrain
    const colorPeak = new THREE.Color(0x615b50); // Dry rock / distant brown peak
    const colorMid  = new THREE.Color(0x596347); // Olive / dry grass
    const colorBase = new THREE.Color(0x4a523a); // Darker olive green at the valley floor

    const tempColor = new THREE.Color();

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      // Normalize original Y from [-100, 100] to [0, 1]
      // 0 = bottom edge (connecting to chunks), 1 = top edge (mountain peaks)
      const v = THREE.MathUtils.clamp((y - (-height / 2)) / height, 0, 1);

      // Angle for circular shaping
      const angle = Math.atan2(z, x);

      // 1. Calculate the sweeping radius
      // At v=0 (bottom), radius is 90 (just under the 3x3 chunks which span ~96 radius)
      // At v=1 (top), radius is 800
      // We use v^2 to create a gentle curve that goes out before going up
      const rCurve = Math.pow(v, 1.5);
      const currentRadius = THREE.MathUtils.lerp(90, radius, rCurve);

      // 2. Calculate the sweeping height (finalY)
      // Base is slightly below ground (-5) to hide seams
      // Top goes up to 150 + noise
      const peakNoise =
        noise(angle * 2.0, 0.0) * 60 +
        noise(angle * 5.0, 1.0) * 25 +
        noise(angle * 12.0, 2.0) * 10;
        
      const topHeight = 100 + Math.max(peakNoise, 0);
      
      // We use a steeper power curve for Y so the ground stays relatively flat 
      // near the chunks before ramping up into mountains
      const yCurve = Math.pow(v, 3.0);
      const finalY = THREE.MathUtils.lerp(-5, topHeight, yCurve);

      // Apply the new position
      const finalX = Math.cos(angle) * currentRadius;
      const finalZ = Math.sin(angle) * currentRadius;
      
      posAttr.setX(i, finalX);
      posAttr.setY(i, finalY);
      posAttr.setZ(i, finalZ);

      // 3. Apply vertex colors based on the normalized height 'v'
      if (v > 0.6) {
        // Peaks to Mid
        const t = THREE.MathUtils.clamp((v - 0.6) / 0.4, 0, 1);
        tempColor.lerpColors(colorMid, colorPeak, t);
      } else {
        // Mid to Base
        const t = THREE.MathUtils.clamp(v / 0.6, 0, 1);
        tempColor.lerpColors(colorBase, colorMid, t);
      }

      // Add a tiny bit of noise to the color to break up smooth gradients
      const colorNoise = noise(finalX * 0.1, finalZ * 0.1) * 0.03;
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
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true, // Low-poly flat shading looks great on procedural terrain
      side: THREE.BackSide,
      fog: true, // Re-enable fog so it blends naturally into the sky
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
