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
    segments = 144,
    seed = 77
  }) {
    this.scene = scene;

    // Simple seeded PRNG
    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    // Open-ended cylinder with refined radial resolution for an elegant, smooth silhouette
    const geo = new THREE.CylinderGeometry(
      radius,  // radiusTop
      radius,  // radiusBottom
      height,  // height
      segments, // radialSegments
      16,      // heightSegments
      true     // openEnded
    );

    const posAttr = geo.attributes.position;

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      const angle = Math.atan2(z, x);
      // Seamless circular coordinates (u, v) ensure zero vertical seams around the 360° ring
      const u = Math.cos(angle);
      const v = Math.sin(angle);
      
      // Elegant Middle-Ground Peaks: Slightly smaller than original (85m max vs 115m), maintaining a clean, dignified silhouette
      const peakNoise =
        noise(u * 2.0, v * 2.0) * 55.0 +
        noise(u * 6.0, v * 6.0) * 22.0 +
        noise(u * 14.0, v * 14.0) * 8.0;

      // Subtle, tasteful depth & ravines (~80m variance) so it doesn't look like a flat circular wall
      const depthVariation = 
        noise(u * 3.0, v * 3.0) * 50.0 + 
        noise(u * 8.0, y * 0.005) * 22.0 + 
        noise(u * 16.0, y * 0.01)  * 10.0;

      // Only displace upper body strongly, keeping base cylinder buried smoothly below terrain
      const heightNorm = (y + height / 2) / height; 
      
      // Allow gentle, natural valley dips down to -30m instead of clamping flat to zero (which created horizontal wall edges!)
      const finalElevation = Math.max(-30.0, peakNoise);
      posAttr.setY(i, y + finalElevation * heightNorm);
      
      const currentRadius = Math.sqrt(x * x + z * z);
      const newRadius = currentRadius + depthVariation * heightNorm;
      
      posAttr.setX(i, Math.cos(angle) * newRadius);
      posAttr.setZ(i, Math.sin(angle) * newRadius);
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    // ── Rock cliff texture (replaces the old grass texture) ──
    const texLoader = new THREE.TextureLoader();
    const map = texLoader.load('/textures/rock_cliff_diffuse.png');
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(24, 2); // 1:1 aspect ratio to prevent horizontal stretching
    map.colorSpace = THREE.SRGBColorSpace;

    // ── Fog color uniform — synced from main.js after HDRI loads ──
    this._fogColorUniform = { value: new THREE.Color(scene.fog ? scene.fog.color : 0xb5b9bc) };

    // Lit material so sunLight gives the ridgeline real shadow definition
    const mat = new THREE.MeshStandardMaterial({
      map: map,
      color: 0xa39281,     // Warm earthy tint to restore the brown mountain look
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.BackSide,
      fog: false,           // Use custom distance haze below instead of built-in fog which swallows it completely
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

  /** Call each frame — follows player/camera world X, Z for infinite horizon parallax so you never ride through mountains. */
  update(target) {
    if (target && (target.isCamera || target.isObject3D)) {
      const worldPos = new THREE.Vector3();
      target.getWorldPosition(worldPos);
      this.mesh.position.x = worldPos.x;
      this.mesh.position.z = worldPos.z;
    } else if (target && target.x !== undefined && target.z !== undefined) {
      this.mesh.position.x = target.x;
      this.mesh.position.z = target.z;
    }
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
