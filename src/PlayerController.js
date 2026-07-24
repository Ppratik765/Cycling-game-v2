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

const LEAN_MAX_DEG      = 25.0;   // max MotoGP lean roll in degrees
const LEAN_SPEED        = 2.0;    // lerp speed for lean
const TURN_RATE         = 1.0;    // yaw rate multiplier

const HANDLEBAR_MAX_DEG = 18.0;   // max handlebar steering angle
const HANDLEBAR_SPEED   = 4.0;    // lerp speed for handlebar rotation

const CAM_HEIGHT        = 1.3;    // Y offset (GoPro chest mount height)
const CAM_SMOOTH_POS    = 6.0;    // position spring stiffness
const CAM_SMOOTH_ROT    = 8.0;    // rotation spring stiffness
const CAM_FOV           = 95;     // GoPro-style wide FOV

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

// ── Helper: find mesh by keyword in hierarchy ────────────────
function findMeshByKeyword(root, keywords) {
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
    this.handlebarAngle = 0;

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

    // Set camera FOV
    this.camera.fov = CAM_FOV;
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
    // Auto-scale bike to reasonable first-person size
    // Measure the bike's bounding box to determine scale
    const box = new THREE.Box3().setFromObject(bikeModel);
    const bikeHeight = box.max.y - box.min.y;
    const desiredHeight = 1.1; // bike frame should be ~1.1m tall in scene
    const scale = desiredHeight / Math.max(bikeHeight, 0.01);

    bikeModel.scale.setScalar(scale);

    // Center horizontally
    box.setFromObject(bikeModel);
    const center = box.getCenter(new THREE.Vector3());
    bikeModel.position.x -= center.x;
    bikeModel.position.z -= center.z;
    bikeModel.position.y -= box.min.y; // sit on ground level

    // Log model hierarchy for debugging
    console.log('🚲 Bike model hierarchy:');
    bikeModel.traverse((child) => {
      if (child.isMesh || child.isGroup) {
        console.log(`  ${child.type}: "${child.name}"`);
      }
    });

    // Try to find handlebar/fork assembly
    this.handlebarAssembly = findMeshByKeyword(bikeModel,
      ['handlebar', 'handle_bar', 'steering', 'fork', 'steer']);

    // Try to find wheels
    this.frontWheel = findMeshByKeyword(bikeModel,
      ['front_wheel', 'frontwheel', 'wheel_front', 'wheel_f']);
    this.rearWheel = findMeshByKeyword(bikeModel,
      ['rear_wheel', 'rearwheel', 'wheel_rear', 'wheel_r', 'wheel_b', 'back_wheel']);

    // If we can't find specific wheel parts, try generic "wheel"
    if (!this.frontWheel && !this.rearWheel) {
      const wheels = [];
      bikeModel.traverse((child) => {
        if ((child.name || '').toLowerCase().includes('wheel')) {
          wheels.push(child);
        }
      });
      if (wheels.length >= 2) {
        // Sort by Z position — front wheel is more negative Z (forward)
        wheels.sort((a, b) => {
          const posA = new THREE.Vector3();
          const posB = new THREE.Vector3();
          a.getWorldPosition(posA);
          b.getWorldPosition(posB);
          return posA.z - posB.z;
        });
        this.frontWheel = wheels[0];
        this.rearWheel = wheels[wheels.length - 1];
      }
    }

    // If handlebar found, separate it into HandlebarForkAssembly
    if (this.handlebarAssembly) {
      // Create a wrapper group for handlebar steering
      this.handlebarForkGroup = new THREE.Group();
      this.handlebarForkGroup.name = 'HandlebarForkAssembly';

      // Get handlebar's world position relative to bike for pivot point
      const hbWorldPos = new THREE.Vector3();
      this.handlebarAssembly.getWorldPosition(hbWorldPos);

      // Parent the handlebar into our fork group
      const parent = this.handlebarAssembly.parent;
      if (parent) parent.remove(this.handlebarAssembly);
      this.handlebarForkGroup.add(this.handlebarAssembly);

      // If front wheel was child of handlebar, it's already there
      // Otherwise add it to the fork group too
      if (this.frontWheel && !this.handlebarForkGroup.getObjectById(this.frontWheel.id)) {
        const fwParent = this.frontWheel.parent;
        if (fwParent) fwParent.remove(this.frontWheel);
        this.handlebarForkGroup.add(this.frontWheel);
      }

      // Add fork group to lean pivot, then add remaining bike frame
      this.leanPivot.add(this.handlebarForkGroup);

      // Remaining bike goes into FrameMeshGroup
      this.frameMeshGroup = bikeModel;
      this.frameMeshGroup.name = 'FrameMeshGroup';
      this.leanPivot.add(this.frameMeshGroup);
    } else {
      // No handlebar found — treat entire bike as frame group
      this.handlebarForkGroup = null;
      this.frameMeshGroup = bikeModel;
      this.frameMeshGroup.name = 'FrameMeshGroup';
      this.leanPivot.add(this.frameMeshGroup);
    }

    // Enable shadows on all bike meshes
    bikeModel.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }

  _setupGloves(glovesModel) {
    // Right hand = original
    this.rightHand = glovesModel;
    this.rightHand.name = 'RightHand';

    // Left hand = mirrored clone
    this.leftHand = glovesModel.clone(true);
    this.leftHand.name = 'LeftHand';
    this.leftHand.scale.x = -1; // Mirror on X

    // Fix backface culling on mirrored geometry
    this.leftHand.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          m = m.clone(); // Don't modify shared materials
          m.side = THREE.DoubleSide;
          child.material = m;
        });
      }
    });

    // Scale gloves to match bike
    const gloveScale = 0.15;
    this.rightHand.scale.multiplyScalar(gloveScale);
    this.leftHand.scale.set(
      this.leftHand.scale.x * gloveScale,
      this.leftHand.scale.y * gloveScale,
      this.leftHand.scale.z * gloveScale
    );

    // Position gloves on handlebars (or at default grip positions)
    const gripSpread = 0.25;  // distance from center to each grip
    const gripHeight = 1.0;   // height of handlebars
    const gripForward = -0.4; // forward offset

    this.rightHand.position.set(gripSpread, gripHeight, gripForward);
    this.leftHand.position.set(-gripSpread, gripHeight, gripForward);

    // Attach to handlebar fork group or lean pivot
    const attachTarget = this.handlebarForkGroup || this.leanPivot;
    attachTarget.add(this.rightHand);
    attachTarget.add(this.leftHand);
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

    // ── Handlebar steering angle ────────────────────────────
    const maxHB = HANDLEBAR_MAX_DEG * (Math.PI / 180);
    let targetHB = 0;
    if (this.keys.a) targetHB =  maxHB;
    if (this.keys.d) targetHB = -maxHB;

    this.handlebarAngle = THREE.MathUtils.lerp(
      this.handlebarAngle,
      targetHB,
      1.0 - Math.exp(-HANDLEBAR_SPEED * delta)
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

    // ── Handlebar steering ──────────────────────────────────
    if (this.handlebarForkGroup) {
      this.handlebarForkGroup.rotation.y = this.handlebarAngle;
    }

    // ── Wheel spin ──────────────────────────────────────────
    const wheelSpinRate = (this.currentSpeed * delta) / WHEEL_RADIUS;
    if (this.frontWheel) {
      this.frontWheel.rotation.x += wheelSpinRate;
    }
    if (this.rearWheel) {
      this.rearWheel.rotation.x += wheelSpinRate;
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

    // Camera is parented to leanPivot; set local position + rotation
    this.camera.position.set(0, CAM_HEIGHT, 0);
    this.camera.rotation.set(
      vibX + shakeX,
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
