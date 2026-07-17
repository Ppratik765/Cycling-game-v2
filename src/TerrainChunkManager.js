/* ============================================================
 *  TerrainChunkManager.js
 *  3x3 infinite terrain grid with Rapier3D heightfield physics.
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
   * @param {number}        opts.chunkSize     - World units per chunk edge
   */
  constructor({ scene, rapierWorld, RAPIER, noiseGen, material, chunkSize = 64 }) {
    this.scene = scene;
    this.world = rapierWorld;
    this.RAPIER = RAPIER;
    this.noise = noiseGen;
    this.material = material;
    this.chunkSize = chunkSize;

    /** Map of "cx,cz" → { mesh, rigidBody, collider } */
    this.chunks = new Map();

    /** Last known camera chunk coords — skip update if unchanged */
    this._lastCX = Infinity;
    this._lastCZ = Infinity;
  }

  /**
   * Call each frame with the camera (or OrbitControls.target) position.
   * Only rebuilds when the camera crosses a chunk boundary.
   */
  update(focusX, focusZ) {
    const cx = Math.round(focusX / this.chunkSize);
    const cz = Math.round(focusZ / this.chunkSize);

    if (cx === this._lastCX && cz === this._lastCZ) return;
    this._lastCX = cx;
    this._lastCZ = cz;

    const desired = new Set();

    // 3x3 grid
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${cx + dx},${cz + dz}`;
        desired.add(key);
        if (!this.chunks.has(key)) {
          this._createChunk(cx + dx, cz + dz);
        }
      }
    }

    // Cull chunks no longer in the 3x3
    for (const [key, chunk] of this.chunks) {
      if (!desired.has(key)) {
        this._disposeChunk(key, chunk);
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────

  _createChunk(cx, cz) {
    const size = this.chunkSize;
    const segs = SEGMENTS;
    const verts = segs + 1; // vertices per axis

    // ── Three.js Geometry ──────────────────────────────────────
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2); // Face +Y

    const posAttr = geo.attributes.position;
    const worldOriginX = cx * size;
    const worldOriginZ = cz * size;

    // Heights stored in column-major order for Rapier
    // Rapier heightfield: nrows × ncols, column-major
    const heightData = new Float32Array(verts * verts);

    for (let i = 0; i < posAttr.count; i++) {
      const localX = posAttr.getX(i);
      const localZ = posAttr.getZ(i);

      const worldX = localX + worldOriginX;
      const worldZ = localZ + worldOriginZ;

      const h = this.noise.getHeight(worldX, worldZ);
      posAttr.setY(i, h);

      // PlaneGeometry after rotateX(-PI/2) lays out:
      //   row = floor(i / verts)  → Z axis
      //   col = i % verts         → X axis
      // Rapier wants column-major: index = col * verts + row
      const row = Math.floor(i / verts);
      const col = i % verts;
      heightData[col * verts + row] = h;
    }

    geo.computeVertexNormals();
    posAttr.needsUpdate = true;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.position.set(worldOriginX, 0, worldOriginZ);
    this.scene.add(mesh);

    // ── Rapier3D Heightfield ───────────────────────────────────
    const R = this.RAPIER;
    const nrows = segs; // number of subdivisions (not vertices)
    const ncols = segs;

    const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(
      worldOriginX,
      0,
      worldOriginZ
    );
    const rigidBody = this.world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.heightfield(
      nrows,
      ncols,
      heightData,
      { x: size, y: 1.0, z: size }
    );
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    const key = `${cx},${cz}`;
    this.chunks.set(key, { mesh, rigidBody, collider });
  }

  _disposeChunk(key, chunk) {
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    // Material is shared, don't dispose it

    this.world.removeCollider(chunk.collider, true);
    this.world.removeRigidBody(chunk.rigidBody);

    this.chunks.delete(key);
  }
}
