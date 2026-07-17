/* ============================================================
 *  FoliageSystem.js
 *  High-performance procedural foliage using InstancedMesh.
 *  Grass + Pine trees + Broadleaf trees with wind animation.
 * ============================================================ */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────

const GRASS_PER_CHUNK    = 800;
const PINE_PER_CHUNK     = 40;
const BROADLEAF_PER_CHUNK = 30;

const TRAIL_CLEAR    = 6.0;   // No foliage inside this radius
const TRAIL_DENSE    = 15.0;  // Only grass between CLEAR and DENSE

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

// ── Shared geometry builders ─────────────────────────────────

function createGrassBlade() {
  // A simple tapered quad blade (4 vertices, 2 triangles)
  const geo = new THREE.BufferGeometry();
  const w = 0.08, h = 0.6;
  const verts = new Float32Array([
    -w, 0, 0,
     w, 0, 0,
     w * 0.3, h, 0,
    -w * 0.3, h, 0,
  ]);
  const indices = [0, 1, 2, 0, 2, 3];
  const uvs = new Float32Array([0,0, 1,0, 1,1, 0,1]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function createPineGeo() {
  // Cone for foliage + thin cylinder for trunk
  const group = new THREE.Group();

  // Trunk
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 3.0, 5, 1);
  // Canopy: stacked cones
  const cone1 = new THREE.ConeGeometry(1.8, 4.0, 6, 1);
  cone1.translate(0, 4.5, 0);
  const cone2 = new THREE.ConeGeometry(1.4, 3.0, 6, 1);
  cone2.translate(0, 6.5, 0);

  // Merge into a single geometry
  const merged = mergeGeometries([trunkGeo, cone1, cone2]);
  return { merged, trunkEnd: 3.0 }; // trunkEnd = height where trunk stops
}

function createBroadleafGeo() {
  // Simple trunk + sphere canopy
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 4.0, 5, 1);
  const canopy = new THREE.IcosahedronGeometry(3.0, 1);
  canopy.translate(0, 6.5, 0);
  const merged = mergeGeometries([trunkGeo, canopy]);
  return { merged, trunkEnd: 4.0 };
}

/** Simple geometry merge (no dependencies) */
function mergeGeometries(geos) {
  let totalVerts = 0, totalIdx = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIdx += (g.index ? g.index.count : 0);
  }

  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const idx = [];
  let vOff = 0, iOff = 0;

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

function createWindMaterial(baseColor, isGrass, uTimeRef) {
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.85,
    metalness: 0.0,
    side: isGrass ? THREE.DoubleSide : THREE.FrontSide,
  });

  mat.userData.uTime = uTimeRef;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTimeRef;

    // Vertex preamble
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
uniform float uTime;
`
    );

    if (isGrass) {
      // Grass wind: sway increases with Y height, roots stay fixed
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  // Wind for grass blades — anchored at base, tips sway
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float heightFactor = position.y; // 0 at root, ~0.6 at tip
  float windX = sin(uTime * 2.0 + worldInst.x * 0.3 + worldInst.z * 0.2) * 0.4;
  float windZ = cos(uTime * 1.5 + worldInst.z * 0.4) * 0.2;
  transformed.x += windX * heightFactor;
  transformed.z += windZ * heightFactor;
`
      );
    } else {
      // Tree wind: macro sway on trunk + micro flutter on canopy
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float h = position.y;
  // Macro trunk sway (low freq)
  float macroX = sin(uTime * 0.8 + worldInst.x * 0.1) * 0.15 * h * 0.1;
  float macroZ = cos(uTime * 0.6 + worldInst.z * 0.15) * 0.1 * h * 0.1;
  // Micro leaf flutter (high freq, only above trunk)
  float leafMask = smoothstep(3.0, 5.0, h);
  float microX = sin(uTime * 4.0 + worldInst.x * 0.8 + h * 2.0) * 0.12 * leafMask;
  float microZ = cos(uTime * 3.5 + worldInst.z * 0.9 + h * 1.5) * 0.08 * leafMask;
  transformed.x += macroX + microX;
  transformed.z += macroZ + microZ;
`
      );
    }
  };

  // Unique cache key so Three.js doesn't confuse compiled programs
  mat.customProgramCacheKey = () => `foliage_wind_${isGrass ? 'grass' : 'tree'}_${baseColor.toString(16)}`;

  return mat;
}

// ── FoliageSystem class ──────────────────────────────────────

export class FoliageSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {NoiseGenerator} noiseGen
   */
  constructor(scene, noiseGen) {
    this.scene = scene;
    this.noiseGen = noiseGen;

    // Shared time uniform — updated from main loop
    this.uTime = { value: 0.0 };

    // Shared geometries (created once)
    this._grassGeo = createGrassBlade();
    const pine = createPineGeo();
    this._pineGeo = pine.merged;
    const broad = createBroadleafGeo();
    this._broadGeo = broad.merged;

    // Shared materials with wind shaders
    this._grassMat = createWindMaterial(0x3a7d2c, true, this.uTime);
    this._pineMat  = createWindMaterial(0x2d5a27, false, this.uTime);
    this._broadMat = createWindMaterial(0x4a8c3f, false, this.uTime);

    // Map of "cx,cz" → { grassMesh, pineMesh, broadMesh }
    this.chunkFoliage = new Map();

    // Reusable objects
    this._mat4 = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** Update wind time uniform. Call from main loop. */
  update(elapsedTime) {
    this.uTime.value = elapsedTime;
  }

  /** Populate foliage for a chunk at grid coords (cx, cz) with given chunkSize. */
  populateChunk(cx, cz, chunkSize) {
    // Remove any existing foliage for this chunk
    const key = `${cx},${cz}`;
    this.removeChunk(key);

    const worldOriginX = cx * chunkSize;
    const worldOriginZ = cz * chunkSize;
    const halfSize = chunkSize / 2;

    const rng = mulberry32(chunkSeed(cx, cz));

    // Collect instance transforms
    const grassTransforms = [];
    const pineTransforms = [];
    const broadTransforms = [];

    // Scatter candidates across the chunk
    const totalCandidates = GRASS_PER_CHUNK + PINE_PER_CHUNK + BROADLEAF_PER_CHUNK;
    for (let i = 0; i < totalCandidates; i++) {
      const localX = (rng() - 0.5) * chunkSize;
      const localZ = (rng() - 0.5) * chunkSize;
      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;

      const dist = distToTrail(worldX, worldZ);

      // Skip trail clearing zone
      if (dist < TRAIL_CLEAR) continue;

      const height = this.noiseGen.getHeight(worldX, worldZ);
      const yRot = rng() * Math.PI * 2;

      if (i < GRASS_PER_CHUNK) {
        // Grass: spawns in both zones (6-15 dense, 15+ scattered)
        const s = 0.7 + rng() * 0.8; // random size variation
        this._mat4.compose(
          this._pos.set(worldX, height, worldZ),
          this._quat.setFromAxisAngle(this._up, yRot),
          this._scale.set(s, s + rng() * 0.4, s)
        );
        grassTransforms.push(this._mat4.clone());
      } else if (i < GRASS_PER_CHUNK + PINE_PER_CHUNK) {
        // Pine trees: only outside dense grass zone
        if (dist < TRAIL_DENSE) continue;
        const s = 0.6 + rng() * 0.7;
        this._mat4.compose(
          this._pos.set(worldX, height, worldZ),
          this._quat.setFromAxisAngle(this._up, yRot),
          this._scale.set(s, s, s)
        );
        pineTransforms.push(this._mat4.clone());
      } else {
        // Broadleaf trees: only outside dense grass zone
        if (dist < TRAIL_DENSE) continue;
        const s = 0.5 + rng() * 0.6;
        this._mat4.compose(
          this._pos.set(worldX, height, worldZ),
          this._quat.setFromAxisAngle(this._up, yRot),
          this._scale.set(s, s, s)
        );
        broadTransforms.push(this._mat4.clone());
      }
    }

    // Create InstancedMeshes
    const entry = {};

    if (grassTransforms.length > 0) {
      const grassMesh = new THREE.InstancedMesh(this._grassGeo, this._grassMat, grassTransforms.length);
      for (let i = 0; i < grassTransforms.length; i++) {
        grassMesh.setMatrixAt(i, grassTransforms[i]);
      }
      grassMesh.instanceMatrix.needsUpdate = true;
      grassMesh.castShadow = false;
      grassMesh.receiveShadow = false;
      grassMesh.frustumCulled = true;
      this.scene.add(grassMesh);
      entry.grassMesh = grassMesh;
    }

    if (pineTransforms.length > 0) {
      const pineMesh = new THREE.InstancedMesh(this._pineGeo, this._pineMat, pineTransforms.length);
      for (let i = 0; i < pineTransforms.length; i++) {
        pineMesh.setMatrixAt(i, pineTransforms[i]);
      }
      pineMesh.instanceMatrix.needsUpdate = true;
      pineMesh.castShadow = true;
      pineMesh.receiveShadow = false;
      pineMesh.frustumCulled = true;
      this.scene.add(pineMesh);
      entry.pineMesh = pineMesh;
    }

    if (broadTransforms.length > 0) {
      const broadMesh = new THREE.InstancedMesh(this._broadGeo, this._broadMat, broadTransforms.length);
      for (let i = 0; i < broadTransforms.length; i++) {
        broadMesh.setMatrixAt(i, broadTransforms[i]);
      }
      broadMesh.instanceMatrix.needsUpdate = true;
      broadMesh.castShadow = true;
      broadMesh.receiveShadow = false;
      broadMesh.frustumCulled = true;
      this.scene.add(broadMesh);
      entry.broadMesh = broadMesh;
    }

    this.chunkFoliage.set(key, entry);
  }

  /** Remove foliage for a chunk key */
  removeChunk(key) {
    const entry = this.chunkFoliage.get(key);
    if (!entry) return;

    if (entry.grassMesh) {
      this.scene.remove(entry.grassMesh);
      entry.grassMesh.dispose();
    }
    if (entry.pineMesh) {
      this.scene.remove(entry.pineMesh);
      entry.pineMesh.dispose();
    }
    if (entry.broadMesh) {
      this.scene.remove(entry.broadMesh);
      entry.broadMesh.dispose();
    }

    this.chunkFoliage.delete(key);
  }

  /** Remove all foliage not in the given set of keys */
  pruneExcept(desiredKeys) {
    for (const key of this.chunkFoliage.keys()) {
      if (!desiredKeys.has(key)) {
        this.removeChunk(key);
      }
    }
  }
}
