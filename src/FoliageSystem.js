/* ============================================================
 *  FoliageSystem.js
 *  High-performance procedural foliage using InstancedMesh.
 *  Textured grass tufts + trees with brown trunks.
 * ============================================================ */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────

const GRASS_PER_CHUNK = 23000;
const PINE_PER_CHUNK = 40;
const BROADLEAF_PER_CHUNK = 20;

const TRAIL_CLEAR = 6.0;
const TRAIL_DENSE = 15.0;

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

/** Grass tuft: Efficient V-shape (2 planes) with upward normals for perfect terrain blending */
function createGrassTuft() {
  const w = 0.18, h = 1.6;
  const planes = [];

  // Create 2 planes rotated at 90 degree intervals (0, 90) for a classic cross shape
  for (let i = 0; i < 2; i++) {
    const plane = new THREE.PlaneGeometry(w * 2, h, 1, 3);

    // Deliberately delete UVs so the grass acts as a solid colored plane (old aesthetic)
    plane.deleteAttribute('uv');

    plane.rotateY((Math.PI / 2) * i);

    // Add a slight lean to make the clump fan outward
    const leanX = (i === 0 ? 0.15 : -0.15);
    plane.rotateX(leanX);
    plane.rotateZ(0.15);

    plane.translate(0, h / 2, 0);
    planes.push(plane);
  }

  const merged = mergeGeometries(planes);

  // Override normals to point straight up (0, 1, 0)
  // This AAA trick makes grass shade exactly like the terrain underneath it
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

  // Stack 4 layers of decreasing size to form a pine profile
  addLayer(13.0, 9.5, 7.0, 0);
  addLayer(17.0, 7.5, 6.0, 0.5);
  addLayer(21.0, 5.5, 5.0, 1.0);
  addLayer(24.5, 3.5, 4.0, 1.5);

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

function createGrassMaterial(uTimeRef) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a6340, // Desaturated olive — less vivid under ACES tonemapping
    alphaTest: 0.5,
    roughness: 0.9,
    metalness: 0.0,
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

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float heightFactor = clamp(position.y / 1.8, 0.0, 1.0);
  float heightSq = heightFactor * heightFactor;
  float windPhase = uTime * 2.5 + worldInst.x * 0.25 + worldInst.z * 0.18;
  float windX = sin(windPhase) * 0.7 + sin(windPhase * 2.3 + 1.5) * 0.3;
  float windZ = cos(windPhase * 0.7 + 0.8) * 0.5;
  transformed.x += windX * heightSq;
  transformed.z += windZ * heightSq;
`
    );


  };

  mat.customProgramCacheKey = () => 'foliage_grass_textured';
  return mat;
}

function createLeafMaterial(baseColor, type, uTimeRef) {
  const leafTex = new THREE.TextureLoader().load('/textures/leaf_cluster_alpha.png?v=3');
  leafTex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    map: leafTex,
    alphaTest: 0.35,
    roughness: 0.8,
    metalness: 0.0,
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

    // AI Chroma-Key: Discards grey/white/black backgrounds based on raw texture color
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      `
      #include <alphatest_fragment>
      #ifdef USE_MAP
        vec4 texelColorRaw = texture2D( map, vMapUv );
        float maxC = max(texelColorRaw.r, max(texelColorRaw.g, texelColorRaw.b));
        float minC = min(texelColorRaw.r, min(texelColorRaw.g, texelColorRaw.b));
        if (maxC - minC < 0.065) discard;
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

    // Shared geometries
    this._grassGeo = createGrassTuft();
    this._pineCanopyGeo = createPineCanopy();
    this._pineTrunkGeo = createPineTrunk();
    this._broadCanopyGeo = createBroadleafCanopy();
    this._broadTrunkGeo = createBroadleafTrunk();

    // Shared materials
    this._grassMat = createGrassMaterial(this.uTime);
    this._pineLeafMat = createLeafMaterial(0x3a6630, 'pine', this.uTime);    // Desaturated pine green
    this._broadLeafMat = createLeafMaterial(0x4a7a3a, 'broadleaf', this.uTime); // Desaturated broadleaf
    this._trunkMat = createTrunkMaterial();

    this.chunkFoliage = new Map();

    // Reusable
    this._mat4 = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  update(elapsedTime) {
    this.uTime.value = elapsedTime;
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

    // ── Grass pass ────────────────────────────────────────────
    for (let i = 0; i < GRASS_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_CLEAR) continue;

      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.8 + rng() * 0.6;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s + rng() * 0.5, s)
      );
      this._mat4.toArray(grassBuffer, grassCount * 16);

      const hue = 0.25 + rng() * 0.08;
      const sat = 0.25 + rng() * 0.25;
      const lightness = 0.18 + rng() * 0.14;
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

    // Color palette for grass variation (olive → deeper green, desaturated)
    const _grassColor = new THREE.Color();

    // ── Grass pass ────────────────────────────────────────────
    for (let i = 0; i < GRASS_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;
      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_CLEAR) continue;
      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.8 + rng() * 0.6;
      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s + rng() * 0.5, s)
      );
      this._mat4.toArray(grassBuffer, grassCount * 16);

      // Per-instance color: random tint between olive and deeper green
      const hue = 0.25 + rng() * 0.08;          // 90°–119° (olive → green)
      const sat = 0.25 + rng() * 0.25;           // Desaturated: 25%–50%
      const lightness = 0.18 + rng() * 0.14;     // Dark: 18%–32%
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
