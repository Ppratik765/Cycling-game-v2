/* ============================================================
 *  Cycling Game v2 — main.js
 *  Phase 1: Core Engine, Lighting, Environment
 *  Phase 2: Procedural Downhill Terrain (Treadmill Chunk System)
 * ============================================================ */

import './style.css';

// ── Three.js core ───────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// ── Physics ─────────────────────────────────────────────────
import * as CANNON from 'cannon-es';

// ── Noise ───────────────────────────────────────────────────
import { createNoise2D } from 'simplex-noise';

/* ============================================================
 *  Section 1 — Constants & Configuration
 * ============================================================ */

/** Terrain chunk dimensions (world units) */
const CHUNK_SIZE = 100;

/** Segment count per chunk axis — higher = smoother terrain */
const CHUNK_SEGMENTS = 128;

/** How many chunks we keep alive ahead/behind the camera */
const CHUNKS_AHEAD = 4;
const CHUNKS_BEHIND = 2;

/** Noise parameters for terrain height generation */
const NOISE_SCALE = 0.008;        // Frequency of large rolling hills
const NOISE_AMPLITUDE = 12;       // Max hill height in world units
const DETAIL_NOISE_SCALE = 0.04;  // Frequency for small bumps
const DETAIL_NOISE_AMPLITUDE = 2; // Max bump height

/** Macro downhill slope: metres of drop per world unit in Z */
const SLOPE_GRADE = 0.08;

/** Texture repeat count per chunk */
const TEXTURE_REPEAT = 12;

/* ============================================================
 *  Section 2 — Renderer, Scene, Camera
 * ============================================================ */

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
scene.fog = new THREE.FogExp2(0x88aacc, 0.0018);

// ── Camera ──────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.5,
  2000
);
camera.position.set(0, 30, 50);

// ── OrbitControls (temporary — for terrain inspection) ──────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, -50);
controls.maxPolarAngle = Math.PI * 0.48;

/* ============================================================
 *  Section 3 — Physics World (cannon-es)
 * ============================================================ */

const world = new CANNON.World();
world.gravity.set(0, -9.81, 0);

// Broadphase — SAPBroadphase is efficient for large terrains
world.broadphase = new CANNON.SAPBroadphase(world);

// Allow bodies that are barely moving to sleep (perf boost)
world.allowSleep = true;

/* ============================================================
 *  Section 4 — Lighting & HDRI Environment
 * ============================================================ */

// ── Ambient fill (subtle) ───────────────────────────────────
const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambientLight);

// ── Hemisphere light for sky / ground colour bleed ──────────
const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.6);
scene.add(hemiLight);

// ── Directional "sun" light ─────────────────────────────────
const sunLight = new THREE.DirectionalLight(0xfff4e5, 2.5);
sunLight.position.set(80, 120, 60);
sunLight.castShadow = true;

// Shadow map quality & coverage
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

// ── HDRI Environment Map ────────────────────────────────────
const hdrLoader = new HDRLoader();
hdrLoader.load('/hdri/overcast_sky_1.hdr', (hdrTexture) => {
  hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdrTexture;
  scene.environment = hdrTexture;
});

/* ============================================================
 *  Section 5 — Terrain Textures
 * ============================================================ */

const textureLoader = new THREE.TextureLoader();

/**
 * Load a texture with tiling (RepeatWrapping) pre-configured.
 * @param {string} path - URL to the texture file.
 * @returns {THREE.Texture}
 */
function loadTilingTexture(path) {
  const tex = textureLoader.load(path);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TEXTURE_REPEAT, TEXTURE_REPEAT);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Anisotropic filtering — helps textures viewed at grazing angles
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const grassDiffuse = loadTilingTexture('/textures/ground_grass_diffuse.jpg');
const grassNormal = loadTilingTexture('/textures/ground_grass_normal.jpg');
const grassRough = loadTilingTexture('/textures/ground_grass_rough.jpg');

// Normal map is linear data, not sRGB
grassNormal.colorSpace = THREE.LinearSRGBColorSpace;
grassRough.colorSpace = THREE.LinearSRGBColorSpace;

/** Shared material for all terrain chunks */
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
 *  Section 6 — Noise Generator (deterministic seed)
 * ============================================================ */

/**
 * We use a simple seeded PRNG so the terrain is reproducible
 * across hot-reloads while developing.
 */
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

/**
 * Sample terrain height at any (x, z) world coordinate.
 * The function combines a macro-slope with two octaves of simplex noise.
 *
 * @param {number} x - World X position.
 * @param {number} z - World Z position (negative = downhill).
 * @returns {number} Y height at this position.
 */
function getTerrainHeight(x, z) {
  // Large rolling hills
  const macro = noise2D(x * NOISE_SCALE, z * NOISE_SCALE) * NOISE_AMPLITUDE;

  // Small surface bumps
  const detail =
    noise2D(x * DETAIL_NOISE_SCALE, z * DETAIL_NOISE_SCALE) *
    DETAIL_NOISE_AMPLITUDE;

  // Continuous downhill slope along negative-Z
  const slope = z * SLOPE_GRADE;

  return macro + detail + slope;
}

/* ============================================================
 *  Section 7 — Chunk Manager (Treadmill System)
 *  
 *  Chunks are created/recycled as the camera moves along the
 *  Z-axis. Each chunk is a THREE.Mesh (PlaneGeometry) whose
 *  vertices are displaced by getTerrainHeight(). A matching
 *  CANNON.Heightfield body is created for physics collisions.
 * ============================================================ */

/**
 * Map of chunkIndex → { mesh, body } for active chunks.
 * chunkIndex = Math.floor(z / CHUNK_SIZE) — each index maps
 * to a unique slab of terrain.
 */
const activeChunks = new Map();

/**
 * Build a terrain chunk at the given chunkIndex.
 *
 * The chunk's world-space Z range is:
 *   [chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE]
 * but since the player moves in -Z, the chunk origin is set
 * so the mesh sits correctly in world space.
 *
 * @param {number} chunkIndex
 */
function createChunk(chunkIndex) {
  // ── Three.js Mesh ─────────────────────────────────────────
  const geometry = new THREE.PlaneGeometry(
    CHUNK_SIZE,
    CHUNK_SIZE,
    CHUNK_SEGMENTS,
    CHUNK_SEGMENTS
  );

  // PlaneGeometry faces +Z by default; rotate it to face +Y (floor)
  geometry.rotateX(-Math.PI / 2);

  const posAttr = geometry.attributes.position;
  const vertexCount = posAttr.count;

  // Derive world-space origin of this chunk
  const chunkOriginZ = chunkIndex * CHUNK_SIZE;

  // We also need height data for the CANNON.Heightfield.
  // Heightfield expects a 2D row-major array:
  //   heightData[col][row]  where col = x-axis, row = z-axis
  const cols = CHUNK_SEGMENTS + 1;
  const rows = CHUNK_SEGMENTS + 1;
  const heightData = [];

  // Prepare the 2D array
  for (let c = 0; c < cols; c++) {
    heightData.push(new Float64Array(rows));
  }

  // Displace each vertex using noise
  for (let i = 0; i < vertexCount; i++) {
    const localX = posAttr.getX(i);
    const localZ = posAttr.getZ(i);

    // Convert to world coordinates
    const worldX = localX; // chunk is centred on X = 0
    const worldZ = localZ + chunkOriginZ + CHUNK_SIZE / 2;

    const height = getTerrainHeight(worldX, worldZ);
    posAttr.setY(i, height);

    // Map vertex index → heightfield col/row
    // After rotateX(-PI/2), vertices lay out in x,z order.
    // PlaneGeometry vertices go: row by row (z varies, then x).
    const row = Math.floor(i / cols);  // z index
    const col = i % cols;              // x index
    heightData[col][row] = height;
  }

  geometry.computeVertexNormals();
  posAttr.needsUpdate = true;

  const mesh = new THREE.Mesh(geometry, terrainMaterial);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // Position the chunk so its centre aligns with worldZ
  mesh.position.set(0, 0, chunkOriginZ + CHUNK_SIZE / 2);
  scene.add(mesh);

  // ── cannon-es Heightfield Body ────────────────────────────
  const elementSize = CHUNK_SIZE / CHUNK_SEGMENTS;
  const heightfieldShape = new CANNON.Heightfield(heightData, {
    elementSize,
  });

  const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
  body.addShape(heightfieldShape);

  // Position / rotation to align with the Three.js mesh.
  // CANNON Heightfield origin is at corner [0][0], so we
  // offset by half the chunk size to centre it.
  body.position.set(
    -CHUNK_SIZE / 2,
    0,
    chunkOriginZ
  );

  // Heightfield extends along +X (cols) and +Z (rows) by default,
  // with height along +Y. The rotation below orients it to match
  // the Three.js plane which was rotated by -PI/2 around X.
  // (Heightfield default axes already align after our body.position
  //  offset — no rotation needed because we manually built the
  //  height data in the correct axis orientation.)

  world.addBody(body);

  activeChunks.set(chunkIndex, { mesh, body });
}

/**
 * Dispose of a chunk — remove its Three.js mesh and physics body.
 * @param {number} chunkIndex
 */
function removeChunk(chunkIndex) {
  const chunk = activeChunks.get(chunkIndex);
  if (!chunk) return;

  scene.remove(chunk.mesh);
  chunk.mesh.geometry.dispose();
  world.removeBody(chunk.body);
  activeChunks.delete(chunkIndex);
}

/**
 * Recalculate which chunks should be alive based on the
 * camera's current Z position.
 */
function updateChunks() {
  const cameraZ = controls.target.z;
  const currentIndex = Math.floor(cameraZ / CHUNK_SIZE);

  const desiredMin = currentIndex - CHUNKS_AHEAD; // ahead = more negative Z
  const desiredMax = currentIndex + CHUNKS_BEHIND;

  // Create any chunks that are missing
  for (let i = desiredMin; i <= desiredMax; i++) {
    if (!activeChunks.has(i)) {
      createChunk(i);
    }
  }

  // Remove chunks that are out of range
  for (const idx of activeChunks.keys()) {
    if (idx < desiredMin || idx > desiredMax) {
      removeChunk(idx);
    }
  }
}

/* ============================================================
 *  Section 8 — Window Resize Handler
 * ============================================================ */

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onWindowResize);

/* ============================================================
 *  Section 9 — Debug helpers (temporary)
 * ============================================================ */

// Simple axis helper at origin so orientation is clear
const axesHelper = new THREE.AxesHelper(20);
scene.add(axesHelper);

// Grid on the XZ plane — disabled once terrain is confirmed good
// const gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
// scene.add(gridHelper);

/* ============================================================
 *  Section 10 — Animation Loop
 *
 *  Order of operations every frame:
 *    1. Step the physics world (fixed timestep)
 *    2. Update game logic (chunk manager, etc.)
 *    3. Update controls
 *    4. Render the scene
 * ============================================================ */

const timer = new THREE.Timer();
timer.connect(document);

/** Fixed physics timestep (60 Hz) */
const PHYSICS_TIMESTEP = 1 / 60;

/** Maximum delta to prevent spiral-of-death on tab refocus */
const MAX_DELTA = 0.1;

function animate(timestamp) {
  requestAnimationFrame(animate);

  timer.update(timestamp);
  const delta = Math.min(timer.getDelta(), MAX_DELTA);

  // 1. Step physics
  world.step(PHYSICS_TIMESTEP, delta, 3);

  // 2. Update chunk manager based on camera position
  updateChunks();

  // 3. Move the sun shadow camera to follow the camera loosely
  sunLight.position.set(
    controls.target.x + 80,
    120,
    controls.target.z + 60
  );
  sunLight.target.position.copy(controls.target);
  sunLight.target.updateMatrixWorld();

  // 4. Update orbit controls
  controls.update();

  // 5. Render
  renderer.render(scene, camera);
}

/* ============================================================
 *  Section 11 — Boot
 * ============================================================ */

// Seed the initial set of chunks
updateChunks();

// Hide the loading overlay once everything is ready
const loadingOverlay = document.getElementById('loading-overlay');
if (loadingOverlay) {
  // Small delay to allow the first frame to paint
  setTimeout(() => loadingOverlay.classList.add('hidden'), 300);
}

// Start the loop!
animate();

console.log(
  '%c🚴 Cycling Game v2 — Engine started',
  'color: #7c6aef; font-weight: bold; font-size: 14px;'
);
