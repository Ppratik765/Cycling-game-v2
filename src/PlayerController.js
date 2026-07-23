/* ============================================================
 *  PlayerController.js
 *  Physics-driven first-person bicycle controller using Rapier3D.
 *  GoPro bodycam aesthetic with spring-damper camera.
 * ============================================================ */

import * as THREE from 'three';

// ── Tuning Constants ────────────────────────────────────────

const MAX_SPEED         = 26.0;   // m/s forward
const ACCELERATION      = 8.0;    // m/s² when pedalling (W)
const BRAKE_DECEL       = 20.0;   // m/s² braking force (S while moving fwd)
const REVERSE_MAX_SPEED = 6.0;    // m/s reverse
const REVERSE_ACCEL     = 4.0;    // m/s² reverse acceleration

const LEAN_MAX_DEG      = 15.0;   // max visual roll in degrees (reduced for less extreme tilt)
const LEAN_SPEED        = 2.5;    // lerp speed for lean (reduced for smoother transition)
const TURN_RATE         = 1.2;    // yaw rate multiplier (reduced for realistic carving)

const CAM_HEIGHT        = 2.6;    // Y offset above collider centre (GoPro mount)
const CAM_SMOOTH_POS    = 6.0;    // position spring stiffness
const CAM_SMOOTH_ROT    = 8.0;    // rotation spring stiffness

const CAPSULE_HALF_H    = 0.4;    // half-height of capsule segment
const CAPSULE_RADIUS    = 0.35;   // capsule radius

const AUTO_FORWARD      = 2.0;    // constant low-speed auto-push (m/s)
const LINEAR_DAMPING    = 0.5;    // damping on the rigid body
const ANGULAR_DAMPING   = 5.0;    // prevent spinning

export class PlayerController {
  /**
   * @param {object} opts
   * @param {object} opts.RAPIER         - RAPIER module
   * @param {object} opts.rapierWorld    - RAPIER.World
   * @param {THREE.Scene} opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {THREE.Vector3} opts.spawnPos - where to spawn
   */
  constructor({ RAPIER, rapierWorld, scene, camera, spawnPos }) {
    this.RAPIER = RAPIER;
    this.world  = rapierWorld;
    this.scene  = scene;
    this.camera = camera;

    // ── Input state ─────────────────────────────────────────
    this.keys = { w: false, s: false, a: false, d: false };
    this._bindInput();

    // ── Player heading & lean ───────────────────────────────
    this.yaw          = Math.PI; // face -Z initially
    this.currentLean  = 0;       // current visual lean (radians)
    this.currentSpeed = 0;       // signed forward speed

    // ── Rapier rigid body + capsule collider ─────────────────
    const R = RAPIER;

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y + 2.0, spawnPos.z)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true)           // Prevent tunneling through heightfield
      .lockRotations();              // lock all rotation axes

    this.rigidBody = rapierWorld.createRigidBody(bodyDesc);

    // Use a ball (sphere) collider instead of a capsule so it glides perfectly over heightfield seams
    const colliderDesc = R.ColliderDesc.ball(0.5)
      .setFriction(0.0) // Zero friction so the non-rolling ball can slide smoothly
      .setRestitution(0.0)
      .setMass(75);                  // ~75 kg cyclist

    this.collider = rapierWorld.createCollider(colliderDesc, this.rigidBody);

    // ── Spring-damper camera state ──────────────────────────
    this._camPos = new THREE.Vector3().copy(spawnPos).add(new THREE.Vector3(0, CAM_HEIGHT, 0));
    this._camQuat = new THREE.Quaternion();

    // Temp objects to avoid GC
    this._forward = new THREE.Vector3();
    this._euler   = new THREE.Euler();
    this._qTarget = new THREE.Quaternion();

    // Set camera FOV wide for GoPro look
    this.camera.fov = 98;
    this.camera.updateProjectionMatrix();
  }

  /** Call every frame with delta time. */
  update(delta) {
    if (delta <= 0) return;

    this._updateMovement(delta);
    this._updateCamera(delta);
  }

  /** Returns player world position (for chunk manager, backdrop, etc.) */
  getPosition() {
    const t = this.rigidBody.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  // ── Movement ────────────────────────────────────────────────

  _updateMovement(delta) {
    // ── Lean & Yaw ────────────────────────────────────────────
    // Normalized speed (0.0 to 1.0)
    const speedFactor = Math.min(Math.abs(this.currentSpeed) / MAX_SPEED, 1.0);

    // Lean increases as speed increases. Minimum 10% lean so it doesn't look stiff.
    const maxLean = (LEAN_MAX_DEG * (Math.PI / 180)) * Math.max(0.1, speedFactor);

    let targetLean = 0;
    if (this.keys.a) targetLean =  maxLean;
    if (this.keys.d) targetLean = -maxLean;

    this.currentLean = THREE.MathUtils.lerp(
      this.currentLean,
      targetLean,
      1.0 - Math.exp(-LEAN_SPEED * delta)
    );

    // Normalize current lean against the current max lean (yields -1.0 to 1.0)
    const leanNorm = maxLean > 0 ? (this.currentLean / maxLean) : 0;
    
    // Turn rate scales with speed (stopped = 0 turn).
    // Multiply base TURN_RATE so at max speed it turns quickly as requested.
    const dynamicTurnRate = TURN_RATE * 1.8 * speedFactor;
    
    this.yaw += leanNorm * dynamicTurnRate * delta;

    // ── Forward / Brake / Reverse ─────────────────────────────
    const vel = this.rigidBody.linvel();
    this._forward.set(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    let targetAccel = 0;

    if (this.keys.w) {
      // Pedal: accelerate toward max speed with simulated air resistance (drag)
      // Acceleration drops quadratically as you approach MAX_SPEED
      const speedRatio = Math.max(0, this.currentSpeed) / MAX_SPEED;
      const drag = Math.pow(speedRatio, 2);
      targetAccel = ACCELERATION * Math.max(0, 1.0 - drag);
    } else if (this.keys.s) {
      if (this.currentSpeed > 0.5) {
        // Braking while moving forward
        targetAccel = -BRAKE_DECEL;
      } else {
        // Reverse
        targetAccel = -REVERSE_ACCEL;
      }
    } else {
      // No input: gentle auto-forward push or slight coasting friction
      if (this.currentSpeed < AUTO_FORWARD) {
        targetAccel = ACCELERATION * 0.3;
      } else {
        targetAccel = -2.0; // slight drag when coasting
      }
    }

    // Update virtual speed (decoupled from physical velocity so bumps don't instantly kill momentum)
    this.currentSpeed += targetAccel * delta;

    // Clamp speed
    if (this.keys.s && this.currentSpeed <= 0) {
      this.currentSpeed = Math.max(this.currentSpeed, -REVERSE_MAX_SPEED);
    } else {
      this.currentSpeed = Math.min(Math.max(this.currentSpeed, 0), MAX_SPEED);
    }

    // Compute desired velocity
    const desiredVelX = this._forward.x * this.currentSpeed;
    const desiredVelZ = this._forward.z * this.currentSpeed;

    // Apply precise velocity (arcade-style), preserving Y for gravity/falling
    this.rigidBody.setLinvel({ x: desiredVelX, y: vel.y, z: desiredVelZ }, true);
  }

  // ── Camera ──────────────────────────────────────────────────

  _updateCamera(delta) {
    const pos = this.rigidBody.translation();

    // ── Target camera position (slightly above & behind) ─────
    // Small offset behind the rider for depth
    const behindOffset = 0.3;
    const targetX = pos.x - this._forward.x * behindOffset;
    const targetY = pos.y + CAM_HEIGHT;
    const targetZ = pos.z - this._forward.z * behindOffset;

    // Spring-damper lerp
    const posAlpha = 1.0 - Math.exp(-CAM_SMOOTH_POS * delta);
    this._camPos.x = THREE.MathUtils.lerp(this._camPos.x, targetX, posAlpha);
    this._camPos.y = THREE.MathUtils.lerp(this._camPos.y, targetY, posAlpha);
    this._camPos.z = THREE.MathUtils.lerp(this._camPos.z, targetZ, posAlpha);

    this.camera.position.copy(this._camPos);

    // ── Target rotation (yaw + lean roll) ────────────────────
    this._euler.set(0, this.yaw, this.currentLean, 'YXZ');
    this._qTarget.setFromEuler(this._euler);

    const rotAlpha = 1.0 - Math.exp(-CAM_SMOOTH_ROT * delta);
    this.camera.quaternion.slerp(this._qTarget, rotAlpha);
  }

  // ── Input Binding ──────────────────────────────────────────

  _bindInput() {
    const handler = (e, pressed) => {
      let key = e.key.toLowerCase();
      
      // Map arrow keys to wasd
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
