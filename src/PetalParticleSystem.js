import * as THREE from 'three';

export class PetalParticleSystem {
  constructor(scene, count = 5000) {
    this.scene = scene;
    this.count = count;

    // A simple curved plane for a petal (scaled to 0.18 to balance visibility and GPU fill-rate)
    const geometry = new THREE.PlaneGeometry(0.18, 0.18, 2, 2);
    // Add slight curve
    const pos = geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 2] += Math.sin(pos[i] * 10.0) * 0.02; 
    }
    geometry.computeVertexNormals();

    const texLoader = new THREE.TextureLoader();
    const petalTex = texLoader.load('/textures/cherry_blossom_petal.png');
    petalTex.colorSpace = THREE.SRGBColorSpace;

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffe4e1, // misty rose tint
      map: petalTex,
      side: THREE.DoubleSide,
      roughness: 0.8,
      depthWrite: true, // Standard depth write since we are discarding pixels instead of blending
    });

    this.uTime = { value: 0 };
    this.uPlayerPos = { value: new THREE.Vector3() };

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uPlayerPos = this.uPlayerPos;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec3 uPlayerPos;

        mat4 rotationMatrix(vec3 axis, float angle) {
            axis = normalize(axis);
            float s = sin(angle);
            float c = cos(angle);
            float oc = 1.0 - c;
            
            return mat4(oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,  0.0,
                        oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,  0.0,
                        oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c,           0.0,
                        0.0,                                0.0,                                0.0,                                1.0);
        }
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        
        // Extract instance center
        #ifdef USE_INSTANCING
          vec3 instCenter = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #else
          vec3 instCenter = vec3(0.0);
        #endif
        
        float range = 120.0;
        float halfRange = 60.0;
        
        // Wrap the INSTANCE CENTER around the player
        vec3 centerLocal = instCenter - uPlayerPos;
        vec3 centerWrapped = mod(centerLocal + halfRange, range) - halfRange + uPlayerPos;
        
        // Calculate the vertex offset from the instance center (preserves initial rotation and scale)
        vec3 vertexOffset = mvPosition.xyz - instCenter;
        
        // Time-based wind physics
        float t = uTime * 1.5;
        float idOffset = instCenter.x * 0.1 + instCenter.y * 0.2 + instCenter.z * 0.3;
        
        // Gentle Drift + Swirl + Fall (Removed aggressive directional wind so they stay anchored in world space)
        vec3 drift = vec3(
          sin(t + idOffset) * 1.5 + sin(t * 0.5 + idOffset * 2.0) * 1.0,
          -mod(t * 1.5 + idOffset * 10.0, 40.0) + 20.0, 
          cos(t * 1.2 + idOffset) * 1.5 + sin(t * 0.8 + idOffset * 1.5) * 1.0
        );
        
        // Additional individual rotation animation (spinning while falling)
        float rotPhase = t * 3.0 + idOffset * 5.0;
        mat4 rot = rotationMatrix(normalize(vec3(sin(rotPhase), cos(rotPhase * 0.8), sin(rotPhase * 1.2))), rotPhase);
        vec3 animatedVertexOffset = (rot * vec4(vertexOffset, 1.0)).xyz;
        
        // Final world position
        vec3 finalWorldPos = centerWrapped + drift + animatedVertexOffset;
        
        mvPosition = modelViewMatrix * vec4(finalWorldPos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        `
        #include <alphatest_fragment>
        #ifdef USE_MAP
          vec4 texelColorRaw = texture2D( map, vMapUv );
          // Discard dark background
          if (texelColorRaw.r < 0.1 && texelColorRaw.g < 0.1 && texelColorRaw.b < 0.1) discard;
          
          // Boost brightness of the petals
          diffuseColor.rgb *= 1.2;
        #endif
        `
      );
    };

    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.count);
    
    const dummy = new THREE.Object3D();
    const range = 120;
    
    // Distribute randomly in a 120x120x40 volume
    for (let i = 0; i < this.count; i++) {
      dummy.position.set(
        (Math.random() - 0.5) * range,
        Math.random() * 40,
        (Math.random() - 0.5) * range
      );
      
      // Random initial rotation
      dummy.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );
      
      // Random size
      const s = 0.5 + Math.random() * 0.8;
      dummy.scale.set(s, s, s);
      
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false; // Never cull, as particles wrap around camera dynamically

    this.scene.add(this.mesh);
  }

  update(elapsed, playerPos) {
    this.uTime.value = elapsed;
    this.uPlayerPos.value.copy(playerPos);
  }
}
