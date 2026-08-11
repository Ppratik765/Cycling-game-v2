# Cycling Game V2

An immersive, infinite procedural cycling simulator built with Three.js and Rapier3D. This project demonstrates high-performance web graphics, physics-based vehicle mechanics, and procedural world generation directly in the browser.

## Features

### Procedural World Generation
- **Infinite 3x3 Grid Chunking**: The terrain is generated dynamically in a grid around the player, ensuring memory footprint stays low while the world feels endless.
- **Perlin Noise Elevation**: Mountains, hills, and trails are mathematically generated using procedural noise, ensuring a unique ride in every direction.
- **Parallax Backdrop**: A custom ShaderMaterial manages an infinite, scrolling mountain ridgeline that seamlessly blends into the atmospheric fog.

### Advanced Foliage & Particle Systems
- **GPU-Instanced Rendering**: Renders thousands of pampas grass blades and dense Cherry Blossom tree canopies in a single draw call utilizing `THREE.InstancedMesh`.
- **Wind Physics Shaders**: Foliage uses custom vertex shaders (`macroPhase` and `microPhase` mathematical curves) to simulate realistic wind displacement at zero CPU cost.
- **Dynamic Petal Particles**: Features a highly optimized Cherry Blossom petal particle system. Instead of CPU-bound lifetime updates, the petals run entirely on the GPU with an infinite wrap-around coordinate system, simulating a localized storm of thousands of drifting petals falling around the player.
- **Custom Chroma-Keying**: Fragment shaders utilize a precise luminance threshold (`dot(color, luma) < 0.35`) to flawlessly alpha-test AI-generated leaf textures without dark fringes or harsh blending artifacts.

### Vehicle Physics & Controller
- **First-Person Cycling Mechanics**: Powered by the Rapier3D physics engine for realistic momentum, gravity, and tire friction.
- **Dynamic Lean & Steer**: The bicycle leans deeply into corners (up to 26 degrees) mapping directly to the camera orientation for an intense sense of speed and balance.
- **Speed-Driven Camera Effects**: As the bike accelerates, the camera field of view widens and introduces high-frequency vibration/shake to simulate uneven dirt trails.
- **Skinned Mesh Rigging**: The player's virtual gloves are dynamically parented to the steering pivot, anchoring the user into the first-person perspective.

### Mobile Support
- **Analogue Virtual Joystick**: Integrated `nipplejs` for seamless, dynamic multi-touch mobile controls.
- **Dynamic Joystick Placement**: Touching anywhere on the lower half of the screen dynamically spawns the joystick.
- **Fluid Handling**: Joystick provides analogue vectors (e.g., 0.5 steering vs 1.0 binary keyboard input) for ultra-smooth leaning and acceleration directly mapped to the physics engine.

### Modern Post-Processing
- Utilizes `postprocessing` for high-performance RenderPass pipelines.
- Integrated Screen Space Ambient Occlusion (SSAO), Vignette, and Film Noise.
- Custom `CustomSplatShader` for blending terrain dirt, rock, and grass textures smoothly across steep elevation gradients.

## Development Setup

1. **Install Dependencies**
   Run the following command to install required packages:
   ```bash
   npm install
   ```

2. **Run Local Server**
   Start the Vite development server:
   ```bash
   npm run dev
   ```

3. **Controls**
   - **Keyboard**:
     - `W` / `Up Arrow`: Pedal forwards (Accelerate)
     - `S` / `Down Arrow`: Brake / Reverse
     - `A` / `Left Arrow`: Steer and lean left
     - `D` / `Right Arrow`: Steer and lean right
   - **Mobile / Touch**:
     - Touch and drag anywhere on the bottom half of the screen.
     - **Up/Down**: Accelerate / Brake
     - **Left/Right**: Steer / Lean

## Architecture

- `main.js`: Core bootstrapping, render loop, post-processing, physics initialization, and mobile detection.
- `PlayerController.js`: Maps keyboard and virtual joystick (`nipplejs`) input to Rapier3D physical forces and handles camera transforms.
- `TerrainChunkManager.js`: Handles async loading, unloading, and positional tracking of the 3x3 procedural grid.
- `FoliageSystem.js`: Handles `InstancedMesh` buffers for trees, trunks, and grass instances scattered across chunks.
- `PetalParticleSystem.js`: GPU-driven particle mesh that wraps around the player dynamically.

## Performance Notes
The engine is heavily optimized to maintain a solid 60 FPS in modern browsers:
- **Desktop Resolution**: Device Pixel Ratio is capped at `1.5x` to prevent immense fill-rate bottlenecks on Retina/4K displays.
- **Mobile Downscaling**: Automatically detects touch devices and aggressively caps the Device Pixel Ratio to `1.0` while disabling antialiasing. This preserves solid 60 FPS mobile performance despite the heavy GPU overdraw of dense transparent foliage.
- Heavy procedural foliage utilizes `MeshLambertMaterial` and `MeshBasicMaterial` over `MeshStandardMaterial` to avoid unnecessary Physics Based Rendering (PBR) overhead in the fragment shader.
- Instanced shadow casting is restricted to essential geometry to preserve shadow-map rendering cycles.
