/* ============================================================
 *  FoliageSystem.js
 *  High-performance procedural foliage using InstancedMesh.
 *  Textured grass tufts + trees with brown trunks.
 * ============================================================ */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────

const GRASS_PER_CHUNK = 22000;
const PINE_PER_CHUNK = 40;
const BROADLEAF_PER_CHUNK = 20;

const TRAIL_CLEAR = 4.5;
const TRAIL_DENSE = 8.0;

// ── Trail equation (must match CustomSplatShader.js) ─────────
function trailCurveX(z) {
  return Math.sin(z * 0.02) * 25.0 + Math.sin(z * 0.008) * 40.0 + Math.sin(z * 0.05) * 8.0;
}
function distToTrail(x, z) {
  return Math.abs(x - trailCurveX(z));
}

// ── Seeded PRNG ──────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function chunkSeed(cx, cz) {
  return ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
}

// ── Geometry builders ────────────────────────────────────────

/** Pampas Grass Tuft: 3 intersecting tapered blades with slight top curve */
function createPampasTuft() {
  const bladeW = 0.20;
  const bladeH = 1.55;
  const segsH = 6; // Enough vertical segments for smooth bending
  const planes = [];

  for (let i = 0; i < 3; i++) {
    const plane = new THREE.PlaneGeometry(bladeW * 2, bladeH, 1, segsH);

    // Delete UVs — color is fully driven by vertex shader height gradient
    plane.deleteAttribute('uv');

    // Taper the blade: narrow at the top, wider at the base
    const pos = plane.attributes.position.array;
    for (let v = 0; v < pos.length; v += 3) {
      const yNorm = (pos[v + 1] + bladeH / 2) / bladeH; // 0 at base, 1 at tip
      const taper = 1.0 - yNorm * 0.7; // narrows to 30% width at tip
      pos[v] *= taper;
      // Slight forward curve at the top (plume droop)
      if (yNorm > 0.6) {
        const curveFactor = (yNorm - 0.6) / 0.4;
        pos[v + 2] += curveFactor * curveFactor * 0.35;
      }
    }

    plane.rotateY((Math.PI / 3) * i); // 60° apart for 3-way cross

    // Fan outward slightly for volume
    const lean = (i === 0 ? 0.12 : i === 1 ? -0.08 : 0.05);
    plane.rotateX(lean);

    plane.translate(0, bladeH / 2, 0);
    planes.push(plane);
  }

  const merged = mergeGeometries(planes);

  // Override normals to point straight up for terrain-matching shading
  const norms = merged.attributes.normal.array;
  for (let i = 0; i < norms.length; i += 3) {
    norms[i] = 0.0;
    norms[i + 1] = 1.0;
    norms[i + 2] = 0.0;
  }

  return merged;
}

/** Layered pine canopy with fluffed normals */
function createPineCanopy() {
  const planes = [];

  const addLayer = (y, w, h, rotationOffset) => {
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.PlaneGeometry(w, h, 1, 1);
      plane.rotateY((Math.PI / 3) * i + rotationOffset);

      // Slight pitch to make branches droop naturally
      plane.rotateX(0.15);

      plane.translate(0, y, 0);
      planes.push(plane);
    }
  };

  // Stack 4 layers of decreasing size to form a pine profile (widened for cherry blossom look)
  addLayer(13.0, 10.5, 7.0, 0);
  addLayer(17.0, 9.5, 6.0, 0.5);
  addLayer(21.0, 8.0, 5.0, 1.0);
  addLayer(24.5, 6.0, 4.0, 1.5);

  const merged = mergeGeometries(planes);

  // Bend normals outwards and upwards to create soft, fluffy volumetric shading
  const pos = merged.attributes.position.array;
  const norms = merged.attributes.normal.array;
  for (let i = 0; i < norms.length; i += 3) {
    norms[i] = pos[i] * 0.6;
    norms[i + 1] = 1.0;
    norms[i + 2] = pos[i + 2] * 0.6;
    const len = Math.sqrt(norms[i] ** 2 + norms[i + 1] ** 2 + norms[i + 2] ** 2);
    norms[i] /= len; norms[i + 1] /= len; norms[i + 2] /= len;
  }

  return merged;
}

/** Pine trunk */
function createPineTrunk() {
  const trunk = new THREE.CylinderGeometry(0.7, 0.95, 12.0, 5, 1);
  trunk.translate(0, 6.0, 0);
  return trunk;
}

/** Broadleaf canopy with spherical normals */
function createBroadleafCanopy() {
  const planes = [];

  const addCluster = (x, y, z, size, rotOffset) => {
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.PlaneGeometry(size, size, 1, 1);
      plane.rotateY((Math.PI / 3) * i + rotOffset);

      // Randomize pitch/roll slightly for chaotic, organic leaves
      plane.rotateX((Math.random() - 0.5) * 0.5);
      plane.rotateZ((Math.random() - 0.5) * 0.5);

      plane.translate(x, y, z);
      planes.push(plane);
    }
  };

  // Central core
  addCluster(0, 18.5, 0, 13.0, 0);

  // Surrounding fluffy clusters
  const r = 4.0;
  addCluster(r, 17.5, 0, 9.0, 0.5);
  addCluster(-r, 17.5, 0, 9.0, 1.0);
  addCluster(0, 17.5, r, 9.0, 1.5);
  addCluster(0, 17.5, -r, 9.0, 2.0);

  // Top cluster
  addCluster(0, 22.5, 0, 10.0, 2.5);

  const merged = mergeGeometries(planes);

  // Override normals to be spherical, pointing outward from center (0, 14, 0)
  const pos = merged.attributes.position.array;
  const norms = merged.attributes.normal.array;
  for (let i = 0; i < norms.length; i += 3) {
    norms[i] = pos[i];
    norms[i + 1] = pos[i + 1] - 18.5 + 1.0; // point slightly more upwards (+1.0 offset)
    norms[i + 2] = pos[i + 2];
    const len = Math.sqrt(norms[i] ** 2 + norms[i + 1] ** 2 + norms[i + 2] ** 2);
    norms[i] /= len; norms[i + 1] /= len; norms[i + 2] /= len;
  }

  return merged;
}

/** Broadleaf trunk */
function createBroadleafTrunk() {
  const trunk = new THREE.CylinderGeometry(0.9, 1.3, 14.0, 5, 1);
  trunk.translate(0, 7.0, 0);
  return trunk;
}

/** Simple geometry merge */
function mergeGeometries(geos) {
  let totalVerts = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    totalVerts += g.attributes.position.count;
  }
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  const idx = [];
  let vOff = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal ? g.attributes.normal.array : new Float32Array(p.length);
    const u = g.attributes.uv ? g.attributes.uv.array : new Float32Array((p.length / 3) * 2);
    for (let i = 0; i < p.length; i++) {
      pos[vOff * 3 + i] = p[i];
      norm[vOff * 3 + i] = n[i];
    }
    for (let i = 0; i < u.length; i++) {
      uv[vOff * 2 + i] = u[i];
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + vOff);
    }
    vOff += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(idx);
  merged.computeVertexNormals();
  return merged;
}

// ── Wind material factory ────────────────────────────────────

function createPampasMaterial(uTimeRef, uPlayerPosRef) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, // White base — color fully driven by shader gradient
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTimeRef;
    shader.uniforms.uPlayerPos = uPlayerPosRef;

    // ── Vertex shader: wind gusts + player interaction ──
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
uniform vec3 uPlayerPos;
varying float vHeightRatio;
`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>

  // Instance world origin
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);

  // Height ratio: 0 at root, 1 at tip (blade height ~1.55)
  vHeightRatio = clamp(position.y / 1.55, 0.0, 1.0);
  float heightWeight = pow(vHeightRatio, 1.6);

  // World position of this vertex (approximate)
  vec3 worldPos = worldInst.xyz + position;

  // ── Wind gust wave (dual sine) ──
  float wind = sin(worldPos.x * 0.08 + worldPos.z * 0.05 + uTime * 2.5) * 0.3
             + sin(worldPos.z * 0.15 - uTime * 3.5) * 0.15;
  transformed.x += wind * heightWeight;
  transformed.z += wind * 0.6 * heightWeight;

  // ── Player interaction: grass parts around cyclist ──
  vec2 toPlayer = worldPos.xz - uPlayerPos.xz;
  float distToPlayer = length(toPlayer);
  if (distToPlayer < 2.5 && distToPlayer > 0.01) {
    vec2 pushDir = normalize(toPlayer);
    float pushAmount = (1.0 - (distToPlayer / 2.5)) * heightWeight * 1.5;
    transformed.x += pushDir.x * pushAmount;
    transformed.z += pushDir.y * pushAmount;
    transformed.y -= pushAmount * 0.4; // Press down slightly
  }
`
    );

    // ── Fragment shader: height-based color gradient ──
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying float vHeightRatio;
`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  // Pampas height gradient: ultra-smooth smoothstep transitions
  vec3 rootColor  = vec3(0.125, 0.200, 0.094); // Dark olive root
  vec3 bodyColor  = vec3(0.239, 0.388, 0.169); // Rich natural green
  vec3 plumeColor = vec3(0.910, 0.886, 0.784); // Silky golden cream plume

  // Smooth root-to-body transition in the lower 35%
  float bodyFactor = smoothstep(0.0, 0.35, vHeightRatio);
  vec3 baseGrad = mix(rootColor, bodyColor, bodyFactor);

  // Apply per-instance green tint to body
  vec3 instanceTinted = baseGrad * diffuseColor.rgb;

  // Ultra-smooth body-to-plume transition from 40% height to 100% tip
  float plumeFactor = smoothstep(0.40, 1.0, vHeightRatio);
  diffuseColor.rgb = mix(instanceTinted, plumeColor, plumeFactor);
`
    );
  };

  mat.customProgramCacheKey = () => 'pampas_grass_v1';
  return mat;
}

function createLeafMaterial(baseColor, type, uTimeRef) {
  const leafTex = new THREE.TextureLoader().load('/textures/cherry_blossom_cluster_alpha.png');
  leafTex.colorSpace = THREE.SRGBColorSpace;

  // MeshLambertMaterial skips heavy PBR overhead (GGX BRDF), drastically reducing fill-rate on thousands of overlapping leaves
  const mat = new THREE.MeshLambertMaterial({
    color: baseColor,
    map: leafTex,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTimeRef;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
`
    );

    const maxH = type === 'pine' ? 22.5 : 20.5;
    const trunkH = type === 'pine' ? 8.0 : 9.5;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float h = position.y;
  float hNorm = clamp(h / ${maxH.toFixed(1)}, 0.0, 1.0);
  float macroPhase = uTime * 0.6 + worldInst.x * 0.08 + worldInst.z * 0.1;
  float macroX = sin(macroPhase) * 0.35 * hNorm;
  float macroZ = cos(macroPhase * 0.8) * 0.25 * hNorm;
  float leafMask = smoothstep(${trunkH.toFixed(1)}, ${(trunkH + 2.0).toFixed(1)}, h);
  float microPhase = uTime * 5.0 + worldInst.x * 0.7 + h * 2.5;
  float microX = sin(microPhase) * 0.2 * leafMask;
  float microZ = cos(microPhase * 1.3 + 0.5) * 0.15 * leafMask;
  transformed.x += macroX + microX;
  transformed.z += macroZ + microZ;
`
    );

    // Chroma-Key: Discards black background and eliminates dark fringing on edges
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      `
      #include <alphatest_fragment>
      #ifdef USE_MAP
        vec4 texelColorRaw = texture2D( map, vMapUv );
        float lum = dot(texelColorRaw.rgb, vec3(0.299, 0.587, 0.114));
        // Stricter discard threshold to eat away the dark/black fringing around the AI texture
        if (lum < 0.35) discard;
        
        diffuseColor.a = 1.0;
      #endif
      `
    );
  };

  mat.customProgramCacheKey = () => `foliage_leaf_${type}`;
  return mat;
}

function createTrunkMaterial() {
  const barkTex = new THREE.TextureLoader().load('/textures/bark_diffuse.png');
  barkTex.colorSpace = THREE.SRGBColorSpace;
  barkTex.wrapS = THREE.RepeatWrapping;
  barkTex.wrapT = THREE.RepeatWrapping;
  barkTex.repeat.set(1, 2); // Stretch bark vertically along the cylinder

  return new THREE.MeshStandardMaterial({
    color: 0x5a4a3a, // Slightly lightened to let bark texture show through
    map: barkTex,
    roughness: 0.95,
    metalness: 0.0,
  });
}

// ── FoliageSystem class ──────────────────────────────────────

export class FoliageSystem {
  constructor(scene, noiseGen) {
    this.scene = scene;
    this.noiseGen = noiseGen;
    this.uTime = { value: 0.0 };
    this.uPlayerPos = { value: new THREE.Vector3(0, 0, 0) };

    // Shared geometries
    this._grassGeo = createPampasTuft();
    this._pineCanopyGeo = createPineCanopy();
    this._pineTrunkGeo = createPineTrunk();
    this._broadCanopyGeo = createBroadleafCanopy();
    this._broadTrunkGeo = createBroadleafTrunk();

    // Shared materials
    this._grassMat = createPampasMaterial(this.uTime, this.uPlayerPos);
    this._pineLeafMat = createLeafMaterial(0xffffff, 'pine', this.uTime);    // Pure white blossoms
    this._broadLeafMat = createLeafMaterial(0xffffff, 'broadleaf', this.uTime); // Changed to pure white to match pines
    this._trunkMat = createTrunkMaterial();

    this.chunkFoliage = new Map();

    // Reusable
    this._mat4 = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  update(elapsedTime, playerPos) {
    this.uTime.value = elapsedTime;
    if (playerPos) {
      this.uPlayerPos.value.set(playerPos.x, playerPos.y, playerPos.z);
    }
  }

  async populateChunkAsync(cx, cz, chunkSize) {
    const key = `${cx},${cz}`;
    this.removeChunk(key);

    const worldOriginX = cx * chunkSize;
    const worldOriginZ = cz * chunkSize;
    const rng = mulberry32(chunkSeed(cx, cz));

    // Pre-allocate buffers for massive performance gains
    const grassBuffer = new Float32Array(GRASS_PER_CHUNK * 16);
    const grassColors = new Float32Array(GRASS_PER_CHUNK * 3);
    const pineBuffer = new Float32Array(PINE_PER_CHUNK * 16);
    const broadBuffer = new Float32Array(BROADLEAF_PER_CHUNK * 16);

    let grassCount = 0;
    let pineCount = 0;
    let broadCount = 0;

    const _grassColor = new THREE.Color();

    // ── Pampas grass pass ──────────────────────────────────────
    for (let i = 0; i < GRASS_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_CLEAR) continue;

      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;

      // Trail framing: taller, denser near path; shorter in open fields
      let baseScale;
      if (dist < TRAIL_DENSE) {
        // Dense tall pampas framing the trail
        baseScale = 1.0 + rng() * 0.5;
      } else {
        // Open field pampas — slightly shorter and varied
        baseScale = 0.7 + rng() * 0.6;
      }
      const yScale = baseScale + rng() * 0.4; // Extra height variation
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(baseScale, yScale, baseScale)
      );
      this._mat4.toArray(grassBuffer, grassCount * 16);

      // Per-instance tint: natural green variation (olive → deep green)
      const hue = 0.25 + rng() * 0.08;          // 90°–119° (olive → green)
      const sat = 0.30 + rng() * 0.25;           // 30%–55%
      const lightness = 0.45 + rng() * 0.20;     // 45%–65%
      _grassColor.setHSL(hue, sat, lightness);
      grassColors[grassCount * 3] = _grassColor.r;
      grassColors[grassCount * 3 + 1] = _grassColor.g;
      grassColors[grassCount * 3 + 2] = _grassColor.b;

      grassCount++;

      // Yield every 4000 instances to prevent main thread blocking (frame drops)
      if (i % 4000 === 0 && i !== 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ── Pine trees ────────────────────────────────────────────
    for (let i = 0; i < PINE_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.45 + rng() * 0.35;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      this._mat4.toArray(pineBuffer, pineCount * 16);
      pineCount++;
    }

    await new Promise(r => setTimeout(r, 0));

    // ── Broadleaf trees ───────────────────────────────────────
    for (let i = 0; i < BROADLEAF_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.4 + rng() * 0.35;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      this._mat4.toArray(broadBuffer, broadCount * 16);
      broadCount++;
    }

    await new Promise(r => setTimeout(r, 0));

    this._createInstancedMeshes(cx, cz, entry => {
      this.chunkFoliage.set(key, entry);
    }, grassCount, pineCount, broadCount, grassBuffer, grassColors, pineBuffer, broadBuffer);
  }

  populateChunk(cx, cz, chunkSize) {
    const key = `${cx},${cz}`;
    this.removeChunk(key);

    const worldOriginX = cx * chunkSize;
    const worldOriginZ = cz * chunkSize;
    const rng = mulberry32(chunkSeed(cx, cz));

    // Pre-allocate buffers for massive performance gains (no GC hit from Matrix4 cloning)
    const grassBuffer = new Float32Array(GRASS_PER_CHUNK * 16);
    const grassColors = new Float32Array(GRASS_PER_CHUNK * 3); // Per-instance color variation
    const pineBuffer = new Float32Array(PINE_PER_CHUNK * 16);
    const broadBuffer = new Float32Array(BROADLEAF_PER_CHUNK * 16);

    let grassCount = 0;
    let pineCount = 0;
    let broadCount = 0;

    // Color palette for pampas variation (warm straw/olive)
    const _grassColor = new THREE.Color();

    // ── Pampas grass pass ──────────────────────────────────────
    for (let i = 0; i < GRASS_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_CLEAR) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;

      // Trail framing: taller, denser near path; shorter in open fields
      let baseScale;
      if (dist < TRAIL_DENSE) {
        baseScale = 1.0 + rng() * 0.5;
      } else {
        baseScale = 0.7 + rng() * 0.6;
      }
      const yScale = baseScale + rng() * 0.4;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(baseScale, yScale, baseScale)
      );
      this._mat4.toArray(grassBuffer, grassCount * 16);

      // Per-instance tint: natural green variation
      const hue = 0.25 + rng() * 0.08;
      const sat = 0.30 + rng() * 0.25;
      const lightness = 0.45 + rng() * 0.20;
      _grassColor.setHSL(hue, sat, lightness);
      grassColors[grassCount * 3] = _grassColor.r;
      grassColors[grassCount * 3 + 1] = _grassColor.g;
      grassColors[grassCount * 3 + 2] = _grassColor.b;

      grassCount++;
    }

    // ── Pine trees ────────────────────────────────────────────
    for (let i = 0; i < PINE_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.45 + rng() * 0.35;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      this._mat4.toArray(pineBuffer, pineCount * 16);
      pineCount++;
    }

    // ── Broadleaf trees ───────────────────────────────────────
    for (let i = 0; i < BROADLEAF_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.4 + rng() * 0.35;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      this._mat4.toArray(broadBuffer, broadCount * 16);
      broadCount++;
    }

    this._createInstancedMeshes(cx, cz, entry => {
      this.chunkFoliage.set(key, entry);
    }, grassCount, pineCount, broadCount, grassBuffer, grassColors, pineBuffer, broadBuffer);
  }

  _createInstancedMeshes(cx, cz, saveEntry, grassCount, pineCount, broadCount, grassBuffer, grassColors, pineBuffer, broadBuffer) {
    const entry = {};
    const addIM = (geo, mat, buffer, count, name, castShadow, colors) => {
      if (count === 0) return;
      const m = new THREE.InstancedMesh(geo, mat, count);
      // Copy the pre-allocated float32 array directly into the instanceMatrix attribute
      m.instanceMatrix.array.set(buffer.subarray(0, count * 16));
      m.instanceMatrix.needsUpdate = true;
      // Apply per-instance color if provided
      if (colors) {
        m.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(colors.subarray(0, count * 3)), 3
        );
      }
      m.computeBoundingSphere(); // Calculates bounds across all instance positions
      m.castShadow = castShadow;
      m.receiveShadow = false;
      m.frustumCulled = true; // Instantly drop from rendering if chunk is behind camera
      this.scene.add(m);
      entry[name] = m;
    };

    addIM(this._grassGeo, this._grassMat, grassBuffer, grassCount, 'grass', false, grassColors);
    addIM(this._pineCanopyGeo, this._pineLeafMat, pineBuffer, pineCount, 'pineCanopy', true);
    addIM(this._pineTrunkGeo, this._trunkMat, pineBuffer, pineCount, 'pineTrunk', true);
    addIM(this._broadCanopyGeo, this._broadLeafMat, broadBuffer, broadCount, 'broadCanopy', true);
    addIM(this._broadTrunkGeo, this._trunkMat, broadBuffer, broadCount, 'broadTrunk', true);

    saveEntry(entry);
  }

  removeChunk(key) {
    const entry = this.chunkFoliage.get(key);
    if (!entry) return;
    for (const name in entry) {
      if (entry[name]) {
        this.scene.remove(entry[name]);
        entry[name].dispose();
      }
    }
    this.chunkFoliage.delete(key);
  }

  pruneExcept(desiredKeys) {
    for (const key of [...this.chunkFoliage.keys()]) {
      if (!desiredKeys.has(key)) this.removeChunk(key);
    }
  }
}
