import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { StationScene } from './StationScene';

type GameMode = 'briefing' | 'playing' | 'paused' | 'complete' | 'failed';

type HudElements = {
  overlay: HTMLElement;
  overlayTitle: HTMLElement;
  overlayCopy: HTMLElement;
  startButton: HTMLButtonElement;
  healthBar: HTMLElement;
  healthValue: HTMLElement;
  chargePips: HTMLElement;
  objectiveText: HTMLElement;
  targetPanel: HTMLElement;
  targetHealthBar: HTMLElement;
  interactionHint: HTMLElement;
  damageFlash: HTMLElement;
};

const FIXED_STEP = 1 / 60;
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.42;
const MAX_CHARGE = 6;

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required interface element: ${selector}`);
  return element;
}

function normalizedKey(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: PointerLockControls;
  private readonly station = new StationScene();
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly hud: HudElements;
  private readonly muzzleLight = new THREE.PointLight(0x79f7ff, 0, 5, 2);
  private readonly movementDirection = new THREE.Vector3();
  private readonly forwardDirection = new THREE.Vector3();
  private readonly rightDirection = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();

  private mode: GameMode = 'briefing';
  private health = 100;
  private charge = MAX_CHARGE;
  private rechargeTimer = 0;
  private weaponCooldown = 0;
  private droneAttackTimer = 3.5;
  private damageFlash = 0;
  private elapsed = 0;
  private shotsFired = 0;
  private hits = 0;
  private lastFrame = performance.now();
  private wasPointerLocked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.06, 90);
    this.camera.position.copy(this.station.spawn);
    this.controls = new PointerLockControls(this.camera, this.canvas);
    this.station.scene.add(this.camera);
    this.muzzleLight.position.set(0.22, -0.18, -0.5);
    this.camera.add(this.muzzleLight);

    this.hud = {
      overlay: requiredElement('#overlay'),
      overlayTitle: requiredElement('#overlay-title'),
      overlayCopy: requiredElement('#overlay-copy'),
      startButton: requiredElement<HTMLButtonElement>('#start-button'),
      healthBar: requiredElement('#health-bar'),
      healthValue: requiredElement('#health-value'),
      chargePips: requiredElement('#charge-pips'),
      objectiveText: requiredElement('#objective-text'),
      targetPanel: requiredElement('#target-panel'),
      targetHealthBar: requiredElement('#target-health-bar'),
      interactionHint: requiredElement('#interaction-hint'),
      damageFlash: requiredElement('#damage-flash'),
    };

    this.createChargePips();
    this.bindEvents();
    this.resize();
    this.updateHud();

    window.render_game_to_text = () => this.renderGameToText();
    window.advanceTime = (milliseconds: number) => this.advanceTime(milliseconds);
    requestAnimationFrame((time) => this.frame(time));
  }

  private bindEvents(): void {
    this.hud.startButton.addEventListener('click', () => this.handlePrimaryAction());

    window.addEventListener('keydown', (event) => {
      const key = normalizedKey(event);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
        event.preventDefault();
      }

      if (event.repeat && (key === ' ' || key === 'Enter')) return;
      this.keys.add(key);

      if (key === 'Enter') this.handlePrimaryAction();
      if (key === ' ' && this.mode === 'playing') this.fireWeapon();
      if (key === 'r') this.startRun();
      if (key === 'f') void this.toggleFullscreen();
    });

    window.addEventListener('keyup', (event) => {
      this.keys.delete(normalizedKey(event));
    });

    this.canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (this.mode === 'playing' && this.controls.isLocked) this.fireWeapon();
      else if (this.mode === 'playing') this.controls.lock();
    });

    this.controls.addEventListener('lock', () => {
      this.wasPointerLocked = true;
      if (this.mode === 'paused') this.setMode('playing');
      this.hud.interactionHint.classList.add('is-hidden');
    });

    this.controls.addEventListener('unlock', () => {
      if (this.wasPointerLocked && this.mode === 'playing') this.pauseRun();
      this.hud.interactionHint.classList.remove('is-hidden');
    });

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('fullscreenchange', () => this.resize());
  }

  private handlePrimaryAction(): void {
    if (this.mode === 'briefing' || this.mode === 'complete' || this.mode === 'failed') {
      this.startRun();
      return;
    }
    if (this.mode === 'paused') {
      this.setMode('playing');
      this.controls.lock();
    }
  }

  private startRun(): void {
    this.health = 100;
    this.charge = MAX_CHARGE;
    this.rechargeTimer = 0;
    this.weaponCooldown = 0;
    this.droneAttackTimer = 3.5;
    this.damageFlash = 0;
    this.elapsed = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.keys.clear();
    this.station.reset();
    this.camera.position.copy(this.station.spawn);
    this.camera.rotation.set(0, 0, 0);
    this.setMode('playing');
    this.updateHud();
    this.controls.lock();
  }

  private pauseRun(): void {
    if (this.mode !== 'playing') return;
    this.setMode('paused');
    this.showOverlay(
      'LINK<br><span>PAUSED</span>',
      'Mouse capture released. The station simulation is paused.',
      'RESUME MISSION',
    );
  }

  private completeRun(): void {
    this.setMode('complete');
    if (this.controls.isLocked) this.controls.unlock();
    this.showOverlay(
      'BULKHEAD<br><span>UNLOCKED</span>',
      'Security link severed. The emergency route is open. Technical-slice objective complete.',
      'RUN AGAIN',
    );
  }

  private failRun(): void {
    this.setMode('failed');
    if (this.controls.isLocked) this.controls.unlock();
    this.showOverlay(
      'SIGNAL<br><span>LOST</span>',
      'Suit telemetry failed under hostile fire. Reinitialize the incident simulation.',
      'RESTART',
    );
  }

  private setMode(mode: GameMode): void {
    this.mode = mode;
    this.hud.overlay.classList.toggle('is-hidden', mode === 'playing');
    document.body.dataset.mode = mode;
  }

  private showOverlay(title: string, copy: string, button: string): void {
    this.hud.overlayTitle.innerHTML = title;
    this.hud.overlayCopy.textContent = copy;
    this.hud.startButton.textContent = button;
    this.hud.overlay.classList.remove('is-hidden');
  }

  private update(delta: number): void {
    this.elapsed += delta;
    this.station.update(this.elapsed, delta);
    this.weaponCooldown = Math.max(0, this.weaponCooldown - delta);
    this.damageFlash = Math.max(0, this.damageFlash - delta * 2.8);
    this.muzzleLight.intensity = THREE.MathUtils.damp(this.muzzleLight.intensity, 0, 22, delta);

    if (this.mode !== 'playing') {
      this.updateHud();
      return;
    }

    this.updateMovement(delta);
    this.updateWeaponCharge(delta);
    this.updateDroneAttack(delta);
    this.updateHud();
  }

  private updateMovement(delta: number): void {
    const forward = Number(this.keys.has('w') || this.keys.has('ArrowUp')) - Number(this.keys.has('s') || this.keys.has('ArrowDown'));
    const strafe = Number(this.keys.has('d') || this.keys.has('ArrowRight')) - Number(this.keys.has('a') || this.keys.has('ArrowLeft'));
    if (forward === 0 && strafe === 0) {
      this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, PLAYER_HEIGHT, 12, delta);
      return;
    }

    this.controls.getDirection(this.forwardDirection);
    this.forwardDirection.y = 0;
    this.forwardDirection.normalize();
    this.rightDirection.crossVectors(this.forwardDirection, this.camera.up).normalize();
    this.movementDirection
      .copy(this.forwardDirection)
      .multiplyScalar(forward)
      .addScaledVector(this.rightDirection, strafe)
      .normalize();

    const sprinting = this.keys.has('Shift');
    const speed = sprinting ? 6.3 : 3.8;
    const distance = speed * delta;

    this.candidate.copy(this.camera.position);
    this.candidate.x += this.movementDirection.x * distance;
    if (this.station.canOccupy(this.candidate.x, this.camera.position.z, PLAYER_RADIUS)) {
      this.camera.position.x = this.candidate.x;
    }

    this.candidate.copy(this.camera.position);
    this.candidate.z += this.movementDirection.z * distance;
    if (this.station.canOccupy(this.camera.position.x, this.candidate.z, PLAYER_RADIUS)) {
      this.camera.position.z = this.candidate.z;
    }

    const bob = Math.sin(this.elapsed * (sprinting ? 13 : 9)) * (sprinting ? 0.045 : 0.027);
    this.camera.position.y = PLAYER_HEIGHT + bob;
  }

  private updateWeaponCharge(delta: number): void {
    if (this.charge >= MAX_CHARGE) {
      this.rechargeTimer = 0;
      return;
    }
    this.rechargeTimer += delta;
    if (this.rechargeTimer >= 1.1) {
      this.rechargeTimer -= 1.1;
      this.charge += 1;
    }
  }

  private updateDroneAttack(delta: number): void {
    if (!this.station.droneAlive) return;
    this.droneAttackTimer -= delta;
    if (this.droneAttackTimer > 0) return;
    this.droneAttackTimer = 3.25;
    this.health = Math.max(0, this.health - 12);
    this.damageFlash = 1;
    if (this.health === 0) this.failRun();
  }

  private fireWeapon(): void {
    if (this.mode !== 'playing' || this.weaponCooldown > 0 || this.charge <= 0) return;
    this.weaponCooldown = 0.22;
    this.charge -= 1;
    this.rechargeTimer = 0;
    this.shotsFired += 1;
    this.muzzleLight.intensity = 9;

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 28;
    const intersections = this.raycaster.intersectObjects(this.station.droneTargets, true);
    if (!intersections.length || !this.station.droneAlive) {
      this.updateHud();
      return;
    }

    this.hits += 1;
    const remaining = this.station.damageDrone();
    if (remaining === 0) this.completeRun();
    this.updateHud();
  }

  private createChargePips(): void {
    this.hud.chargePips.replaceChildren();
    for (let index = 0; index < MAX_CHARGE; index += 1) {
      const pip = document.createElement('i');
      pip.dataset.index = String(index);
      this.hud.chargePips.append(pip);
    }
  }

  private updateHud(): void {
    this.hud.healthValue.textContent = String(this.health).padStart(3, '0');
    this.hud.healthBar.style.width = `${this.health}%`;
    this.hud.damageFlash.style.opacity = String(this.damageFlash * 0.34);
    [...this.hud.chargePips.children].forEach((pip, index) => {
      pip.classList.toggle('is-live', index < this.charge);
    });

    const droneHealthPercent = (this.station.droneHealth / 3) * 100;
    this.hud.targetHealthBar.style.width = `${droneHealthPercent}%`;
    this.hud.targetPanel.classList.toggle('is-disabled', !this.station.droneAlive);
    this.hud.objectiveText.textContent = this.station.doorUnlocked
      ? 'Emergency bulkhead unlocked'
      : 'Disable the security drone';
  }

  private render(): void {
    this.renderer.render(this.station.scene, this.camera);
  }

  private frame(time: number): void {
    const delta = Math.min((time - this.lastFrame) / 1000, 0.05);
    this.lastFrame = time;
    this.update(delta);
    this.render();
    requestAnimationFrame((nextTime) => this.frame(nextTime));
  }

  private advanceTime(milliseconds: number): void {
    const steps = Math.max(1, Math.round(milliseconds / (FIXED_STEP * 1000)));
    for (let index = 0; index < steps; index += 1) this.update(FIXED_STEP);
    this.render();
  }

  private renderGameToText(): string {
    const look = this.controls.getDirection(new THREE.Vector3());
    const heading = (Math.atan2(look.x, -look.z) * 180) / Math.PI;
    return JSON.stringify({
      coordinateSystem: 'Three.js world; y up; player begins at z=8 looking toward negative z',
      mode: this.mode,
      objective: this.station.doorUnlocked ? 'bulkhead-unlocked' : 'disable-security-drone',
      player: {
        x: Number(this.camera.position.x.toFixed(2)),
        y: Number(this.camera.position.y.toFixed(2)),
        z: Number(this.camera.position.z.toFixed(2)),
        headingDegrees: Number(heading.toFixed(1)),
        health: this.health,
      },
      weapon: { charge: this.charge, maxCharge: MAX_CHARGE, shotsFired: this.shotsFired, hits: this.hits },
      drone: {
        active: this.station.droneAlive,
        health: this.station.droneHealth,
        position: {
          x: Number(this.station.drone.position.x.toFixed(2)),
          y: Number(this.station.drone.position.y.toFixed(2)),
          z: Number(this.station.drone.position.z.toFixed(2)),
        },
      },
      door: { unlocked: this.station.doorUnlocked },
      pointerLocked: this.controls.isLocked,
    });
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.canvas.requestFullscreen();
  }
}
