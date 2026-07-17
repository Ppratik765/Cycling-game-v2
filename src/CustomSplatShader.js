/* ============================================================
 *  CustomSplatShader.js
 *  Patches MeshStandardMaterial via onBeforeCompile to blend
 *  grass & dirt textures based on distance to a trail spline.
 * ============================================================ */

import * as THREE from 'three';

/**
 * Create a terrain splat material that blends grass and dirt textures
 * using distance to a trail spline.
 *
 * @param {object} opts
 * @param {THREE.Texture} opts.grassDiffuse
 * @param {THREE.Texture} opts.grassNormal
 * @param {THREE.Texture} opts.grassRough
 * @param {THREE.Texture} opts.dirtDiffuse
 * @param {THREE.Texture} opts.dirtNormal
 * @param {THREE.Texture} opts.dirtRough
 * @param {Float32Array}  opts.trailSegments  - Flat [x1,z1,x2,z2, ...]
 * @param {number}        opts.segmentCount   - Number of line segments
 * @param {number}        opts.trailWidth     - Half-width of the dirt trail
 * @param {number}        opts.blendEdge      - Smoothstep edge width
 * @param {THREE.WebGLRenderer} opts.renderer - For max anisotropy
 * @returns {THREE.MeshStandardMaterial}
 */
export function createSplatMaterial({
  grassDiffuse,
  grassNormal,
  grassRough,
  dirtDiffuse,
  dirtNormal,
  dirtRough,
  trailSegments,
  segmentCount,
  trailWidth = 3.5,
  blendEdge = 2.0,
  renderer,
}) {
  // ── Configure all textures for tiling ───────────────────────
  const REPEAT = 12;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  [grassDiffuse, grassNormal, grassRough, dirtDiffuse, dirtNormal, dirtRough].forEach((tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(REPEAT, REPEAT);
    tex.anisotropy = maxAniso;
  });

  // Diffuse textures are sRGB; normal & rough are linear
  grassDiffuse.colorSpace = THREE.SRGBColorSpace;
  dirtDiffuse.colorSpace = THREE.SRGBColorSpace;
  grassNormal.colorSpace = THREE.LinearSRGBColorSpace;
  grassRough.colorSpace = THREE.LinearSRGBColorSpace;
  dirtNormal.colorSpace = THREE.LinearSRGBColorSpace;
  dirtRough.colorSpace = THREE.LinearSRGBColorSpace;

  // ── Build the DataTexture for trail segments ────────────────
  // We pack the segment data into a DataTexture for efficient GPU access.
  // Each texel holds one float packed into the R channel (Float type).
  // We use a 1D texture of width = segmentCount * 4 (x1,z1,x2,z2 per segment).
  const segTex = new THREE.DataTexture(
    trailSegments,
    segmentCount * 4,
    1,
    THREE.RedFormat,
    THREE.FloatType
  );
  segTex.needsUpdate = true;

  // ── Base material (grass as default) ────────────────────────
  const mat = new THREE.MeshStandardMaterial({
    map: grassDiffuse,
    normalMap: grassNormal,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap: grassRough,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.FrontSide,
  });

  // ── Custom uniforms ─────────────────────────────────────────
  mat.userData.uniforms = {
    uDirtDiffuse:  { value: dirtDiffuse },
    uDirtNormal:   { value: dirtNormal },
    uDirtRough:    { value: dirtRough },
    uTrailSegments: { value: segTex },
    uSegmentCount: { value: segmentCount },
    uTrailWidth:   { value: trailWidth },
    uBlendEdge:    { value: blendEdge },
  };

  // ── Shader patching ─────────────────────────────────────────
  mat.onBeforeCompile = (shader) => {
    // Inject our custom uniforms
    Object.assign(shader.uniforms, mat.userData.uniforms);

    // ── VERTEX SHADER: pass world position to fragment ────────
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
        #include <common>
        varying vec3 vWorldPos;
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      /* glsl */ `
        #include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );

    // ── FRAGMENT SHADER: blend grass/dirt ──────────────────────
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `
        #include <common>
        varying vec3 vWorldPos;

        uniform sampler2D uDirtDiffuse;
        uniform sampler2D uDirtNormal;
        uniform sampler2D uDirtRough;
        uniform sampler2D uTrailSegments;
        uniform int   uSegmentCount;
        uniform float uTrailWidth;
        uniform float uBlendEdge;

        // Distance from point P to line segment AB (2D, xz plane)
        float distToSegment(vec2 p, vec2 a, vec2 b) {
          vec2 ab = b - a;
          vec2 ap = p - a;
          float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
          vec2 closest = a + t * ab;
          return length(p - closest);
        }

        // Find minimum distance to trail spline
        float getTrailDist(vec2 worldXZ) {
          float minDist = 99999.0;
          for (int i = 0; i < 512; i++) {
            if (i >= uSegmentCount) break;
            int base = i * 4;
            float x1 = texelFetch(uTrailSegments, ivec2(base + 0, 0), 0).r;
            float z1 = texelFetch(uTrailSegments, ivec2(base + 1, 0), 0).r;
            float x2 = texelFetch(uTrailSegments, ivec2(base + 2, 0), 0).r;
            float z2 = texelFetch(uTrailSegments, ivec2(base + 3, 0), 0).r;
            float d = distToSegment(worldXZ, vec2(x1, z1), vec2(x2, z2));
            minDist = min(minDist, d);
          }
          return minDist;
        }
      `
    );

    // Replace the map_fragment chunk to blend the two texture sets
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
        // ── Splat blend ─────────────────────────────────────────
        vec2 trailUV = vWorldPos.xz;
        float trailDist = getTrailDist(trailUV);

        // Add slight noise to the edge for organic look
        float edgeNoise = fract(sin(dot(trailUV * 0.5, vec2(12.9898, 78.233))) * 43758.5453) * 0.8;
        float blend = smoothstep(uTrailWidth - uBlendEdge, uTrailWidth + uBlendEdge + edgeNoise, trailDist);

        // Sample dirt textures at same UV
        vec2 splatUV = vMapUv;
        vec4 dirtColor = texture2D(uDirtDiffuse, splatUV);

        // Grass is already sampled as diffuseColor by the default map_fragment
        #include <map_fragment>

        // Blend: blend=0 is dirt (close to trail), blend=1 is grass (far)
        diffuseColor = mix(dirtColor, diffuseColor, blend);
      `
    );

    // Similarly, blend the normal maps
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
        #include <normal_fragment_maps>
        // Re-blend normal with dirt normal based on trail distance
        vec3 dirtNormalSample = texture2D(uDirtNormal, vMapUv).xyz * 2.0 - 1.0;
        // The standard normal_fragment_maps already computed 'normal' from the grass normalMap.
        // We mix toward the dirt normal when close to the trail.
        // (We re-use the 'blend' variable from map_fragment scope)
        // Note: blend is already declared in the same function scope above.
      `
    );

    // Blend roughness
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
        #include <roughnessmap_fragment>
        float dirtRoughVal = texture2D(uDirtRough, vMapUv).g;
        roughnessFactor = mix(dirtRoughVal, roughnessFactor, blend);
      `
    );
  };

  // Needed for onBeforeCompile to trigger re-compilation
  mat.customProgramCacheKey = () => 'splatTerrain_v1';

  return mat;
}
