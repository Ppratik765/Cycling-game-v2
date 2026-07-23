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
  BlendFunction
} from 'postprocessing';

// ── Game modules ────────────────────────────────────────────
import { NoiseGenerator } from './NoiseGenerator.js';
import { createSplatMaterial } from './CustomSplatShader.js';
import { TerrainBackdrop } from './TerrainBackdrop.js';
import { TerrainChunkManager } from './TerrainChunkManager.js';
import { PlayerController } from './PlayerController.js';
import { FoliageSystem } from './FoliageSystem.js';
import { LoadingProgress } from './LoadingProgress.js';

/* ============================================================
 *  Promisified texture helpers
 * ============================================================ */

function loadTexPromise(loader, path) {
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      (tex) => resolve(tex),
      undefined,
      (err) => reject(new Error(`Failed to load texture: ${path}`))
    );
  });
}

function loadHDRPromise(loader, path) {
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      (tex) => resolve(tex),
      undefined,
      (err) => reject(new Error(`Failed to load HDR: ${path}`))
    );
  });
}

/* ============================================================
 *  Boot — async because Rapier WASM must initialise first
 * ============================================================ */

async function init() {
  const progress = new LoadingProgress();

  // ── Register all loading steps with weights ─────────────
  const stepTextures  = progress.addStep('Loading terrain textures…', 3);
  const stepSkybox    = progress.addStep('Loading skybox…', 2);
  const stepTerrain   = progress.addStep('Generating terrain…', 2);
  const stepFoliage   = progress.addStep('Planting foliage…', 1);
  const stepShaders   = progress.addStep('Compiling shaders…', 1);
  const stepFinalize  = progress.addStep('Finalizing world…', 1);

  try {
    // ── Rapier3D ──────────────────────────────────────────────
    await RAPIER.init();
    const rapierWorld = new RAPIER.World({ x: 0.0, y: -14.0, z: 0.0 });
    console.log('✅ Rapier3D initialised');

    // ── Renderer ──────────────────────────────────────────────
    const container = document.getElementById('app');
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.65; // Lower exposure for a moodier overcast look
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#b8bcc0', 120, 190);
    scene.background = new THREE.Color('#b8bcc0');

    // ── Camera ────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(
      window.innerWidth < window.innerHeight ? 110 : 98,  // Wider FOV for mobile portrait mode
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

    const sunLight = new THREE.DirectionalLight(0xfff4e5, 1.2); // Reduced intensity for overcast feel
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

    // ── Step 1: Load terrain textures ─────────────────────────
    progress.startStep(stepTextures);
    const texLoader = new THREE.TextureLoader();

    const [grassDiffuse, grassNormal, grassRough, dirtDiffuse, dirtNormal, dirtRough] =
      await Promise.all([
        loadTexPromise(texLoader, '/textures/ground_grass_diffuse.jpg'),
        loadTexPromise(texLoader, '/textures/ground_grass_normal.jpg'),
        loadTexPromise(texLoader, '/textures/ground_grass_rough.jpg'),
        loadTexPromise(texLoader, '/textures/dirt_trail_diffuse.jpg'),
        loadTexPromise(texLoader, '/textures/dirt_trail_normal.jpg'),
        loadTexPromise(texLoader, '/textures/dirt_trail_rough.jpg'),
      ]);
    progress.completeStep(stepTextures);

    // ── Step 2: Load HDRI skybox ──────────────────────────────
    progress.startStep(stepSkybox);

    // ── Terrain Backdrop (create early so we can syncFogColor after HDRI) ──
    const noiseGen = new NoiseGenerator({ seed: 42 });
    const backdrop = new TerrainBackdrop({ scene });

    const hdrLoader = new HDRLoader();
    const hdrTexture = await loadHDRPromise(hdrLoader, '/hdri/overcast_sky_1.hdr');
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = hdrTexture;
    scene.environment = hdrTexture;

    // Sync fog color to match the HDRI's horizon tone
    const hdriHorizonColor = new THREE.Color(0xb8bcc0);
    scene.fog.color.copy(hdriHorizonColor);
    backdrop.syncFogColor(hdriHorizonColor);

    progress.completeStep(stepSkybox);

    // ── Post-processing ───────────────────────────────────────
    const composer = new EffectComposer(renderer, { multisampling: 2 });
    composer.addPass(new RenderPass(scene, camera));

    const ssaoEffect = new SSAOEffect(camera, scene.background, {
      intensity: 1.5,
      radius: 0.12,
      luminanceInfluence: 0.6,
    });
    const vignetteEffect = new VignetteEffect({ darkness: 0.4, offset: 0.3 });
    const effectPass = new EffectPass(camera, ssaoEffect, vignetteEffect);
    composer.addPass(effectPass);

    // ── Splat Material ────────────────────────────────────────
    const terrainMaterial = createSplatMaterial({
      grassDiffuse, grassNormal, grassRough,
      dirtDiffuse, dirtNormal, dirtRough,
      renderer,
    });

    // ── Step 3: Generate terrain ──────────────────────────────
    progress.startStep(stepTerrain);
    await LoadingProgress.yieldToUI(); // Let the browser paint before heavy sync work

    const foliage = new FoliageSystem(scene, noiseGen);

    const chunkManager = new TerrainChunkManager({
      scene,
      rapierWorld,
      RAPIER,
      noiseGen,
      material: terrainMaterial,
      foliage,
      chunkSize: 200,
    });

    // Force initial 3x3 chunk generation asynchronously to keep UI responsive
    await chunkManager.initAsync(0, 0, LoadingProgress.yieldToUI);
    progress.completeStep(stepTerrain);

    // ── Step 4: Foliage planted ───────────────────────────────
    progress.startStep(stepFoliage);
    await LoadingProgress.yieldToUI();
    // Foliage was already populated inside chunkManager.init() via foliage.populateChunk()
    progress.completeStep(stepFoliage);

    // ── Player Controller ─────────────────────────────────────
    // Spawn ON the trail curve so terrain is guaranteed to be there
    const spawnZ = 0;
    const spawnX = Math.sin(spawnZ * 0.02) * 25.0 + Math.sin(spawnZ * 0.008) * 40.0 + Math.sin(spawnZ * 0.05) * 8.0;
    const spawnY = noiseGen.getHeight(spawnX, spawnZ) + 10.0;
    const player = new PlayerController({
      RAPIER,
      rapierWorld,
      scene,
      camera,
      spawnPos: new THREE.Vector3(spawnX, spawnY, spawnZ),
    });

    // Pre-step physics so the player settles onto terrain before rendering
    for (let i = 0; i < 60; i++) {
      rapierWorld.timestep = 1 / 60;
      rapierWorld.step();
      if (i % 15 === 0) await LoadingProgress.yieldToUI(); // prevent freeze during physics
    }

    // ── Step 5: Compile shaders ───────────────────────────────
    progress.startStep(stepShaders);
    await LoadingProgress.yieldToUI();
    renderer.compile(scene, camera);
    progress.completeStep(stepShaders);

    // ── Step 6: Finalize ──────────────────────────────────────
    progress.startStep(stepFinalize);
    await LoadingProgress.yieldToUI();

    // Render one warm-up frame to avoid first-frame stutter
    composer.render(0.016);
    progress.completeStep(stepFinalize);

    // ── Window resize ─────────────────────────────────────────
    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.fov = window.innerWidth < window.innerHeight ? 110 : 98; // Dynamically adjust FOV for portrait
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 100)); // Ensure layout settles before resizing

    // ── Animation Loop ────────────────────────────────────────
    const timer = new THREE.Timer();
    timer.connect(document);
    const MAX_DELTA = 0.1;
    const TIME_STEP = 1 / 60;
    let physicsAccumulator = 0;
    let elapsed = 0;

    function animate(timestamp) {
      requestAnimationFrame(animate);

      timer.update(timestamp);
      const delta = Math.min(timer.getDelta(), MAX_DELTA);

      // 1. Step physics with fixed timestep accumulator (prevents tunneling on lag spikes)
      physicsAccumulator += delta;
      rapierWorld.timestep = TIME_STEP;
      while (physicsAccumulator >= TIME_STEP) {
        rapierWorld.step();
        physicsAccumulator -= TIME_STEP;
      }

      // 2. Update player controller
      player.update(delta);
      const playerPos = player.getPosition();

      // 3. Update terrain chunks around player
      chunkManager.update(playerPos.x, playerPos.z);

      // 3.5 Update foliage wind animation
      elapsed += delta;
      foliage.update(elapsed);

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

    // ── All loaded — reveal the game ─────────────────────────
    progress.showReady();
    await new Promise(r => setTimeout(r, 400)); // Brief pause on "Ready!" so the user sees it
    progress.hideOverlay();
    animate();

    console.log(
      '%c🚴 Cycling Game v2 — Engine started',
      'color: #7c6aef; font-weight: bold; font-size: 14px;'
    );

  } catch (err) {
    // Show error on overlay instead of hanging
    console.error('Failed to load:', err);
    const errorEl = document.getElementById('loading-error');
    const errorDetailEl = document.getElementById('loading-error-detail');
    const progressWrapper = document.getElementById('loading-progress-wrapper');
    if (progressWrapper) progressWrapper.style.display = 'none';
    if (errorEl) errorEl.classList.remove('loading-error-hidden');
    if (errorDetailEl) errorDetailEl.textContent = err?.message || String(err);
  }
}

init().catch((err) => {
  console.error('Failed to initialise engine:', err);
});
