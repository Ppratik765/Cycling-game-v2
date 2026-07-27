import * as THREE from 'three';

export class PetalParticleSystem {
  constructor(scene, count = 5000) {
    this.scene = scene;
    this.count = count;

    // A simple curved plane for a petal (scaled up based on feedback)
    const geometry = new THREE.PlaneGeometry(0.25, 0.25, 2, 2);
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
      transparent: true,
      depthWrite: false, // Prevents alpha sorting issues for tiny particles
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
        '#include <begin_vertex>',
        `
        vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        
        // Wrap logic: keep petals within a 60m radius of the player
        float range = 120.0;
        float halfRange = 60.0;
        
        vec3 localPos = worldInst.xyz - uPlayerPos;
        vec3 wrappedPos = mod(localPos + halfRange, range) - halfRange + uPlayerPos;
        
        // Time-based wind physics
        float t = uTime * 1.5;
        float idOffset = worldInst.x * 0.1 + worldInst.y * 0.2 + worldInst.z * 0.3;
        
        // Drift + Swirl
        vec3 drift = vec3(
          sin(t + idOffset) * 2.0 + sin(t * 0.5 + idOffset * 2.0) * 1.5,
          -mod(t * 3.0 + idOffset * 10.0, 40.0) + 20.0, // Falling logic inside wrapped height
          cos(t * 1.2 + idOffset) * 2.0 + sin(t * 0.8 + idOffset * 1.5) * 1.5
        );
        
        // Apply wind direction (blowing generally across the trail)
        drift.x += t * 2.0; 
        drift.z -= t * 1.0;

        // Animate individual rotation of the petal
        float rotPhase = t * 3.0 + idOffset * 5.0;
        mat4 rot = rotationMatrix(normalize(vec3(sin(rotPhase), cos(rotPhase * 0.8), sin(rotPhase * 1.2))), rotPhase);
        
        vec4 rotatedVertex = rot * vec4(position, 1.0);
        vec3 finalPos = wrappedPos + drift + rotatedVertex.xyz;
        
        vec3 transformed = finalPos - worldInst.xyz; // Convert back to local space offset for standard pipeline
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
