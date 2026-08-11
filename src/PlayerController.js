/* ============================================================
 *  PlayerController.js
 *  Physics-driven first-person bicycle controller using Rapier3D.
 *  Features: GLTF bike + gloves, MotoGP lean, suspension,
 *  airborne physics, wheel spin, GoPro camera vibration.
 * ============================================================ */

import * as THREE from 'three';
import nipplejs from 'nipplejs';

// ── Tuning Constants ────────────────────────────────────────

const MAX_SPEED = 26.0;   // m/s forward
const ACCELERATION = 10.0;   // m/s² when pedalling (W)
const BRAKE_DECEL = 20.0;   // m/s² braking force (S while moving fwd)
const REVERSE_MAX_SPEED = 6.0;    // m/s reverse
const REVERSE_ACCEL = 4.0;    // m/s² reverse acceleration

const LEAN_MAX_DEG = 26.0;   // max lean roll in degrees (increased for slightly more pronounced tilt)
const LEAN_SPEED = 2.0;    // lerp speed for lean
const TURN_RATE = 1.0;    // yaw rate multiplier

const STEER_MAX_RAD = 0.314;  // ±18° max handlebar steering
const STEER_SPEED = 5.0;    // lerp speed for handlebar rotation

const CAM_HEIGHT = 1.65;   // Y offset (GoPro head/helmet mount height for seated rider)
const CAM_SMOOTH_POS = 6.0;    // position spring stiffness
const CAM_SMOOTH_ROT = 8.0;    // rotation spring stiffness
const CAM_NEAR = 0.05;   // Near plane — prevent clipping gloves/bars

const CAPSULE_HALF_H = 0.4;
const CAPSULE_RADIUS = 0.35;

const AUTO_FORWARD = 2.0;    // constant low-speed auto-push (m/s)
const LINEAR_DAMPING = 0.5;
const ANGULAR_DAMPING = 5.0;

// Suspension
const SUSPENSION_REST = 0.0;    // resting Y offset
const SUSPENSION_K = 40.0;   // spring stiffness
const SUSPENSION_DAMP = 8.0;    // damping coefficient
const LANDING_DIP_SCALE = 0.04;   // how much landing velocity compresses

// Airborne
const AIRBORNE_PITCH_SCALE = 0.03; // pitch sensitivity to vertical velocity
const AIRBORNE_STEER_MULT = 0.3;  // reduced steering while airborne

// Camera vibration
const VIBRATION_INTENSITY = 0.003;
const VIBRATION_FREQ = 25.0;

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

// ── Helper: find node by keyword in hierarchy (priority order) ──
function findNodeByKeyword(root, keywords) {
  for (const kw of keywords) {
    let found = null;
    root.traverse((child) => {
      if (found) return;
      const name = (child.name || '').toLowerCase();
      if (name.includes(kw)) {
        found = child;
      }
    });
    if (found) return found;
  }
  return null;
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
    this.world = rapierWorld;
    this.scene = scene;
    this.camera = camera;

    // ── Input state ─────────────────────────────────────────
    this.keys = { w: false, s: false, a: false, d: false };
    this.joystick = { x: 0, y: 0 };
    this._bindInput();

    // ── Player heading & lean ───────────────────────────────
    this.yaw = Math.PI; // face -Z initially
    this.currentLean = 0;
    this.currentSpeed = 0;
    this.steerAngle = 0;

    // ── Suspension state ────────────────────────────────────
    this.suspensionOffset = 0;
    this.suspensionVel = 0;

    // ── Airborne state ──────────────────────────────────────
    this.isGrounded = true;
    this.wasGrounded = true;
    this.airPitch = 0;
    this.cameraShake = 0;

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
    this._euler = new THREE.Euler();
    this._qTarget = new THREE.Quaternion();
    this._rayOrigin = new THREE.Vector3();
    this._rayDir = { x: 0.0, y: -1.0, z: 0.0 };

    // Set camera near plane
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
    // ── Step 1: Scale & Orient Bike Model ────────────────────
    // GLTF forward axis is +X → rotate -90° around Y so front faces -Z.
    bikeModel.name = 'BikeModel';
    bikeModel.rotation.y = -Math.PI / 2;

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

    // ── Native Steering Pivot & Straighten Crooked Front Assembly ─
    // Using the GLTF model's native front steering root ("Lenker_285") turns the fork cleanly
    // inside the headset bearing tubes without breaking symmetry or separating from the main body!
    this.steeringPivot = bikeModel.getObjectByName('Lenker_285') || findNodeByKeyword(bikeModel, ['lenker']);
    if (this.steeringPivot) {
      // Rotate around the local Z steering column axis by -0.693 rad (-39.7°)
      // to turn from the GLTF export's crooked posture back to DEAD STRAIGHT symmetric alignment!
      this.steeringPivot.rotateZ(-0.693);
      this.steeringPivot.updateMatrixWorld(true);
      this._baseSteerRot = this.steeringPivot.quaternion.clone();
      console.log('🧭 Front assembly straightened natively inside headset bearings without separation.');
    } else {
      console.warn('⚠️ Could not locate Lenker_285 native steering pivot.');
    }

    // ── Dynamic Camera Framing & Grip Positioning ────────────
    // Locate actual rubber grips ("lenkergriff", "griffe", "griffseiten") for precise handlebar centering
    const gripNodes = collectNodesByKeywords(bikeModel, ['lenkergriff', 'griffe', 'griffseiten', 'lenker']);
    const barBox = new THREE.Box3();
    if (gripNodes.length > 0) {
      gripNodes.forEach(n => barBox.expandByObject(n));
    } else {
      const fallback = this.steeringPivot || bikeModel;
      barBox.setFromObject(fallback);
    }
    const barCenterWorld = barBox.getCenter(new THREE.Vector3());
    const barCenter = this.bikeContainer.worldToLocal(barCenterWorld.clone());

    // Offset bike model INSIDE container for an authentic head-mounted GoPro riding view
    // Positioned at Y=-0.75m and Z=-0.62m (pulled back 10cm) so handlebars and front wheel remain cleanly framed!
    bikeModel.position.set(-barCenter.x, -barCenter.y - 0.75, -barCenter.z - 0.62);
    bikeModel.updateMatrixWorld(true);
    console.log(`🎯 Handlebars & front wheel framed in GoPro view: position=(${bikeModel.position.x.toFixed(3)}, ${bikeModel.position.y.toFixed(3)}, ${bikeModel.position.z.toFixed(3)})`);

    // ── Wheel Setup (German Naming) ──────────────────────────
    // Front wheel is inside steeringPivot; rear wheel is inside bikeModel
    this.frontWheel = findNodeByKeyword(this.steeringPivot || bikeModel, ['zb_vr', 'radvorne', 'rad_vr', 'radvorn']);
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

  _curlFingers(handMesh, isLeft) {
    let bonesFound = 0;
    handMesh.traverse((child) => {
      if (child.isBone) {
        const name = child.name.toLowerCase();
        // Curl index, middle, ring, pinky
        if (name.includes('finger') || name.includes('index') || name.includes('middle') || name.includes('ring') || name.includes('pinky')) {
          child.rotation.x += 1.2; 
          bonesFound++;
        }
        // Curl thumb
        if (name.includes('thumb')) {
          child.rotation.y += (isLeft ? -0.5 : 0.5);
          child.rotation.z += 0.5;
          bonesFound++;
        }
      }
    });
    
    if (bonesFound > 0) {
      console.log(`🦴 Dynamically curled ${bonesFound} finger bones on ${isLeft ? 'Left' : 'Right'} hand!`);
    } else {
      console.log(`⚠️ No bones found in ${isLeft ? 'Left' : 'Right'} hand. Mesh is static.`);
    }
  }

  _setupGloves(glovesModel) {
    // ── Step 1: Center and scale raw glove geometry (~0.16m fist size) ──
    const rawBox = new THREE.Box3().setFromObject(glovesModel);
    const rawCenter = rawBox.getCenter(new THREE.Vector3());
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const longestAxis = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const handScale = 0.16 / Math.max(longestAxis, 0.001);

    console.log(`🧤 Glove centered & scaled: rawSize=(${rawSize.x.toFixed(2)}, ${rawSize.y.toFixed(2)}, ${rawSize.z.toFixed(2)}), scale=${handScale.toFixed(4)}`);

    // ── Step 2: Create centered Right Hand wrapper ───────────
    this.rightHand = new THREE.Group();
    this.rightHand.name = 'RightHandWrapper';
    const rightGloveMesh = glovesModel;
    rightGloveMesh.position.copy(rawCenter).multiplyScalar(-1); // Center mesh before rotation
    this.rightHand.add(rightGloveMesh);
    this.rightHand.scale.set(handScale, handScale, handScale);

    // ── Step 3: Mirrored Left Hand wrapper (flip X scale across symmetry plane) ──
    this.leftHand = new THREE.Group();
    this.leftHand.name = 'LeftHandWrapper';
    const leftGloveMesh = glovesModel.clone(true);
    leftGloveMesh.position.copy(rawCenter).multiplyScalar(-1);
    this.leftHand.add(leftGloveMesh);
    this.leftHand.scale.set(-handScale, handScale, handScale);

    leftGloveMesh.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          const cloned = m.clone();
          cloned.side = THREE.DoubleSide;
          child.material = cloned;
        });
      }
    });

    // ── Step 4: Final Hand Placement (Hardcoded from User Tune State) ──
    this.leftHand.position.set(0.0310, 0.3162, 0.0462);
    this.leftHand.rotation.set(-12.3200, -2.8000, 1.2500);

    this.rightHand.position.set(0.0210, -0.3167, 0.0463);
    this.rightHand.rotation.set(-0.1700, -2.8500, 1.8500);

    // Attempt dynamic finger curling if the mesh has bones!
    this._curlFingers(this.rightHand, false);
    this._curlFingers(this.leftHand, true);

    if (this.steeringPivot) {
      this.steeringPivot.add(this.rightHand);
      this.steeringPivot.add(this.leftHand);
      console.log('🧤 Both gloves snapped directly onto left/right handlebar grips inside steering assembly!');
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
    if (this.keys.a) targetLean = maxLean;
    if (this.keys.d) targetLean = -maxLean;
    if (Math.abs(this.joystick.x) > 0.05) targetLean = -this.joystick.x * maxLean; // Analogue lean

    this.currentLean = THREE.MathUtils.lerp(
      this.currentLean,
      targetLean,
      1.0 - Math.exp(-LEAN_SPEED * delta)
    );

    // ── Steering angle ──────────────────────────────────────
    let targetSteer = 0;
    if (this.keys.a) targetSteer = STEER_MAX_RAD;
    if (this.keys.d) targetSteer = -STEER_MAX_RAD;
    if (Math.abs(this.joystick.x) > 0.05) targetSteer = -this.joystick.x * STEER_MAX_RAD; // Analogue steer

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
    let forwardAmount = this.keys.w ? 1 : 0;
    let backwardAmount = this.keys.s ? 1 : 0;

    // Analogue joystick throttle
    if (this.joystick.y > 0.05) forwardAmount = Math.max(forwardAmount, this.joystick.y);
    if (this.joystick.y < -0.05) backwardAmount = Math.max(backwardAmount, -this.joystick.y);

    if (forwardAmount > 0) {
      const speedRatio = Math.max(0, this.currentSpeed) / MAX_SPEED;
      const drag = Math.pow(speedRatio, 2);
      targetAccel = ACCELERATION * Math.max(0, 1.0 - drag) * forwardAmount;
    } else if (backwardAmount > 0) {
      if (this.currentSpeed > 0.5) {
        targetAccel = -BRAKE_DECEL * backwardAmount;
      } else {
        targetAccel = -REVERSE_ACCEL * backwardAmount;
      }
    } else {
      if (this.currentSpeed < AUTO_FORWARD) {
        targetAccel = ACCELERATION * 0.3;
      } else {
        targetAccel = 0;
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
    this.leanPivot.rotation.z = this.currentLean * 0.35;

    // ── Bike container dynamic roll (MotoGP / MTB tilt) ──────
    // When pressing A (turn left), the bike tilts cleanly left under the rider; pressing D tilts right!
    this.bikeContainer.rotation.z = this.currentLean * 0.85;

    // ── Steering Pivot (Handlebars + Front Assembly + Gloves) ──
    // Apply steering input as relative angle around the native headset bearing column (local Z axis)!
    if (this.steeringPivot && this._baseSteerRot) {
      const steerQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.steerAngle);
      this.steeringPivot.quaternion.copy(this._baseSteerRot).multiply(steerQuat);
    }

    // ── Speed-Proportional Wheel Rolling ────────────────────
    // 1. Get current 2D ground velocity from Rapier3D player RigidBody
    const vel = this.rigidBody.linvel();
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

    // 2. If speed < 0.1 (stationary), wheel rotation velocity MUST be 0
    if (speed >= 0.1) {
      // Direction of rotation matches forward movement; if rolling backward, invert sign
      const forwardDir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
      const velDir = new THREE.Vector3(vel.x, 0, vel.z).normalize();
      const isBackward = forwardDir.dot(velDir) < -0.2;

      const wheelRadius = 0.33; // meters
      let deltaRotation = (speed * delta) / wheelRadius;
      if (isBackward) deltaRotation = -deltaRotation;

      // 3. Rotate front and rear wheels around their local axle X-axis every frame
      if (this.frontWheel) {
        if (this._frontAxle) this.frontWheel.rotateOnAxis(this._frontAxle, deltaRotation);
        else this.frontWheel.rotateX(deltaRotation);
      }
      if (this.rearWheel) {
        if (this._rearAxle) this.rearWheel.rotateOnAxis(this._rearAxle, deltaRotation);
        else this.rearWheel.rotateX(deltaRotation);
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

    // Base helmet GoPro pitch (tilted -15° downward toward handlebars and front wheel)
    const basePitch = -0.26; // ~15° downward tilt to cleanly frame spinning front wheel!

    // In portrait mode, the screen is narrow. Pull the camera back and slightly up to prevent handlebars getting cut off.
    const isPortrait = window.innerHeight > window.innerWidth;
    const zOffset = isPortrait ? 0.15 : 0.0;
    const yOffset = isPortrait ? 0.05 : 0.0;

    // Camera is parented to leanPivot; set local position + rotation
    this.camera.position.set(0, CAM_HEIGHT + yOffset, zOffset);
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
    window.addEventListener('keyup', (e) => handler(e, false));

    // Mobile Virtual Joystick Overlay
    const isMobile = window.matchMedia('(pointer: coarse)').matches || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isMobile) {
      const style = document.createElement('style');
      style.innerHTML = `
        .nipple .back { opacity: 0.3 !important; }
        .nipple .front { opacity: 1.0 !important; }
      `;
      document.head.appendChild(style);

      const zone = document.createElement('div');
      zone.style.position = 'absolute';
      zone.style.width = '100%';
      zone.style.height = '100%';
      zone.style.bottom = '0';
      zone.style.left = '0';
      zone.style.zIndex = '999';
      zone.style.touchAction = 'none'; // Prevent browser scrolling
      document.body.appendChild(zone);

      const manager = nipplejs.create({
        zone: zone,
        mode: 'dynamic',
        color: 'white',
        size: 150
      });

      manager.on('move', (evt, data) => {
        if (data && data.vector) {
          this.joystick.x = data.vector.x; // Right is positive, Left is negative
          this.joystick.y = -data.vector.y; // In browser coords, UP is negative Y, so we invert it so UP is positive Y for the throttle!
        }
      });
      
      manager.on('end', () => {
        this.joystick.x = 0;
        this.joystick.y = 0;
      });
    }
  }
}
