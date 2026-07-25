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
    segments = 160,
    seed = 77
  }) {
    this.scene = scene;

    // Simple seeded PRNG
    const prng = this._mulberry32(seed);
    const noise = createNoise2D(prng);

    // Open-ended cylinder with high radial resolution for detailed peaks & ridges
    const geo = new THREE.CylinderGeometry(
      radius,  // radiusTop
      radius,  // radiusBottom
      height,  // height
      segments, // radialSegments
      20,      // heightSegments — smooth mesh for gullies and ravines
      true     // openEnded
    );

    const posAttr = geo.attributes.position;

    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);

      const angle = Math.atan2(z, x);
      // Use seamless circular coordinates (u, v) so the 360° panorama matches perfectly without any vertical seams!
      const u = Math.cos(angle);
      const v = Math.sin(angle);
      
      // 1. Continental Range & Valley Pass Envelope (macro cyclic variation around horizon)
      // Generates towering alpine chains in certain sectors and sweeping valley dips in others
      const rangeEnvelope = Math.sin(angle * 1.5 + 0.7) * 0.4 + Math.cos(angle * 2.5 - 1.2) * 0.35 + noise(u * 0.8, v * 0.8) * 0.35;
      const macroScale = Math.max(0.15, Math.min(1.5, 0.75 + rangeEnvelope));

      // 2. Multi-Octave Organic Alpine Peaks
      const peakNoise =
        noise(u * 2.5, v * 2.5) * 65.0 +
        noise(u * 5.0, v * 5.0) * 30.0 +
        noise(u * 11.0, v * 11.0) * 15.0 +
        noise(u * 22.0, v * 22.0) * 7.0;
        
      // 3. Massive Depth & Radial Variance (completely eliminates circular wall effect!)
      // Some mountain ridges advance closer to the player (~540m), while deep valleys recede far into horizon haze (~1060m)
      const depthVariation = 
        noise(u * 1.6 + 10.0, v * 1.6 + 10.0) * 190.0 + 
        noise(u * 4.2 + 5.0,  v * 4.2 + 5.0)  * 70.0 + 
        noise(u * 12.0,       y * 0.01)       * 25.0;   // Vertical cliff ravines & rock face gullies

      // Only displace upper body strongly, keeping base cylinder buried smoothly below terrain
      const heightNorm = (y + height / 2) / height; 
      
      // Apply continental envelope to peak heights; allow sweeping negative dips for open mountain passes!
      const finalElevation = (peakNoise * macroScale) - (1.0 - macroScale) * 50.0;
      posAttr.setY(i, y + finalElevation * heightNorm);
      
      const currentRadius = Math.sqrt(x * x + z * z);
      // Advance or recede mountain faces drastically based on depth variation
      const newRadius = currentRadius + depthVariation * Math.pow(heightNorm, 0.65);
      
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
