/* ============================================================
 *  TerrainBackdrop.js
 *  A large cylinder with noise-displaced top rim to simulate
 *  distant mountains. Uses rock texture + lit material with
 *  distance-based atmospheric haze synced to scene fog color.
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

    // ── Rock cliff texture (replaces the old grass texture) ──
    const texLoader = new THREE.TextureLoader();
    const map = texLoader.load('/textures/rock_cliff_diffuse.png');
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(16, 6); // Rock texture repeat for the large cylinder
    map.colorSpace = THREE.SRGBColorSpace;

    // ── Fog color uniform — synced from main.js after HDRI loads ──
    this._fogColorUniform = { value: new THREE.Color(scene.fog ? scene.fog.color : 0xb5b9bc) };

    // Lit material so sunLight gives the ridgeline real shadow definition
    const mat = new THREE.MeshStandardMaterial({
      map: map,
      color: 0x8a8a8a,     // Neutral grey tint to let the rock texture drive color
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.BackSide,
      fog: true,            // Participate in scene.fog instead of faking it
    });

    // Inject distance-based atmospheric haze in fragment shader
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFogColor = this._fogColorUniform;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform vec3 uFogColor;
`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        // Distance-based atmospheric haze — nearer base is clearer, upper ridgeline fades
        float vHeight = vViewPosition.y;
        float distFactor = clamp(length(vViewPosition) / 900.0, 0.0, 1.0);
        float heightFade = smoothstep(-100.0, 250.0, vHeight) * 0.2;
        float hazeMix = distFactor * 0.55 + heightFade;
        hazeMix = clamp(hazeMix, 0.0, 0.75);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, hazeMix);
        `
      );
    };

    mat.customProgramCacheKey = () => 'terrain_backdrop_rock_haze';

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = false;
    this.mesh.castShadow    = false;
    this.mesh.position.y    = -50; // Bury the base so no gap appears below terrain
    this.scene.add(this.mesh);
  }

  /** Sync the haze color with the current scene fog color */
  syncFogColor(color) {
    this._fogColorUniform.value.copy(color);
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
