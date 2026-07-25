/* ============================================================
 *  PlayerController.js
 *  Physics-driven first-person bicycle controller using Rapier3D.
 *  Features: GLTF bike + gloves, MotoGP lean, suspension,
 *  airborne physics, wheel spin, GoPro camera vibration.
 * ============================================================ */

import * as THREE from 'three';

// ── Tuning Constants ────────────────────────────────────────

const MAX_SPEED         = 26.0;   // m/s forward
const ACCELERATION      = 10.0;   // m/s² when pedalling (W)
const BRAKE_DECEL       = 20.0;   // m/s² braking force (S while moving fwd)
const REVERSE_MAX_SPEED = 6.0;    // m/s reverse
const REVERSE_ACCEL     = 4.0;    // m/s² reverse acceleration

const LEAN_MAX_DEG      = 22.0;   // max lean roll in degrees
const LEAN_SPEED        = 2.0;    // lerp speed for lean
const TURN_RATE         = 1.0;    // yaw rate multiplier

const STEER_MAX_RAD     = 0.35;   // ±20° max handlebar steering
const STEER_SPEED       = 5.0;    // lerp speed for handlebar rotation

const CAM_HEIGHT        = 1.65;   // Y offset (GoPro head/helmet mount height for seated rider)
const CAM_SMOOTH_POS    = 6.0;    // position spring stiffness
const CAM_SMOOTH_ROT    = 8.0;    // rotation spring stiffness
const CAM_FOV           = 88;     // GoPro-style wide FOV
const CAM_NEAR          = 0.05;   // Near plane — prevent clipping gloves/bars

const CAPSULE_HALF_H    = 0.4;
const CAPSULE_RADIUS    = 0.35;

const AUTO_FORWARD      = 2.0;    // constant low-speed auto-push (m/s)
const LINEAR_DAMPING    = 0.5;
const ANGULAR_DAMPING   = 5.0;

// Suspension
const SUSPENSION_REST   = 0.0;    // resting Y offset
const SUSPENSION_K      = 40.0;   // spring stiffness
const SUSPENSION_DAMP   = 8.0;    // damping coefficient
const LANDING_DIP_SCALE = 0.04;   // how much landing velocity compresses

// Airborne
const AIRBORNE_PITCH_SCALE = 0.03; // pitch sensitivity to vertical velocity
const AIRBORNE_STEER_MULT  = 0.3;  // reduced steering while airborne

// Camera vibration
const VIBRATION_INTENSITY = 0.003;
const VIBRATION_FREQ      = 25.0;

// Wheel
const WHEEL_RADIUS = 0.35;

// ── Trail equation (must match CustomSplatShader.js) ─────────
function trailCurveX(z) {
  return Math.sin(z * 0.02) * 25.0 + Math.sin(z * 0.008) * 40.0 + Math.sin(z * 0.05) * 8.0;
}

// ── German GLTF node keywords ────────────────────────────────
const STEERING_KEYWORDS = ['lenker', 'gabel', 'griffe', 'griffseiten', 'bremshebel', 'zb_vr', 'radvorne'];
const REAR_WHEEL_KEYWORDS = ['radhinten', 'zb_hr'];
const SADDLE_KEYWORDS = ['sattel'];

// ── Helper: find node by keyword in hierarchy ────────────────
function findNodeByKeyword(root, keywords) {
  let found = null;
  root.traverse((child) => {
    if (found) return;
    const name = (child.name || '').toLowerCase();
    for (const kw of keywords) {
      if (name.includes(kw)) {
        found = child;
        return;
      }
    }
  });
  return found;
}

// ── Helper: collect ALL nodes matching keywords ──────────────
function collectNodesByKeywords(root, keywords) {
  const results = [];
  root.traverse((child) => {
    const name = (child.name || '').toLowerCase();
    for (const kw of keywords) {
      if (name.includes(kw)) {
        results.push(child);
        break;
      }
    }
  });
  return results;
}

// ── Helper: determine local rolling axle axis corresponding to world right (+X) ─
function findLocalAxle(wheel, defaultAxis = new THREE.Vector3(1, 0, 0)) {
  if (!wheel) return defaultAxis;
  const worldQuat = new THREE.Quaternion();
  wheel.getWorldQuaternion(worldQuat);
  const localDir = new THREE.Vector3(1, 0, 0).applyQuaternion(worldQuat.invert());
  if (Math.abs(localDir.x) > Math.abs(localDir.y) && Math.abs(localDir.x) > Math.abs(localDir.z)) {
    return new THREE.Vector3(Math.sign(localDir.x), 0, 0);
  } else if (Math.abs(localDir.y) > Math.abs(localDir.z)) {
    return new THREE.Vector3(0, Math.sign(localDir.y), 0);
  } else {
    return new THREE.Vector3(0, 0, Math.sign(localDir.z));
  }
}

// ── Helper: Curl hand joints/bones into a closed racing fist around grips ─
function curlGloveFist(handModel, isLeft) {
  if (!handModel) return;
  let jointsCurled = 0;
  handModel.traverse((child) => {
    const name = (child.name || '').toLowerCase();
    const isFinger = name.includes('finger') || name.includes('thumb') || 
                     name.includes('index') || name.includes('middle') || 
                     name.includes('ring') || name.includes('pinky') || 
                     name.includes('little') || name.includes('joint') || 
                     name.includes('fist') || name.includes('phalanx') || child.isBone;
    if (isFinger && child !== handModel) {
      if (name.includes('thumb')) {
        child.rotation.x += isLeft ? 0.7 : 0.7;
        child.rotation.y += isLeft ? -0.5 : 0.5;
        child.rotation.z += isLeft ? 0.4 : -0.4;
      } else {
        child.rotation.x += -1.05; // Curl main fingers securely around grip
        if (child.rotation.z !== undefined) child.rotation.z *= 0.5;
      }
      jointsCurled++;
    }
    if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
      for (const [key, idx] of Object.entries(child.morphTargetDictionary)) {
        if (key.toLowerCase().match(/(fist|close|grip|clench|grasp)/)) {
          child.morphTargetInfluences[idx] = 1.0;
        }
      }
    }
  });
  if (jointsCurled > 0) {
    console.log(`✊ Clenched ${jointsCurled} joints into fist (${isLeft ? 'Left' : 'Right'} hand)`);
  }
}

export class PlayerController {
  /**
   * @param {object} opts
   * @param {object} opts.RAPIER
   * @param {object} opts.rapierWorld
   * @param {THREE.Scene} opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {THREE.Vector3} opts.spawnPos
   * @param {THREE.Group} opts.bikeModel    - GLTF .scene for bike
   * @param {THREE.Group} opts.glovesModel  - GLTF .scene for gloves
   */
  constructor({ RAPIER, rapierWorld, scene, camera, spawnPos, bikeModel, glovesModel }) {
    this.RAPIER = RAPIER;
    this.world  = rapierWorld;
    this.scene  = scene;
    this.camera = camera;

    // ── Input state ─────────────────────────────────────────
    this.keys = { w: false, s: false, a: false, d: false };
    this._bindInput();

    // ── Player heading & lean ───────────────────────────────
    this.yaw          = Math.PI; // face -Z initially
    this.currentLean  = 0;
    this.currentSpeed = 0;
    this.steerAngle = 0;

    // ── Suspension state ────────────────────────────────────
    this.suspensionOffset = 0;
    this.suspensionVel    = 0;

    // ── Airborne state ──────────────────────────────────────
    this.isGrounded     = true;
    this.wasGrounded    = true;
    this.airPitch       = 0;
    this.cameraShake    = 0;

    // ── Rapier rigid body ───────────────────────────────────
    const R = RAPIER;
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y + 2.0, spawnPos.z)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true)
      .lockRotations();
    this.rigidBody = rapierWorld.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.ball(0.5)
      .setFriction(0.0)
      .setRestitution(0.0)
      .setMass(75);
    this.collider = rapierWorld.createCollider(colliderDesc, this.rigidBody);

    // ── Build scene hierarchy ───────────────────────────────
    this._buildHierarchy(bikeModel, glovesModel);

    // ── Spring-damper camera state ──────────────────────────
    this._camPos = new THREE.Vector3().copy(spawnPos).add(new THREE.Vector3(0, CAM_HEIGHT, 0));

    // Temp objects
    this._forward = new THREE.Vector3();
    this._euler   = new THREE.Euler();
    this._qTarget = new THREE.Quaternion();
    this._rayOrigin = new THREE.Vector3();
    this._rayDir    = { x: 0.0, y: -1.0, z: 0.0 };

    // Set camera FOV & near plane
    this.camera.fov = CAM_FOV;
    this.camera.near = CAM_NEAR;
    this.camera.updateProjectionMatrix();
  }

  // ── Hierarchy Builder ──────────────────────────────────────

  _buildHierarchy(bikeModel, glovesModel) {
    // ── Root container (follows rigid body position + yaw) ──
    this.rootContainer = new THREE.Group();
    this.rootContainer.name = 'PlayerRoot';
    this.scene.add(this.rootContainer);

    // ── Suspension Container ────────────────────────────────
    this.suspensionContainer = new THREE.Group();
    this.suspensionContainer.name = 'SuspensionContainer';
    this.rootContainer.add(this.suspensionContainer);

    // ── Lean Pivot ──────────────────────────────────────────
    this.leanPivot = new THREE.Group();
    this.leanPivot.name = 'LeanPivot';
    this.suspensionContainer.add(this.leanPivot);

    // ── GoPro Camera (attached to lean pivot) ───────────────
    this.leanPivot.add(this.camera);
    this.camera.position.set(0, CAM_HEIGHT, 0);
    this.camera.rotation.set(0, 0, 0);

    // ── Bike Container (attached to lean pivot at GoPro camera height) ──
    this.bikeContainer = new THREE.Group();
    this.bikeContainer.name = 'BikeContainer';
    this.bikeContainer.position.set(0, CAM_HEIGHT, 0);
    this.leanPivot.add(this.bikeContainer);

    // ── Bike Model Integration ──────────────────────────────
    if (bikeModel) {
      this._setupBikeModel(bikeModel);
    }

    // ── Gloves Integration ──────────────────────────────────
    if (glovesModel) {
      this._setupGloves(glovesModel);
    }
  }

  _setupBikeModel(bikeModel) {
    // ── Step 1: Scale & Auto-Align Bike Orientation Straight Ahead (-Z) ──
    bikeModel.name = 'BikeModel';
    bikeModel.rotation.set(0, 0, 0);
    bikeModel.updateMatrixWorld(true);

    // Dynamically calculate forward vector from rear axle to front assembly
    const fWheelTemp = findNodeByKeyword(bikeModel, ['zb_vr', 'radvorne', 'gabel', 'lenker']);
    const rWheelTemp = findNodeByKeyword(bikeModel, REAR_WHEEL_KEYWORDS);

    if (fWheelTemp && rWheelTemp) {
      const fPos = new THREE.Vector3();
      const rPos = new THREE.Vector3();
      fWheelTemp.getWorldPosition(fPos);
      rWheelTemp.getWorldPosition(rPos);
      const forwardDir = new THREE.Vector3().subVectors(fPos, rPos);
      forwardDir.y = 0;
      if (forwardDir.lengthSq() > 0.0001) {
        forwardDir.normalize();
        // Target straight forward direction is -Z (atan2(0, -1) = Math.PI)
        bikeModel.rotation.y = Math.PI - Math.atan2(forwardDir.x, forwardDir.z);
        console.log(`🧭 Bike automatically aligned straight ahead along -Z (Y-rotation: ${(bikeModel.rotation.y * 180 / Math.PI).toFixed(1)}°)`);
      }
    } else {
      // Default positive rotation fallback if wheel nodes missing
      bikeModel.rotation.y = Math.PI / 2;
    }

    const rawBox = new THREE.Box3().setFromObject(bikeModel);
    const bikeHeight = rawBox.max.y - rawBox.min.y;
    const desiredHeight = 1.1;
    const scale = desiredHeight / Math.max(bikeHeight, 0.01);
    bikeModel.scale.setScalar(scale);

    // 1. Add carbon_frame_bike.glb to bikeContainer group
    this.bikeContainer.add(bikeModel);
    this.bikeContainer.updateMatrixWorld(true);

    console.log('🚲 Bike model hierarchy:');
    bikeModel.traverse((child) => {
      if (child.isMesh || child.isGroup) {
        console.log(`  ${child.type}: "${child.name}"`);
      }
    });

    // ── Dynamic Camera Framing ───────────────────────────────
    // 2. Traverse the bike and find handlebar/fork mesh ("lenker", "griff", "gabel", "steer")
    const handlebarMesh = findNodeByKeyword(bikeModel, ['lenker', 'griff', 'gabel', 'steer']) || bikeModel;

    // 3. Calculate exact center of the handlebars
    const barBox = new THREE.Box3().setFromObject(handlebarMesh);
    const barCenterWorld = barBox.getCenter(new THREE.Vector3());
    const barCenter = this.bikeContainer.worldToLocal(barCenterWorld.clone());

    // 4. Offset bike model INSIDE container for a seated head-mounted GoPro perspective
    // Handlebars sit ~52cm below head camera and ~45cm ahead in wide POV
    bikeModel.position.set(-barCenter.x, -barCenter.y - 0.52, -barCenter.z - 0.45);
    bikeModel.updateMatrixWorld(true);
    console.log(`🎯 Handlebars framed in head GoPro view: position=(${bikeModel.position.x.toFixed(3)}, ${bikeModel.position.y.toFixed(3)}, ${bikeModel.position.z.toFixed(3)})`);

    // ── The Steering Pivot Fix (Using Object3D.attach) ───────
    // 1. Create a new group for steering pivot
    this.steeringPivot = new THREE.Group();
    this.steeringPivot.name = 'SteeringPivot';

    // Re-calculate updated handlebar center in world space after repositioning bikeModel
    const updatedBarBox = new THREE.Box3().setFromObject(handlebarMesh);
    const updatedBarCenterWorld = updatedBarBox.getCenter(new THREE.Vector3());

    // 2 & 3. Add to bikeModel and set its position to handlebar center in bikeModel local space
    bikeModel.add(this.steeringPivot);
    bikeModel.updateMatrixWorld(true);
    this.steeringPivot.position.copy(bikeModel.worldToLocal(updatedBarCenterWorld.clone()));

    // Align steeringPivot axes with bikeContainer/world (-Z forward, +X right, +Y up)
    this.steeringPivot.quaternion.copy(bikeModel.quaternion).invert();
    this.steeringPivot.updateMatrixWorld(true);

    // Save initial Y rotation for clean steering updates in render loop
    this._baseSteerY = this.steeringPivot.rotation.y;

    // 4. CRITICAL: Update world matrices BEFORE attaching
    bikeModel.updateMatrixWorld(true);
    this.steeringPivot.updateMatrixWorld(true);

    // 5. Traverse bike model, collect all front assembly meshes (Fork, Handlebars, Front Wheel)
    const steeringParts = [];
    bikeModel.traverse((child) => {
      if (child === this.steeringPivot) return;
      const name = (child.name || '').toLowerCase();
      if (STEERING_KEYWORDS.some(kw => name.includes(kw))) {
        // Collect highest-level matching ancestor to retain original group structure
        let ancestorMatches = false;
        let curr = child.parent;
        while (curr && curr !== bikeModel) {
          const pName = (curr.name || '').toLowerCase();
          if (STEERING_KEYWORDS.some(kw => pName.includes(kw))) {
            ancestorMatches = true;
            break;
          }
          curr = curr.parent;
        }
        if (!ancestorMatches && !steeringParts.includes(child)) {
          steeringParts.push(child);
        }
      }
    });

    console.log(`🔧 Attaching ${steeringParts.length} front steering assemblies using Object3D.attach()`);
    // 6. Attach them to the pivot: preserves exact world transforms while reparenting!
    steeringParts.forEach(part => this.steeringPivot.attach(part));
    this.steeringPivot.updateMatrixWorld(true);

    // ── Wheel Setup (German Naming) ──────────────────────────
    // Front wheel is inside steeringPivot; rear wheel is inside bikeModel
    this.frontWheel = findNodeByKeyword(this.steeringPivot, ['zb_vr', 'radvorne']);
    this.rearWheel = findNodeByKeyword(bikeModel, REAR_WHEEL_KEYWORDS);

    // Detect exact local axle axes corresponding to horizontal right (world +X)
    this.bikeContainer.updateMatrixWorld(true);
    this._frontAxle = findLocalAxle(this.frontWheel);
    this._rearAxle = findLocalAxle(this.rearWheel);

    console.log(`🛞 Front wheel: ${this.frontWheel ? this.frontWheel.name : 'NOT FOUND'}, axle=(${this._frontAxle.x}, ${this._frontAxle.y}, ${this._frontAxle.z})`);
    console.log(`🛞 Rear wheel: ${this.rearWheel ? this.rearWheel.name : 'NOT FOUND'}, axle=(${this._rearAxle.x}, ${this._rearAxle.y}, ${this._rearAxle.z})`);

    // ── Enable shadows ──────────────────────────────────────
    bikeModel.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }

  _setupGloves(glovesModel) {
    // ── Step 1: Bounding-box scale normalization (~0.20m hand length) ──
    const gloveBox = new THREE.Box3().setFromObject(glovesModel);
    const gloveSize = gloveBox.getSize(new THREE.Vector3());
    const longestAxis = Math.max(gloveSize.x, gloveSize.y, gloveSize.z);
    const handScale = 0.20 / Math.max(longestAxis, 0.001);

    console.log(`🧤 Glove raw size: (${gloveSize.x.toFixed(2)}, ${gloveSize.y.toFixed(2)}, ${gloveSize.z.toFixed(2)}), scale=${handScale.toFixed(4)}`);

    // ── Step 2: Right hand ───────────────────────────────────
    this.rightHand = glovesModel;
    this.rightHand.name = 'RightHand';
    this.rightHand.scale.set(handScale, handScale, handScale);

    // ── Step 3: Mirrored left hand ──────────────────────────
    this.leftHand = glovesModel.clone(true);
    this.leftHand.name = 'LeftHand';
    this.leftHand.scale.set(-handScale, handScale, handScale);

    this.leftHand.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          const cloned = m.clone();
          cloned.side = THREE.DoubleSide;
          child.material = cloned;
        });
      }
    });

    // ── Step 4: Curl fingers into a closed fist to sell riding illusion ─
    curlGloveFist(this.rightHand, false);
    curlGloveFist(this.leftHand, true);

    // Apply local rotations so palms face down/forward to wrap around handles
    this.rightHand.rotation.set(Math.PI / 3, -0.2, -Math.PI / 2);
    this.leftHand.rotation.set(Math.PI / 3, 0.2, Math.PI / 2);

    // ── Step 5: Anchor directly onto exact 3D coordinates of handlebar grips ('Griffe') ─
    if (this.steeringPivot) {
      this.steeringPivot.updateMatrixWorld(true);
      const gripNodes = collectNodesByKeywords(this.steeringPivot, ['griff']);
      const targetBox = new THREE.Box3();
      if (gripNodes && gripNodes.length > 0) {
        gripNodes.forEach(node => targetBox.expandByObject(node));
      } else {
        const fallbackNodes = collectNodesByKeywords(this.steeringPivot, ['lenker', 'bar', 'handle', 'steer']);
        fallbackNodes.forEach(node => targetBox.expandByObject(node));
      }

      if (!targetBox.isEmpty()) {
        const centerWorld = targetBox.getCenter(new THREE.Vector3());
        const localCenter = this.steeringPivot.worldToLocal(centerWorld.clone());
        const widthWorld = targetBox.max.x - targetBox.min.x;
        const halfWidth = widthWorld > 0.15 ? (widthWorld * 0.5 * 0.82) : 0.32;

        // Place right and left fists precisely onto rubber grips
        this.rightHand.position.set(localCenter.x + halfWidth, localCenter.y + 0.01, localCenter.z - 0.02);
        this.leftHand.position.set(localCenter.x - halfWidth, localCenter.y + 0.01, localCenter.z - 0.02);
        console.log(`🎯 Fists positioned onto 'Griffe' at X=±${halfWidth.toFixed(3)}, Y=${localCenter.y.toFixed(3)}, Z=${localCenter.z.toFixed(3)}`);
      } else {
        this.rightHand.position.set(0.32, 0, 0);
        this.leftHand.position.set(-0.32, 0, 0);
      }

      this.steeringPivot.add(this.rightHand);
      this.steeringPivot.add(this.leftHand);
      console.log('🧤 Both gloves anchored directly to steeringPivot at handlebar grips');
    } else {
      this.leanPivot.add(this.rightHand);
      this.leanPivot.add(this.leftHand);
    }
  }

  // ── Update (called every frame) ────────────────────────────

  update(delta) {
    if (delta <= 0) return;

    this._updateGroundCheck();
    this._updateMovement(delta);
    this._updateSuspension(delta);
    this._updateVisuals(delta);
    this._updateCamera(delta);
  }

  getPosition() {
    const t = this.rigidBody.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  // ── Ground Check (Rapier Raycasting) ───────────────────────

  _updateGroundCheck() {
    this.wasGrounded = this.isGrounded;

    const pos = this.rigidBody.translation();
    const ray = new this.RAPIER.Ray(
      { x: pos.x, y: pos.y, z: pos.z },
      { x: 0.0, y: -1.0, z: 0.0 }
    );

    const hit = this.world.castRay(ray, 1.5, true);
    this.isGrounded = hit !== null && hit.timeOfImpact < 1.2;

    // Detect landing frame
    if (this.isGrounded && !this.wasGrounded) {
      const vel = this.rigidBody.linvel();
      const impactSpeed = Math.abs(vel.y);
      // Trigger suspension compression on landing
      this.suspensionVel = -impactSpeed * LANDING_DIP_SCALE;
      // Camera shake proportional to impact
      this.cameraShake = Math.min(impactSpeed * 0.02, 0.08);
    }
  }

  // ── Movement ───────────────────────────────────────────────

  _updateMovement(delta) {
    const speedFactor = Math.min(Math.abs(this.currentSpeed) / MAX_SPEED, 1.0);
    const steerMult = this.isGrounded ? 1.0 : AIRBORNE_STEER_MULT;

    // ── Lean (MotoGP Roll) ──────────────────────────────────
    const maxLean = (LEAN_MAX_DEG * (Math.PI / 180)) * Math.max(0.1, speedFactor);
    let targetLean = 0;
    if (this.keys.a) targetLean =  maxLean;
    if (this.keys.d) targetLean = -maxLean;

    this.currentLean = THREE.MathUtils.lerp(
      this.currentLean,
      targetLean,
      1.0 - Math.exp(-LEAN_SPEED * delta)
    );

    // ── Steering angle ──────────────────────────────────────
    let targetSteer = 0;
    if (this.keys.a) targetSteer =  STEER_MAX_RAD;
    if (this.keys.d) targetSteer = -STEER_MAX_RAD;

    this.steerAngle = THREE.MathUtils.lerp(
      this.steerAngle,
      targetSteer,
      1.0 - Math.exp(-STEER_SPEED * delta)
    );

    // ── Yaw (turning) ───────────────────────────────────────
    const leanNorm = maxLean > 0 ? (this.currentLean / maxLean) : 0;
    const dynamicTurnRate = TURN_RATE * 1.5 * speedFactor * steerMult;
    this.yaw += leanNorm * dynamicTurnRate * delta;

    // ── Forward / Brake / Reverse ───────────────────────────
    const vel = this.rigidBody.linvel();
    this._forward.set(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    let targetAccel = 0;
    if (this.keys.w) {
      const speedRatio = Math.max(0, this.currentSpeed) / MAX_SPEED;
      const drag = Math.pow(speedRatio, 2);
      targetAccel = ACCELERATION * Math.max(0, 1.0 - drag);
    } else if (this.keys.s) {
      if (this.currentSpeed > 0.5) {
        targetAccel = -BRAKE_DECEL;
      } else {
        targetAccel = -REVERSE_ACCEL;
      }
    } else {
      if (this.currentSpeed < AUTO_FORWARD) {
        targetAccel = ACCELERATION * 0.3;
      } else {
        targetAccel = -2.0;
      }
    }

    this.currentSpeed += targetAccel * delta;

    if (this.keys.s && this.currentSpeed <= 0) {
      this.currentSpeed = Math.max(this.currentSpeed, -REVERSE_MAX_SPEED);
    } else {
      this.currentSpeed = Math.min(Math.max(this.currentSpeed, 0), MAX_SPEED);
    }

    const desiredVelX = this._forward.x * this.currentSpeed;
    const desiredVelZ = this._forward.z * this.currentSpeed;
    this.rigidBody.setLinvel({ x: desiredVelX, y: vel.y, z: desiredVelZ }, true);
  }

  // ── Suspension Spring-Damper ───────────────────────────────

  _updateSuspension(delta) {
    const vel = this.rigidBody.linvel();

    // ── Airborne pitch ──────────────────────────────────────
    if (!this.isGrounded) {
      const targetPitch = -vel.y * AIRBORNE_PITCH_SCALE;
      this.airPitch = THREE.MathUtils.lerp(this.airPitch, targetPitch, 1.0 - Math.exp(-3.0 * delta));
    } else {
      this.airPitch = THREE.MathUtils.lerp(this.airPitch, 0, 1.0 - Math.exp(-6.0 * delta));
    }

    // ── Spring-damped Y compression ─────────────────────────
    const displacement = this.suspensionOffset - SUSPENSION_REST;
    const springForce = -SUSPENSION_K * displacement - SUSPENSION_DAMP * this.suspensionVel;
    this.suspensionVel += springForce * delta;
    this.suspensionOffset += this.suspensionVel * delta;

    // Clamp to prevent wild oscillation
    this.suspensionOffset = THREE.MathUtils.clamp(this.suspensionOffset, -0.3, 0.1);

    // Decay camera shake
    this.cameraShake *= Math.max(0, 1.0 - 8.0 * delta);
  }

  // ── Visual Updates (hierarchy transforms) ──────────────────

  _updateVisuals(delta) {
    const pos = this.rigidBody.translation();

    // ── Root container follows rigid body + yaw ─────────────
    this.rootContainer.position.set(pos.x, pos.y, pos.z);
    this.rootContainer.rotation.set(0, this.yaw, 0);

    // ── Suspension container: Y offset + airborne pitch ─────
    this.suspensionContainer.position.y = this.suspensionOffset;
    this.suspensionContainer.rotation.x = this.airPitch;

    // ── Lean pivot: Z-axis roll ─────────────────────────────
    this.leanPivot.rotation.z = this.currentLean;

    // ── Steering Pivot (Handlebars + Front Assembly + Gloves) ──
    if (this.steeringPivot && this._baseSteerY !== undefined) {
      this.steeringPivot.rotation.y = this._baseSteerY + this.steerAngle;
    }

    // ── Wheel Spin Physics ──────────────────────────────────
    // Calculate actual forward ground speed from Rapier3D linear velocity
    const vel = this.rigidBody.linvel();
    const horizontalVel = new THREE.Vector3(vel.x, 0, vel.z);
    let forwardSpeed = 0;
    if (horizontalVel.lengthSq() > 0.0001) {
      // Forward direction in world space is -Z rotated by player yaw
      const forwardDir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
      forwardSpeed = horizontalVel.dot(forwardDir);
      // If practically stationary, wheels MUST NOT SPIN
      if (Math.abs(forwardSpeed) < 0.05) forwardSpeed = 0;
    }

    if (forwardSpeed !== 0) {
      const spinAngle = (forwardSpeed * delta) / WHEEL_RADIUS;
      // Rotate safely around detected local axle axes
      if (this.frontWheel && this._frontAxle) {
        this.frontWheel.rotateOnAxis(this._frontAxle, spinAngle);
      }
      if (this.rearWheel && this._rearAxle) {
        this.rearWheel.rotateOnAxis(this._rearAxle, spinAngle);
      }
    }
  }

  // ── Camera ─────────────────────────────────────────────────

  _updateCamera(delta) {
    // Camera is a child of leanPivot, so it inherits lean + suspension.
    // We apply vibration as a local offset.

    const speedNorm = Math.abs(this.currentSpeed) / MAX_SPEED;
    const elapsed = performance.now() * 0.001;

    // ── GoPro vibration ─────────────────────────────────────
    const vibX = Math.sin(elapsed * VIBRATION_FREQ) * VIBRATION_INTENSITY * speedNorm;
    const vibY = Math.cos(elapsed * VIBRATION_FREQ * 1.3) * VIBRATION_INTENSITY * 0.7 * speedNorm;
    const vibZ = Math.sin(elapsed * VIBRATION_FREQ * 0.7 + 1.0) * VIBRATION_INTENSITY * 0.5 * speedNorm;

    // ── Camera shake from landing ───────────────────────────
    const shakeX = (Math.random() - 0.5) * this.cameraShake;
    const shakeY = (Math.random() - 0.5) * this.cameraShake;

    // Base helmet GoPro pitch (tilted slightly down towards handlebars and trail)
    const basePitch = -0.15; // ~8.6° downward tilt

    // Camera is parented to leanPivot; set local position + rotation
    this.camera.position.set(0, CAM_HEIGHT, 0);
    this.camera.rotation.set(
      basePitch + vibX + shakeX,
      0,
      vibY + shakeY,
      'YXZ'
    );
  }

  // ── Input Binding ──────────────────────────────────────────

  _bindInput() {
    const handler = (e, pressed) => {
      let key = e.key.toLowerCase();

      if (key === 'arrowup') key = 'w';
      if (key === 'arrowdown') key = 's';
      if (key === 'arrowleft') key = 'a';
      if (key === 'arrowright') key = 'd';

      if (key in this.keys) {
        this.keys[key] = pressed;
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', (e) => handler(e, true));
    window.addEventListener('keyup',   (e) => handler(e, false));
  }
}
