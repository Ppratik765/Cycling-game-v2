/* ============================================================
 *  Cycling Game v2 — main.js
 *  Phase 1: Core Engine, Atmosphere, Backdrop
 *  Phase 2: Terrain Chunks & Shader Splatting
 * ============================================================ */

import './style.css';

// ── Three.js ────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// ── Physics ─────────────────────────────────────────────────
import RAPIER from '@dimforge/rapier3d-compat';

// ── Post-processing ─────────────────────────────────────────
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  SSAOEffect,
  VignetteEffect,
  NoiseEffect,
  SMAAEffect,
  BlendFunction
} from 'postprocessing';

// ── Game modules ────────────────────────────────────────────
import { NoiseGenerator } from './NoiseGenerator.js';
import { TrailSpline } from './TrailSpline.js';
import { createSplatMaterial } from './CustomSplatShader.js';
import { TerrainBackdrop } from './TerrainBackdrop.js';
import { TerrainChunkManager } from './TerrainChunkManager.js';

/* ============================================================
 *  Boot — async because Rapier WASM must initialise first
 * ============================================================ */

async function init() {
  // ── Rapier3D ──────────────────────────────────────────────
  await RAPIER.init();
  const rapierWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
  console.log('✅ Rapier3D initialised');

  // ── Renderer ──────────────────────────────────────────────
  const container = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ── Scene ─────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xb0c4d4, 0.0015);

  // ── Camera ────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    78,
    window.innerWidth / window.innerHeight,
    0.5,
    2000
  );
  camera.position.set(0, 35, 50);

  // ── OrbitControls (development) ───────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, -50);
  controls.maxPolarAngle = Math.PI * 0.48;

  // ── Lighting ──────────────────────────────────────────────
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
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

  // ── HDRI Skybox ───────────────────────────────────────────
  const hdrLoader = new HDRLoader();
  hdrLoader.load('/hdri/overcast_sky_1.hdr', (hdrTexture) => {
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = hdrTexture;
    scene.environment = hdrTexture;
  });

  // ── Post-processing ───────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const ssaoEffect = new SSAOEffect(camera, scene.background, {
    intensity: 1.5,
    radius: 0.12,
    luminanceInfluence: 0.6,
  });
  const vignetteEffect = new VignetteEffect({ darkness: 0.4, offset: 0.3 });
  const noiseEffect = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY });
  noiseEffect.blendMode.opacity.value = 0.06;
  const smaaEffect = new SMAAEffect();

  const effectPass = new EffectPass(camera, ssaoEffect, vignetteEffect, noiseEffect, smaaEffect);
  composer.addPass(effectPass);

  // ── Texture Loader ────────────────────────────────────────
  const texLoader = new THREE.TextureLoader();
  const loadTex = (path) => texLoader.load(path);

  const grassDiffuse = loadTex('/textures/ground_grass_diffuse.jpg');
  const grassNormal  = loadTex('/textures/ground_grass_normal.jpg');
  const grassRough   = loadTex('/textures/ground_grass_rough.jpg');
  const dirtDiffuse  = loadTex('/textures/dirt_trail_diffuse.jpg');
  const dirtNormal   = loadTex('/textures/dirt_trail_normal.jpg');
  const dirtRough    = loadTex('/textures/dirt_trail_rough.jpg');

  // ── Trail Spline ──────────────────────────────────────────
  const trail = new TrailSpline({ length: 4000, spacing: 40, wanderScale: 30 });

  // ── Splat Material ────────────────────────────────────────
  const terrainMaterial = createSplatMaterial({
    grassDiffuse, grassNormal, grassRough,
    dirtDiffuse, dirtNormal, dirtRough,
    trailSegments: trail.getSegmentData(),
    segmentCount: trail.getSegmentCount(),
    trailWidth: 3.5,
    blendEdge: 2.0,
    renderer,
  });

  // ── Noise Generator ───────────────────────────────────────
  const noiseGen = new NoiseGenerator({ seed: 42 });

  // ── Terrain Backdrop ──────────────────────────────────────
  const backdrop = new TerrainBackdrop({ scene });

  // ── Terrain Chunk Manager ─────────────────────────────────
  const chunkManager = new TerrainChunkManager({
    scene,
    rapierWorld,
    RAPIER,
    noiseGen,
    material: terrainMaterial,
    chunkSize: 64,
  });

  // Force initial chunk generation
  chunkManager.update(controls.target.x, controls.target.z);

  // ── Debug helpers ─────────────────────────────────────────
  const axesHelper = new THREE.AxesHelper(15);
  scene.add(axesHelper);

  // ── Window resize ─────────────────────────────────────────
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  // ── Animation Loop ────────────────────────────────────────
  const timer = new THREE.Timer();
  timer.connect(document);
  const MAX_DELTA = 0.1;

  function animate(timestamp) {
    requestAnimationFrame(animate);

    timer.update(timestamp);
    const delta = Math.min(timer.getDelta(), MAX_DELTA);

    // 1. Step physics
    rapierWorld.timestep = delta;
    rapierWorld.step();

    // 2. Update terrain chunks
    chunkManager.update(controls.target.x, controls.target.z);

    // 3. Update backdrop parallax
    backdrop.update(camera);

    // 4. Follow sun light to camera
    sunLight.position.set(
      controls.target.x + 80,
      120,
      controls.target.z + 60
    );
    sunLight.target.position.copy(controls.target);
    sunLight.target.updateMatrixWorld();

    // 5. Controls
    controls.update();

    // 6. Render with post-processing
    composer.render(delta);
  }

  // ── Hide loading overlay ──────────────────────────────────
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    setTimeout(() => overlay.classList.add('hidden'), 400);
  }

  // ── Start ─────────────────────────────────────────────────
  animate();

  console.log(
    '%c🚴 Cycling Game v2 — Engine started',
    'color: #7c6aef; font-weight: bold; font-size: 14px;'
  );
}

init().catch((err) => {
  console.error('Failed to initialise engine:', err);
});
