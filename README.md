# Cycling Game V2 🚲🌸

An advanced, high-performance, infinite procedural cycling simulator built with WebGL and Three.js. Ride through an endless cherry blossom environment with GPU-accelerated wind physics, highly tuned bike controls, and a fully dynamic terrain system.

## 🌟 Key Features

### 🚴‍♂️ Dynamic Bike & Rider Controller
- **Procedural Leaning Physics:** The bike and camera procedurally tilt and lean into turns based on speed and cornering sharpness (WASD & Arrow controls).
- **Rider Integration:** Hardcoded and rigged first-person glove models (`biker_gloves.glb`) dynamically tied to the steering column for realistic handlebar interaction.
- **Speed-Linked Camera:** Custom procedural camera vibration and bobbing that dynamically scales with the rider's speed.

### 🌸 GPU-Accelerated Cherry Blossom Engine
- **Infinite Petal Storm:** A custom `PetalParticleSystem` powering 1,500+ falling cherry blossom petals.
- **Zero CPU Overhead:** The entire particle system runs natively on the GPU vertex shader. Petals are locked to an infinite 120-meter "wrap-around" grid, guaranteeing an endless storm without requiring expensive CPU physics updates.
- **Luminance Chroma-Keying:** Custom-written fragment shaders process AI-generated 8K textures, dynamically discarding black backgrounds using a pristine luminance-based cutoff (`length < 0.35`) to ensure incredibly sharp, fringeless cutout leaves.

### ⛰️ Procedural Infinite Terrain (`TerrainChunkManager`)
- **Seamless Chunk Loading:** Uses a dynamic 3x3 rolling grid system to recycle and repurpose terrain chunks in real-time, completely eliminating memory leaks.
- **Frustum Culling:** Foliage and terrain tiles instantly drop out of the render queue when behind the camera to preserve GPU fill-rate.
- **Parallax Mountain Backdrops:** A `TerrainBackdrop` system simulating distant mountain ranges that moves synchronously with the player to sell the illusion of massive scale.

### ⚡ Extreme Performance Optimizations
- **GPU Instancing:** All grass tufts, pine trees, and broadleaf trees are rendered via `InstancedMesh`. Tens of thousands of environment props are drawn in a single draw call.
- **Pipeline Tuning:** Stripped out heavy physics-based rendering (PBR) on environment props in favor of lightweight `MeshLambertMaterial` (trees) and `MeshBasicMaterial` (petals).
- **Overdraw Eradication:** Petals are forced into the opaque render queue (eschewing traditional `transparent: true`), leveraging manual `discard` shader operations to bypass catastrophic GPU fill-rate bottlenecks.

## 🛠️ Tech Stack
- **Core Engine:** [Three.js](https://threejs.org/) (WebGL)
- **Tooling:** Vite / Node.js
- **Assets:** Procedurally generated GLSL shaders & custom AI-generated high-res `.glb` / `.png` assets.

## 🚀 Getting Started

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Local Development Server:**
   ```bash
   npm run dev
   ```

3. **Controls:**
   - `W` / `Up Arrow`: Accelerate
   - `S` / `Down Arrow`: Brake / Reverse
   - `A` / `Left Arrow`: Steer Left
   - `D` / `Right Arrow`: Steer Right

---
*Developed with extreme focus on rendering optimization and seamless gameplay.*
