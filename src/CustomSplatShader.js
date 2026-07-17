import * as THREE from 'three';

export function createSplatMaterial({
  grassDiffuse,
  grassNormal,
  grassRough,
  dirtDiffuse,
  dirtNormal,
  dirtRough,
  renderer,
}) {
  const REPEAT = 12;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  [grassDiffuse, grassNormal, grassRough, dirtDiffuse, dirtNormal, dirtRough].forEach((tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(REPEAT, REPEAT);
    tex.anisotropy = maxAniso;
  });

  grassDiffuse.colorSpace = THREE.SRGBColorSpace;
  dirtDiffuse.colorSpace = THREE.SRGBColorSpace;
  grassNormal.colorSpace = THREE.LinearSRGBColorSpace;
  grassRough.colorSpace = THREE.LinearSRGBColorSpace;
  dirtNormal.colorSpace = THREE.LinearSRGBColorSpace;
  dirtRough.colorSpace = THREE.LinearSRGBColorSpace;

  const mat = new THREE.MeshStandardMaterial({
    map: grassDiffuse,
    normalMap: grassNormal,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap: grassRough,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false,
    side: THREE.FrontSide,
  });

  mat.userData.uniforms = {
    map2: { value: dirtDiffuse },
    normalMap2: { value: dirtNormal },
    roughnessMap2: { value: dirtRough },
  };

  // ── Vertex shader: infinite meandering trail via math ──────
  const vertexShaderPars = `
varying vec3 vWorldPos;
varying float vTrailMix;
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.989, 78.233))) * 43758.54);
}
float getDistanceToTrail(vec2 p) {
    // Infinite sinusoidal curve meandering along Z
    float curveX = sin(p.y * 0.015) * 20.0 + sin(p.y * 0.005) * 40.0;
    return abs(p.x - curveX);
}`;

  const vertexShaderMain = `
#include <worldpos_vertex>
vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
float dist = getDistanceToTrail(vWorldPos.xz);
float edgeNoise = (hash(vWorldPos.xz * 0.5) - 0.5) * 1.5;
vTrailMix = 1.0 - smoothstep(7.0 + edgeNoise, 12.0 + edgeNoise, dist);
`;

  // ── Fragment shader: blend dirt textures by vTrailMix ──────
  const fragmentShaderPars = `
varying vec3 vWorldPos;
varying float vTrailMix;
uniform sampler2D map2;
uniform sampler2D normalMap2;
uniform sampler2D roughnessMap2;
`;

  const fragmentShaderMap = `
#include <map_fragment>
    vec4 dirtColor = texture2D(map2, vMapUv);
    diffuseColor = mix(diffuseColor, dirtColor, vTrailMix);
`;

  const fragmentShaderNormal = `
#include <normal_fragment_maps>
    vec3 dirtNormal = texture2D(normalMap2, vNormalMapUv).xyz * 2.0 - 1.0;
    normal = normalize(mix(normal, dirtNormal, vTrailMix));
`;

  const fragmentShaderRoughness = `
#include <roughnessmap_fragment>
    float dirtRoughness = texture2D(roughnessMap2, vRoughnessMapUv).g;
    roughnessFactor = mix(roughnessFactor, dirtRoughness, vTrailMix);
`;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\n' + vertexShaderPars
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      vertexShaderMain
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\n' + fragmentShaderPars
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      fragmentShaderMap
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      fragmentShaderNormal
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      fragmentShaderRoughness
    );
  };

  mat.customProgramCacheKey = () => 'splatTerrain_v4_infinite';

  return mat;
}
