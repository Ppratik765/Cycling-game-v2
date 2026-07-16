/* ============================================================
 *  Cycling Game v2 — main.js
 *  Phase 1: Core Engine & Rapier3D Physics
 *  Phase 2: 3x3 LOD Terrain Chunk System
 * ============================================================ */

import './style.css';

// ── Three.js core ───────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// ── Physics ─────────────────────────────────────────────────
import RAPIER from '@dimforge/rapier3d-compat';

// ── Noise ───────────────────────────────────────────────────
import { createNoise2D } from 'simplex-noise';

/* ============================================================
 *  Section 1 — Constants & Configuration
 * ============================================================ */

/** Terrain chunk dimensions (world units) */
const CHUNK_SIZE = 100;

/** LOD Segments */
const SEGMENTS_CENTER = 64; // High-res for physics & close visuals
const SEGMENTS_OUTER = 8;   // Low-res for distant visual-only chunks

/** Noise parameters for terrain height generation */
const NOISE_SCALE = 0.008;        
const NOISE_AMPLITUDE = 12;       
const DETAIL_NOISE_SCALE = 0.04;  
const DETAIL_NOISE_AMPLITUDE = 2; 

/** Macro downhill slope: metres of drop per world unit in Z */
const SLOPE_GRADE = 0.08;

/** Texture repeat count per chunk */
const TEXTURE_REPEAT = 12;

/* ============================================================
 *  Section 2 — State
 * ============================================================ */

let world; // Rapier physics world
const activeChunks = new Map();

const container = document.getElementById('app');

// ── Renderer ────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// ── Scene ───────────────────────────────────────────────────
const scene = new THREE.Scene();
// Fog matched roughly to the overcast sky horizon to blend chunk edges
scene.fog = new THREE.FogExp2(0xcccccc, 0.002);

// ── Camera ──────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.5,
  2000
);
camera.position.set(0, 30, 50);

// ── OrbitControls (temporary) ───────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, -50);
controls.maxPolarAngle = Math.PI * 0.48;

/* ============================================================
 *  Section 3 — Lighting & HDRI Environment
 * ============================================================ */

const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.6);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff4e5, 2.5);
sunLight.position.set(80, 120, 60);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 500;
sunLight.shadow.camera.left = -150;
sunLight.shadow.camera.right = 150;
sunLight.shadow.camera.top = 150;
sunLight.shadow.camera.bottom = -150;
sunLight.shadow.bias = -0.0005;
sunLight.shadow.normalBias = 0.02;
scene.add(sunLight);

const hdrLoader = new HDRLoader();
hdrLoader.load('/hdri/overcast_sky_1.hdr', (hdrTexture) => {
  hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdrTexture;
  scene.environment = hdrTexture;
});

/* ============================================================
 *  Section 4 — Terrain Textures
 * ============================================================ */

const textureLoader = new THREE.TextureLoader();

function loadTilingTexture(path) {
  const tex = textureLoader.load(path);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TEXTURE_REPEAT, TEXTURE_REPEAT);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const grassDiffuse = loadTilingTexture('/textures/ground_grass_diffuse.jpg');
const grassNormal = loadTilingTexture('/textures/ground_grass_normal.jpg');
const grassRough = loadTilingTexture('/textures/ground_grass_rough.jpg');

grassNormal.colorSpace = THREE.LinearSRGBColorSpace;
grassRough.colorSpace = THREE.LinearSRGBColorSpace;

const terrainMaterial = new THREE.MeshStandardMaterial({
  map: grassDiffuse,
  normalMap: grassNormal,
  normalScale: new THREE.Vector2(1.0, 1.0),
  roughnessMap: grassRough,
  roughness: 0.85,
  metalness: 0.0,
  side: THREE.FrontSide,
});

/* ============================================================
 *  Section 5 — Noise Generator
 * ============================================================ */

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise2D = createNoise2D(mulberry32(42));

function getTerrainHeight(x, z) {
  const macro = noise2D(x * NOISE_SCALE, z * NOISE_SCALE) * NOISE_AMPLITUDE;
  const detail = noise2D(x * DETAIL_NOISE_SCALE, z * DETAIL_NOISE_SCALE) * DETAIL_NOISE_AMPLITUDE;
  const slope = z * SLOPE_GRADE;
  return macro + detail + slope;
}

/* ============================================================
 *  Section 6 — Chunk Manager (3x3 LOD Grid)
 * ============================================================ */

function createChunk(chunkX, chunkZ, isCenter) {
  const segments = isCenter ? SEGMENTS_CENTER : SEGMENTS_OUTER;
  
  const geometry = new THREE.PlaneGeometry(
    CHUNK_SIZE,
    CHUNK_SIZE,
    segments,
    segments
  );
  geometry.rotateX(-Math.PI / 2);

  const posAttr = geometry.attributes.position;
  const vertexCount = posAttr.count;

  const worldOffsetX = chunkX * CHUNK_SIZE;
  const worldOffsetZ = chunkZ * CHUNK_SIZE;

  // Displace vertices
  for (let i = 0; i < vertexCount; i++) {
    const localX = posAttr.getX(i);
    const localZ = posAttr.getZ(i);

    const worldX = worldOffsetX + localX;
    const worldZ = worldOffsetZ + localZ;

    const height = getTerrainHeight(worldX, worldZ);
    posAttr.setY(i, height);
  }

  geometry.computeVertexNormals();
  posAttr.needsUpdate = true;

  const mesh = new THREE.Mesh(geometry, terrainMaterial);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.position.set(worldOffsetX, 0, worldOffsetZ);
  scene.add(mesh);

  let body = null;

  // Only the center chunk gets a physics collider (Trimesh for exact match)
  if (isCenter && world) {
    const vertices = Float32Array.from(geometry.attributes.position.array);
    const indices = Uint32Array.from(geometry.index.array);
    
    const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices);
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      worldOffsetX,
      0,
      worldOffsetZ
    );
    
    body = world.createRigidBody(bodyDesc);
    world.createCollider(colliderDesc, body);
  }

  const key = `${chunkX},${chunkZ}`;
  activeChunks.set(key, { mesh, body, isCenter });
}

function removeChunk(key) {
  const chunk = activeChunks.get(key);
  if (!chunk) return;

  scene.remove(chunk.mesh);
  chunk.mesh.geometry.dispose();
  
  if (chunk.body && world) {
    world.removeRigidBody(chunk.body);
  }
  
  activeChunks.delete(key);
}

function updateChunks() {
  const cameraX = controls.target.x;
  const cameraZ = controls.target.z;
  
  const currentChunkX = Math.round(cameraX / CHUNK_SIZE);
  const currentChunkZ = Math.round(cameraZ / CHUNK_SIZE);

  const desiredChunks = new Set();
  
  // 3x3 grid around the camera
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      const cx = currentChunkX + x;
      const cz = currentChunkZ + z;
      const key = `${cx},${cz}`;
      const isCenter = (x === 0 && z === 0);
      
      desiredChunks.add(key);

      const existing = activeChunks.get(key);
      if (existing) {
        // If LOD status changed (e.g. was outer, now center), recreate it
        if (existing.isCenter !== isCenter) {
          removeChunk(key);
          createChunk(cx, cz, isCenter);
        }
      } else {
        createChunk(cx, cz, isCenter);
      }
    }
  }

  // Remove out-of-bounds chunks
  for (const key of activeChunks.keys()) {
    if (!desiredChunks.has(key)) {
      removeChunk(key);
    }
  }
}

/* ============================================================
 *  Section 7 — Window Resize Handler
 * ============================================================ */

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onWindowResize);

/* ============================================================
 *  Section 8 — Debug helpers
 * ============================================================ */

const axesHelper = new THREE.AxesHelper(20);
scene.add(axesHelper);

/* ============================================================
 *  Section 9 — Animation Loop
 * ============================================================ */

const timer = new THREE.Timer();
timer.connect(document);

const MAX_DELTA = 0.1;

function animate(timestamp) {
  requestAnimationFrame(animate);

  timer.update(timestamp);
  const delta = Math.min(timer.getDelta(), MAX_DELTA);

  // 1. Step Rapier physics
  if (world) {
    world.timestep = delta;
    world.step();
  }

  // 2. Update chunks dynamically
  updateChunks();

  // 3. Update shadow camera position
  sunLight.position.set(
    controls.target.x + 80,
    120,
    controls.target.z + 60
  );
  sunLight.target.position.copy(controls.target);
  sunLight.target.updateMatrixWorld();

  // 4. Update controls
  controls.update();

  // 5. Render
  renderer.render(scene, camera);
}

/* ============================================================
 *  Section 10 — Boot (Async initialization)
 * ============================================================ */

async function init() {
  // Wait for the Wasm binary to load
  await RAPIER.init();
  console.log('Rapier3D initialized');

  // Create physics world
  world = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });

  // Initial chunks
  updateChunks();

  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) {
    setTimeout(() => loadingOverlay.classList.add('hidden'), 300);
  }

  animate();
  
  console.log(
    '%c🚴 Cycling Game v2 — Engine started',
    'color: #7c6aef; font-weight: bold; font-size: 14px;'
  );
}

init();
