/* ============================================================
 *  TerrainChunkManager.js
 *  3x3 infinite terrain grid with Rapier3D heightfield physics.
 *  Uses chunk pooling — repositions chunks instead of recreating.
 * ============================================================ */

import * as THREE from 'three';

/** Number of segments per chunk axis (= vertices - 1) */
const SEGMENTS = 64;

export class TerrainChunkManager {
  /**
   * @param {object}        opts
   * @param {THREE.Scene}   opts.scene
   * @param {object}        opts.rapierWorld   - RAPIER.World instance
   * @param {object}        opts.RAPIER        - RAPIER module reference
   * @param {object}        opts.noiseGen      - NoiseGenerator instance
   * @param {THREE.Material} opts.material     - Shared terrain material
   * @param {object}        opts.foliage      - FoliageSystem instance
   * @param {number}        opts.chunkSize     - World units per chunk edge
   */
  constructor({ scene, rapierWorld, RAPIER, noiseGen, material, foliage, chunkSize = 200 }) {
    this.scene = scene;
    this.world = rapierWorld;
    this.RAPIER = RAPIER;
    this.noise = noiseGen;
    this.material = material;
    this.foliage = foliage;
    this.chunkSize = chunkSize;

    /** Map of "cx,cz" → { mesh, rigidBody, collider, cx, cz } */
    this.chunks = new Map();
    /** Pool of disposed chunk objects ready for reuse */
    this._pool = [];
    this._lastCX = Infinity;
    this._lastCZ = Infinity;
  }

  /** Force-spawn all chunks centered on (focusX, focusZ). Call once at init. */
  init(focusX = 0, focusZ = 0) {
    this.chunkQueue = [];
    const cx = Math.round(focusX / this.chunkSize);
    const cz = Math.round(focusZ / this.chunkSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        this._createChunk(cx + dx, cz + dz);
      }
    }
    this._lastCX = cx;
    this._lastCZ = cz;
  }

  /** Async force-spawn that yields to UI to prevent freezing animations */
  async initAsync(focusX = 0, focusZ = 0, yieldFn = null) {
    this.chunkQueue = [];
    const cx = Math.round(focusX / this.chunkSize);
    const cz = Math.round(focusZ / this.chunkSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        this._createChunk(cx + dx, cz + dz);
        if (yieldFn) await yieldFn();
      }
    }
    this._lastCX = cx;
    this._lastCZ = cz;
  }

  /**
   * Call each frame with the player's position.
   * Only repositions when the player crosses a chunk boundary.
   */
  update(focusX, focusZ) {
    // Process one chunk from the queue per frame to prevent massive FPS spikes
    if (this.chunkQueue && this.chunkQueue.length > 0) {
      const nextKey = this.chunkQueue.shift();
      if (!this.chunks.has(nextKey)) {
        const [ncx, ncz] = nextKey.split(',').map(Number);
        this._createChunk(ncx, ncz);
      }
    }

    const cx = Math.round(focusX / this.chunkSize);
    const cz = Math.round(focusZ / this.chunkSize);

    if (cx === this._lastCX && cz === this._lastCZ) return;
    this._lastCX = cx;
    this._lastCZ = cz;

    const desired = new Set();

    // 3x3 grid restored to save massive GPU overhead
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        desired.add(`${cx + dx},${cz + dz}`);
      }
    }

    // Pool chunks that are no longer needed
    for (const [key, chunk] of this.chunks) {
      if (!desired.has(key)) {
        this._poolChunk(key, chunk);
      }
    }

    // Queue chunks for new positions instead of generating them all synchronously
    for (const key of desired) {
      if (!this.chunks.has(key) && !this.chunkQueue.includes(key)) {
        this.chunkQueue.push(key);
      }
    }

    // Prune foliage for chunks no longer in the grid
    if (this.foliage) this.foliage.pruneExcept(desired);
  }

  // ── Internal ────────────────────────────────────────────────

  _createChunk(cx, cz) {
    const size = this.chunkSize;
    const segs = SEGMENTS;
    const verts = segs + 1; // vertices per axis

    const worldOriginX = cx * size;
    const worldOriginZ = cz * size;

    // Try to reuse a pooled chunk
    const pooled = this._pool.pop();
    let geo, mesh, heightData;

    if (pooled) {
      // Reuse existing mesh & geometry
      mesh = pooled.mesh;
      geo = mesh.geometry;

      // Remove old physics
      this.world.removeCollider(pooled.collider, true);
      this.world.removeRigidBody(pooled.rigidBody);
    } else {
      // Create new geometry & mesh
      geo = new THREE.PlaneGeometry(size, size, segs, segs);
      geo.rotateX(-Math.PI / 2); // Face +Y
      mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.scene.add(mesh);
    }

    // ── Recompute heights ───────────────────────────────────
    const posAttr = geo.attributes.position;
    heightData = new Float32Array(verts * verts);

    for (let i = 0; i < posAttr.count; i++) {
      const localX = posAttr.getX(i);
      const localZ = posAttr.getZ(i);

      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;

      const h = this.noise.getHeight(worldX, worldZ);
      posAttr.setY(i, h);

      const row = Math.floor(i / verts);
      const col = i % verts;
      heightData[col * verts + row] = h;
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    mesh.position.set(worldOriginX, 0, worldOriginZ);

    // ── Rapier3D Heightfield ───────────────────────────────────
    const R = this.RAPIER;

    const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(
      worldOriginX,
      0,
      worldOriginZ
    );
    const rigidBody = this.world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.heightfield(
      segs,
      segs,
      heightData,
      { x: size, y: 1.0, z: size }
    );
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    const key = `${cx},${cz}`;
    this.chunks.set(key, { mesh, rigidBody, collider, cx, cz });

    // Populate foliage for this chunk
    if (this.foliage) this.foliage.populateChunk(cx, cz, size);
  }

  /** Move a chunk to the pool instead of destroying it */
  _poolChunk(key, chunk) {
    this.chunks.delete(key);
    this._pool.push(chunk);
  }
}
