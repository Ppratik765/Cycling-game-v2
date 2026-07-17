/* ============================================================
 *  FoliageSystem.js
 *  High-performance procedural foliage using InstancedMesh.
 *  Dense grass tufts + layered pine trees + broadleaf trees
 *  with amplified wind animation.
 * ============================================================ */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────

const GRASS_PER_CHUNK       = 18000;
const PINE_PER_CHUNK        = 500;
const BROADLEAF_PER_CHUNK   = 150;

const TRAIL_CLEAR    = 6.0;
const TRAIL_DENSE    = 15.0;

// ── Trail equation (must match CustomSplatShader.js) ─────────
function trailCurveX(z) {
  return Math.sin(z * 0.015) * 20.0 + Math.sin(z * 0.005) * 40.0;
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

/** Grass tuft: two planes intersecting at 90° forming an "X" */
function createGrassTuft() {
  const w = 0.16, h = 1.8; // 2x wider, 3x taller than original

  // Plane A (facing Z)
  const planeA = new THREE.PlaneGeometry(w * 2, h, 1, 3);
  planeA.translate(0, h / 2, 0);

  // Plane B (facing X, rotated 90°)
  const planeB = new THREE.PlaneGeometry(w * 2, h, 1, 3);
  planeB.rotateY(Math.PI / 2);
  planeB.translate(0, h / 2, 0);

  return mergeGeometries([planeA, planeB]);
}

/** Layered pine: 3 stacked cones of decreasing size on a trunk */
function createLayeredPine() {
  // Dark trunk
  const trunk = new THREE.CylinderGeometry(0.3, 0.45, 7.0, 6, 1);
  trunk.translate(0, 3.5, 0);

  // 3 cone layers
  const cone1 = new THREE.ConeGeometry(4.5, 8.0, 7, 1);
  cone1.translate(0, 11.0, 0);

  const cone2 = new THREE.ConeGeometry(3.5, 6.0, 7, 1);
  cone2.translate(0, 15.0, 0);

  const cone3 = new THREE.ConeGeometry(2.2, 4.5, 7, 1);
  cone3.translate(0, 18.5, 0);

  return mergeGeometries([trunk, cone1, cone2, cone3]);
}

/** Broadleaf: trunk + icosahedron canopy, scaled up */
function createBroadleaf() {
  const trunk = new THREE.CylinderGeometry(0.4, 0.6, 8.0, 6, 1);
  trunk.translate(0, 4.0, 0);

  const canopy = new THREE.IcosahedronGeometry(6.0, 1);
  canopy.translate(0, 13.0, 0);

  return mergeGeometries([trunk, canopy]);
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
      for (let i = 0; i < g.index.count; i++) {
        idx.push(g.index.array[i] + vOff);
      }
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

function createWindMaterial(baseColor, type, uTimeRef) {
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.85,
    metalness: 0.0,
    side: type === 'grass' ? THREE.DoubleSide : THREE.FrontSide,
  });

  mat.userData.uTime = uTimeRef;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTimeRef;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
`
    );

    if (type === 'grass') {
      // Amplified grass wind — heavy sway at tips, locked roots
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float heightFactor = clamp(position.y / 1.8, 0.0, 1.0); // normalize to grass height
  float heightSq = heightFactor * heightFactor; // quadratic falloff = roots locked, tips heavy
  float windPhase = uTime * 2.5 + worldInst.x * 0.25 + worldInst.z * 0.18;
  float windX = sin(windPhase) * 0.7 + sin(windPhase * 2.3 + 1.5) * 0.3;
  float windZ = cos(windPhase * 0.7 + 0.8) * 0.5;
  transformed.x += windX * heightSq;
  transformed.z += windZ * heightSq;
`
      );
    } else if (type === 'pine') {
      // Pine: macro trunk sway + amplified canopy flutter
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float h = position.y;
  float hNorm = clamp(h / 20.0, 0.0, 1.0);
  // Macro trunk sway
  float macroPhase = uTime * 0.6 + worldInst.x * 0.08 + worldInst.z * 0.1;
  float macroX = sin(macroPhase) * 0.4 * hNorm;
  float macroZ = cos(macroPhase * 0.8) * 0.3 * hNorm;
  // Canopy flutter (above trunk height ~7)
  float leafMask = smoothstep(6.0, 10.0, h);
  float microPhase = uTime * 5.0 + worldInst.x * 0.7 + h * 2.5;
  float microX = sin(microPhase) * 0.25 * leafMask;
  float microZ = cos(microPhase * 1.3 + 0.5) * 0.18 * leafMask;
  transformed.x += macroX + microX;
  transformed.z += macroZ + microZ;
`
      );
    } else {
      // Broadleaf: trunk sway + heavy canopy flutter
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float h = position.y;
  float hNorm = clamp(h / 18.0, 0.0, 1.0);
  float macroPhase = uTime * 0.5 + worldInst.x * 0.12;
  float macroX = sin(macroPhase) * 0.5 * hNorm;
  float macroZ = cos(macroPhase * 0.7 + 1.0) * 0.35 * hNorm;
  float leafMask = smoothstep(7.0, 10.0, h);
  float microPhase = uTime * 4.0 + worldInst.z * 0.6 + h * 2.0;
  float microX = sin(microPhase) * 0.3 * leafMask;
  float microZ = cos(microPhase * 1.1) * 0.2 * leafMask;
  transformed.x += macroX + microX;
  transformed.z += macroZ + microZ;
`
      );
    }
  };

  mat.customProgramCacheKey = () => `foliage_wind_${type}_${baseColor.toString(16)}`;
  return mat;
}

// ── FoliageSystem class ──────────────────────────────────────

export class FoliageSystem {
  constructor(scene, noiseGen) {
    this.scene = scene;
    this.noiseGen = noiseGen;

    this.uTime = { value: 0.0 };

    // Shared geometries
    this._grassGeo = createGrassTuft();
    this._pineGeo  = createLayeredPine();
    this._broadGeo = createBroadleaf();

    // Shared materials — desaturated hazy olive for grass, dark greens for trees
    this._grassMat = createWindMaterial(0x5a6345, 'grass', this.uTime);
    this._pineMat  = createWindMaterial(0x2d5a27, 'pine', this.uTime);
    this._broadMat = createWindMaterial(0x4a8c3f, 'broadleaf', this.uTime);

    // Trunk material (no wind)
    this._trunkMat = new THREE.MeshStandardMaterial({
      color: 0x3d2b1f,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.chunkFoliage = new Map();

    // Reusable objects
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

    const grassTransforms = [];
    const pineTransforms = [];
    const broadTransforms = [];

    // ── Grass pass (dense) ────────────────────────────────────
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
      grassTransforms.push(this._mat4.clone());
    }

    // ── Tree pass ─────────────────────────────────────────────
    for (let i = 0; i < PINE_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;

      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;

      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.6 + rng() * 0.8;

      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      pineTransforms.push(this._mat4.clone());
    }

    for (let i = 0; i < BROADLEAF_PER_CHUNK; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;

      const dist = distToTrail(worldX, worldZ);
      if (dist < TRAIL_DENSE) continue;

      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;
      const s = 0.5 + rng() * 0.7;

      this._mat4.compose(
        this._pos.set(worldX, height, worldZ),
        this._quat.setFromAxisAngle(this._up, yRot),
        this._scale.set(s, s, s)
      );
      broadTransforms.push(this._mat4.clone());
    }

    // ── Create InstancedMeshes ────────────────────────────────
    const entry = {};

    if (grassTransforms.length > 0) {
      const m = new THREE.InstancedMesh(this._grassGeo, this._grassMat, grassTransforms.length);
      for (let i = 0; i < grassTransforms.length; i++) m.setMatrixAt(i, grassTransforms[i]);
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false; // Prevent popping at chunk edges
      this.scene.add(m);
      entry.grassMesh = m;
    }

    if (pineTransforms.length > 0) {
      const m = new THREE.InstancedMesh(this._pineGeo, this._pineMat, pineTransforms.length);
      for (let i = 0; i < pineTransforms.length; i++) m.setMatrixAt(i, pineTransforms[i]);
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.scene.add(m);
      entry.pineMesh = m;
    }

    if (broadTransforms.length > 0) {
      const m = new THREE.InstancedMesh(this._broadGeo, this._broadMat, broadTransforms.length);
      for (let i = 0; i < broadTransforms.length; i++) m.setMatrixAt(i, broadTransforms[i]);
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.scene.add(m);
      entry.broadMesh = m;
    }

    this.chunkFoliage.set(key, entry);
  }

  removeChunk(key) {
    const entry = this.chunkFoliage.get(key);
    if (!entry) return;
    if (entry.grassMesh) { this.scene.remove(entry.grassMesh); entry.grassMesh.dispose(); }
    if (entry.pineMesh)  { this.scene.remove(entry.pineMesh);  entry.pineMesh.dispose(); }
    if (entry.broadMesh) { this.scene.remove(entry.broadMesh); entry.broadMesh.dispose(); }
    this.chunkFoliage.delete(key);
  }

  pruneExcept(desiredKeys) {
    for (const key of [...this.chunkFoliage.keys()]) {
      if (!desiredKeys.has(key)) this.removeChunk(key);
    }
  }
}
