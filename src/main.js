/* ============================================================
 *  Cycling Game v2 — main.js
 *  Phase 1–3: Engine, Terrain, Atmosphere
 *  Phase 4:   Player Mechanics & Bike Physics
 * ============================================================ */

import './style.css';

// ── Three.js ────────────────────────────────────────────────
import * as THREE from 'three';
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
import { createSplatMaterial } from './CustomSplatShader.js';
import { TerrainBackdrop } from './TerrainBackdrop.js';
import { TerrainChunkManager } from './TerrainChunkManager.js';
import { PlayerController } from './PlayerController.js';

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
  scene.fog = new THREE.Fog('#b5b9bc', 80, 280);
  scene.background = new THREE.Color('#b5b9bc');

  // ── Camera ────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    98,  // Wide GoPro FOV
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(0, 5, 0);

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
  noiseEffect.blendMode.opacity.value = 0.025;
  const smaaEffect = new SMAAEffect();

  const effectPass = new EffectPass(camera, ssaoEffect, vignetteEffect, noiseEffect, smaaEffect);
  composer.addPass(effectPass);

  // ── Texture Loader ────────────────────────────────────────
  const texLoader = new THREE.TextureLoader();
  const loadTex = (path) => texLoader.load(path);

  const grassDiffuse = loadTex('/textures/ground_grass_diffuse.jpg');
  const grassNormal = loadTex('/textures/ground_grass_normal.jpg');
  const grassRough = loadTex('/textures/ground_grass_rough.jpg');
  const dirtDiffuse = loadTex('/textures/dirt_trail_diffuse.jpg');
  const dirtNormal = loadTex('/textures/dirt_trail_normal.jpg');
  const dirtRough = loadTex('/textures/dirt_trail_rough.jpg');

  // ── Splat Material ────────────────────────────────────────
  const terrainMaterial = createSplatMaterial({
    grassDiffuse, grassNormal, grassRough,
    dirtDiffuse, dirtNormal, dirtRough,
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
    chunkSize: 200,
  });

  // Force initial 3x3 chunk generation
  chunkManager.init(0, 0);

  // ── Player Controller ─────────────────────────────────────
  const player = new PlayerController({
    RAPIER,
    rapierWorld,
    scene,
    camera,
    spawnPos: new THREE.Vector3(0, noiseGen.getHeight(0, 0) + 10, 0),
  });

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

    // 2. Update player controller
    player.update(delta);
    const playerPos = player.getPosition();

    // 3. Update terrain chunks around player
    chunkManager.update(playerPos.x, playerPos.z);

    // 4. Update backdrop parallax
    backdrop.update(camera);

    // 5. Follow sun light to player
    sunLight.position.set(
      playerPos.x + 80,
      120,
      playerPos.z + 60
    );
    sunLight.target.position.set(playerPos.x, playerPos.y, playerPos.z);
    sunLight.target.updateMatrixWorld();

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
