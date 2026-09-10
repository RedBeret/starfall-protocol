import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { StationScene } from './StationScene';
import { EscapeMission, RELAYS } from './EscapeMission';
import { guardPointerCapture } from './PointerCaptureGuard';

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
  clock: HTMLElement;
  timeRemaining: HTMLElement;
  relayList: HTMLElement;
  relayPrompt: HTMLElement;
  results: HTMLElement;
};

const FIXED_STEP = 1 / 60;
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.42;
const MAX_CHARGE = 6;
const DIRECTIONS = ['↑ NORTH', '→ EAST', '↓ SOUTH', '← WEST'];

function clockText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}

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
  private readonly mission = new EscapeMission();
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
  private manualStepping = false;
  private manualRemainder = 0;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly relayRows: HTMLElement[] = [];
  private readonly mapRelayDots: SVGCircleElement[] = [];
  private readonly mapPlayer = document.querySelector<SVGPathElement>('#map-player')!;
  private readonly mapDoor = document.querySelector<SVGPathElement>('#map-door')!;

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
    guardPointerCapture(this.controls, this.canvas.ownerDocument);
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
      clock: requiredElement('#mission-clock'),
      timeRemaining: requiredElement('#time-remaining'),
      relayList: requiredElement('#relay-list'),
      relayPrompt: requiredElement('#relay-prompt'),
      results: requiredElement('#run-results'),
    };

    this.createChargePips();
    this.createRelayHud();
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

      if (event.repeat && [' ', 'Enter', 'e', 'r', 'p', 'f', 'Escape'].includes(key)) return;
      this.keys.add(key);

      if (key === 'Enter') this.handlePrimaryAction();
      if (key === ' ' && this.mode === 'playing') this.fireWeapon();
      if (key === 'r') this.startRun();
      if (key === 'e' && this.mode === 'playing') this.interact();
      if (key === 'p' || key === 'Escape') {
        if (this.mode === 'playing') this.pauseRun();
        else if (this.mode === 'paused' && key === 'p') this.handlePrimaryAction();
      }
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
    window.addEventListener('blur', () => this.pauseRun());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseRun();
    });
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
    this.manualRemainder = 0;
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
    this.mission.reset();
    this.station.reset();
    this.syncMissionScene();
    this.hud.results.hidden = true;
    this.camera.position.copy(this.station.spawn);
    this.camera.rotation.set(0, 0, 0);
    this.setMode('playing');
    this.updateHud();
    this.controls.lock();
  }

  private pauseRun(): void {
    if (this.mode !== 'playing') return;
    this.keys.clear();
    this.setMode('paused');
    if (this.controls.isLocked) this.controls.unlock();
    this.showOverlay(
      'LINK<br><span>PAUSED</span>',
      'Mission paused. Your remaining time and relay settings are saved until you resume.',
      'RESUME MISSION',
    );
  }

  private completeRun(): void {
    this.setMode('complete');
    if (this.controls.isLocked) this.controls.unlock();
    this.showOverlay(
      'ESCAPE<br><span>CONFIRMED</span>',
      'The pod clears Ares Station. All three relays held long enough to bring you home.',
      'RUN AGAIN',
    );
    this.showResults();
  }

  private failRun(): void {
    this.mission.fail();
    this.setMode('failed');
    if (this.controls.isLocked) this.controls.unlock();
    this.showOverlay(
      'SIGNAL<br><span>LOST</span>',
      this.mission.remainingSeconds <= 0
        ? 'The escape window closed. Restore all three relays and reach the pod before orbital decay.'
        : 'Suit telemetry failed under hostile fire. Disable security, restore power, and try another route.',
      'RESTART',
    );
    this.showResults();
  }

  private setMode(mode: GameMode): void {
    this.mode = mode;
    if (mode !== 'playing') this.hud.relayPrompt.classList.add('is-hidden');
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
    if (this.mode === 'paused' || this.mode === 'failed' || this.mode === 'complete') return;
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
    if (this.mode !== 'playing') { this.updateHud(); return; }
    this.mission.tick(delta);
    if (this.mission.phase === 'failed') this.failRun();
    else if (this.station.doorPassable && this.camera.position.distanceTo(this.station.extraction) < 1.25) {
      if (this.mission.extract()) this.completeRun();
    }
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

    const bob = this.reducedMotion.matches ? 0 : Math.sin(this.elapsed * (sprinting ? 13 : 9)) * (sprinting ? 0.045 : 0.027);
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
    if (remaining === 0) {
      this.mission.disableSecurity();
      this.syncMissionScene();
    }
    this.updateHud();
  }

  private nearestRelay() {
    return this.mission.relays.find((relay) => Math.hypot(this.camera.position.x - relay.x, this.camera.position.z - relay.z) < 2.1);
  }

  private interact(): void {
    const relay = this.nearestRelay();
    if (!relay || !this.mission.rotateRelay(relay.id)) return;
    this.syncMissionScene();
    this.updateHud();
  }

  private syncMissionScene(): void {
    for (const relay of this.mission.relays) this.station.setRelayState(relay.id, relay.orientation, relay.powered);
    this.station.setDoorUnlocked(this.mission.doorUnlocked);
  }

  private createRelayHud(): void {
    const map = document.querySelector('#map-relays')!;
    RELAYS.forEach((relay, index) => {
      const row = document.createElement('li');
      this.relayRows.push(row);
      this.hud.relayList.append(row);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(relay.x));
      dot.setAttribute('cy', String(relay.z));
      dot.setAttribute('r', '0.8');
      map.append(dot);
      this.mapRelayDots.push(dot);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(relay.x));
      label.setAttribute('y', String(relay.z + 0.45));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '1.2');
      label.setAttribute('fill', '#061316');
      label.textContent = String(index + 1);
      map.append(label);
    });
  }

  private showResults(): void {
    const accuracy = this.shotsFired ? Math.round(this.hits / this.shotsFired * 100) : 0;
    this.hud.results.replaceChildren();
    for (const [label, value] of [['TIME LEFT', clockText(this.mission.remainingSeconds)], ['SUIT INTEGRITY', `${this.health}%`], ['ACCURACY', `${accuracy}%`]]) {
      const cell = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = label;
      const result = document.createElement('strong');
      result.textContent = value;
      cell.append(name, result);
      this.hud.results.append(cell);
    }
    this.hud.results.hidden = false;
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
    this.hud.objectiveText.textContent = this.mission.objective;
    this.hud.timeRemaining.textContent = clockText(this.mission.remainingSeconds);
    this.hud.clock.classList.toggle('is-urgent', this.mission.remainingSeconds <= 30);
    this.mission.relays.forEach((relay, index) => {
      this.relayRows[index].textContent = `${String(index + 1).padStart(2, '0')} ${relay.name}  ${relay.powered ? 'ONLINE' : DIRECTIONS[relay.targetOrientation]}`;
      this.relayRows[index].classList.toggle('is-powered', relay.powered);
      this.mapRelayDots[index].setAttribute('fill', relay.powered ? '#83ffd2' : '#ffc26d');
    });
    const nearest = this.nearestRelay();
    this.hud.relayPrompt.classList.toggle('is-hidden', !nearest || this.mode !== 'playing');
    const prompt = nearest ? `${nearest.name} · ${DIRECTIONS[nearest.orientation]} / target ${DIRECTIONS[nearest.targetOrientation]} · ${nearest.powered ? 'ONLINE' : '[E] ROTATE'}` : '';
    if (this.hud.relayPrompt.textContent !== prompt) this.hud.relayPrompt.textContent = prompt;
    const look = this.controls.getDirection(this.forwardDirection);
    const heading = Math.atan2(look.x, -look.z) * 180 / Math.PI;
    this.mapPlayer.setAttribute('transform', `translate(${this.camera.position.x} ${this.camera.position.z}) rotate(${heading})`);
    this.mapDoor.setAttribute('stroke', this.mission.doorUnlocked ? '#83ffd2' : '#ff5871');
  }

  private render(): void {
    this.renderer.render(this.station.scene, this.camera);
  }

  private frame(time: number): void {
    const delta = Math.min((time - this.lastFrame) / 1000, 0.05);
    this.lastFrame = time;
    if (!this.manualStepping) this.update(delta);
    this.render();
    requestAnimationFrame((nextTime) => this.frame(nextTime));
  }

  private advanceTime(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 600_000) return;
    this.manualStepping = true;
    this.manualRemainder += milliseconds / 1000;
    const steps = Math.floor((this.manualRemainder + 1e-9) / FIXED_STEP);
    this.manualRemainder -= steps * FIXED_STEP;
    for (let index = 0; index < steps; index += 1) this.update(FIXED_STEP);
    this.render();
  }

  private renderGameToText(): string {
    const look = this.controls.getDirection(new THREE.Vector3());
    const heading = (Math.atan2(look.x, -look.z) * 180) / Math.PI;
    return JSON.stringify({
      coordinateSystem: 'Three.js world; y up; player begins at z=8 looking toward negative z',
      mode: this.mode,
      objective: this.mission.objective,
      mission: {
        phase: this.mission.phase,
        remainingSeconds: Number(this.mission.remainingSeconds.toFixed(2)),
        poweredCount: this.mission.poweredCount,
        securityDisabled: this.mission.securityDisabled,
        relays: this.mission.relays,
        nearbyRelay: this.nearestRelay()?.id ?? null,
        extraction: { x: this.station.extraction.x, z: this.station.extraction.z },
      },
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
      door: { unlocked: this.station.doorUnlocked, passable: this.station.doorPassable },
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
    else await document.documentElement.requestFullscreen();
  }
}
