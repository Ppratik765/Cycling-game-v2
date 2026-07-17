/* ============================================================
 *  FoliageSystem.js
 *  High-performance procedural foliage using InstancedMesh.
 *  Textured grass tufts + trees with brown trunks.
 * ============================================================ */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────

const GRASS_PER_CHUNK       = 40000;
const PINE_PER_CHUNK        = 40;
const BROADLEAF_PER_CHUNK   = 20;

const TRAIL_CLEAR    = 6.0;
const TRAIL_DENSE    = 15.0;

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

/** Grass tuft: A thick cluster of 4 planes to simulate high density */
function createGrassTuft() {
  const w = 0.16, h = 1.8;
  const planes = [];
  
  // Create 4 planes rotated at 45 degree intervals (0, 45, 90, 135)
  for (let i = 0; i < 4; i++) {
    const plane = new THREE.PlaneGeometry(w * 2, h, 1, 3);
    plane.rotateY((Math.PI / 4) * i);
    
    // Add a slight lean to make the clump fan outward
    const leanX = (i % 2 === 0 ? 0.15 : -0.15);
    const leanZ = (i > 1 ? 0.15 : -0.15);
    plane.rotateX(leanX);
    plane.rotateZ(leanZ);
    
    plane.translate(0, h / 2, 0);
    planes.push(plane);
  }
  
  return mergeGeometries(planes);
}

/** Layered pine canopy only (trunk is separate) */
function createPineCanopy() {
  const cone1 = new THREE.ConeGeometry(3.0, 5.0, 6, 1);
  cone1.translate(0, 7.5, 0);
  const cone2 = new THREE.ConeGeometry(2.2, 4.0, 6, 1);
  cone2.translate(0, 10.5, 0);
  const cone3 = new THREE.ConeGeometry(1.4, 3.0, 6, 1);
  cone3.translate(0, 13.0, 0);
  return mergeGeometries([cone1, cone2, cone3]);
}

/** Pine trunk */
function createPineTrunk() {
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 5.0, 5, 1);
  trunk.translate(0, 2.5, 0);
  return trunk;
}

/** Broadleaf canopy only */
function createBroadleafCanopy() {
  const canopy = new THREE.IcosahedronGeometry(4.0, 1);
  canopy.translate(0, 9.0, 0);
  return canopy;
}

/** Broadleaf trunk */
function createBroadleafTrunk() {
  const trunk = new THREE.CylinderGeometry(0.3, 0.5, 6.0, 5, 1);
  trunk.translate(0, 3.0, 0);
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
  const idx = [];
  let vOff = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal ? g.attributes.normal.array : new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) {
      pos[vOff * 3 + i] = p[i];
      norm[vOff * 3 + i] = n[i];
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + vOff);
    }
    vOff += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  merged.setIndex(idx);
  merged.computeVertexNormals();
  return merged;
}

// ── Wind material factory ────────────────────────────────────

function createGrassMaterial(uTimeRef) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2d5a27, // A realistic, lush green
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
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.8,
    metalness: 0.0,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTimeRef;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
`
    );

    const maxH = type === 'pine' ? 15.0 : 12.0;
    const trunkH = type === 'pine' ? 5.0 : 6.0;

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
  };

  mat.customProgramCacheKey = () => `foliage_leaf_${type}`;
  return mat;
}

// ── FoliageSystem class ──────────────────────────────────────

export class FoliageSystem {
  constructor(scene, noiseGen) {
    this.scene = scene;
    this.noiseGen = noiseGen;
    this.uTime = { value: 0.0 };

    // Shared geometries
    this._grassGeo       = createGrassTuft();
    this._pineCanopyGeo  = createPineCanopy();
    this._pineTrunkGeo   = createPineTrunk();
    this._broadCanopyGeo = createBroadleafCanopy();
    this._broadTrunkGeo  = createBroadleafTrunk();

    // Shared materials
    this._grassMat      = createGrassMaterial(this.uTime);
    this._pineLeafMat   = createLeafMaterial(0x2d5a27, 'pine', this.uTime);
    this._broadLeafMat  = createLeafMaterial(0x3d7a32, 'broadleaf', this.uTime);
    this._trunkMat      = new THREE.MeshStandardMaterial({
      color: 0x4a3728, // Brown bark
      roughness: 0.95,
      metalness: 0.0,
    });

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

  populateChunk(cx, cz, chunkSize) {
    const key = `${cx},${cz}`;
    this.removeChunk(key);

    const worldOriginX = cx * chunkSize;
    const worldOriginZ = cz * chunkSize;
    const rng = mulberry32(chunkSeed(cx, cz));

    // Pre-allocate buffers for massive performance gains (no GC hit from Matrix4 cloning)
    const grassBuffer = new Float32Array(GRASS_PER_CHUNK * 16);
    const pineBuffer = new Float32Array(PINE_PER_CHUNK * 16);
    const broadBuffer = new Float32Array(BROADLEAF_PER_CHUNK * 16);

    let grassCount = 0;
    let pineCount = 0;
    let broadCount = 0;

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

    // ── Create InstancedMeshes ────────────────────────────────
    const entry = {};
    const addIM = (geo, mat, buffer, count, name, castShadow) => {
      if (count === 0) return;
      const m = new THREE.InstancedMesh(geo, mat, count);
      // Copy the pre-allocated float32 array directly into the instanceMatrix attribute
      m.instanceMatrix.array.set(buffer.subarray(0, count * 16));
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = castShadow;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.scene.add(m);
      entry[name] = m;
    };

    addIM(this._grassGeo,       this._grassMat,     grassBuffer, grassCount, 'grass',        false);
    addIM(this._pineCanopyGeo,  this._pineLeafMat,  pineBuffer,  pineCount,  'pineCanopy',   true);
    addIM(this._pineTrunkGeo,   this._trunkMat,     pineBuffer,  pineCount,  'pineTrunk',    true);
    addIM(this._broadCanopyGeo, this._broadLeafMat, broadBuffer, broadCount, 'broadCanopy',  true);
    addIM(this._broadTrunkGeo,  this._trunkMat,     broadBuffer, broadCount, 'broadTrunk',   true);

    this.chunkFoliage.set(key, entry);
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
