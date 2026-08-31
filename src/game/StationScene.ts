import * as THREE from 'three';

type CollisionBox = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

const ROOM_LIMITS = {
  minX: -11.1,
  maxX: 11.1,
  minZ: -10.1,
  maxZ: 10.1,
};

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export class StationScene {
  readonly scene = new THREE.Scene();
  readonly drone = new THREE.Group();
  readonly droneTargets: THREE.Object3D[] = [];
  readonly spawn = new THREE.Vector3(0, 1.7, 8.2);

  private readonly obstacles: CollisionBox[] = [];
  private readonly alarmLights: THREE.PointLight[] = [];
  private readonly sparks: THREE.Points;
  private readonly droneCoreMaterial: THREE.MeshStandardMaterial;
  private readonly droneEyeMaterial: THREE.MeshStandardMaterial;
  private readonly doorMaterial: THREE.MeshStandardMaterial;
  private readonly doorStatusMaterial: THREE.MeshStandardMaterial;
  private hitFlash = 0;
  private doorOpenAmount = 0;
  private droneHealthValue = 3;

  constructor() {
    this.scene.background = new THREE.Color(0x04070d);
    this.scene.fog = new THREE.FogExp2(0x07111b, 0.026);

    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x18242d, roughness: 0.72, metalness: 0.72 });
    const panelMetal = new THREE.MeshStandardMaterial({ color: 0x263b46, roughness: 0.55, metalness: 0.78 });
    const floorMetal = new THREE.MeshStandardMaterial({ color: 0x101b23, roughness: 0.82, metalness: 0.56 });
    const cyanGlow = new THREE.MeshStandardMaterial({
      color: 0x4fd8df,
      emissive: 0x25b8c2,
      emissiveIntensity: 4.5,
      roughness: 0.3,
    });
    const redGlow = new THREE.MeshStandardMaterial({
      color: 0xff384f,
      emissive: 0xe31534,
      emissiveIntensity: 4.2,
      roughness: 0.28,
    });

    this.addRoomShell(darkMetal, panelMetal, floorMetal, cyanGlow);
    this.addStructuralDetails(panelMetal, cyanGlow, redGlow);
    this.addObstacles(panelMetal);

    this.doorMaterial = new THREE.MeshStandardMaterial({
      color: 0x111b22,
      roughness: 0.5,
      metalness: 0.88,
      emissive: 0x16040a,
      emissiveIntensity: 0.8,
    });
    this.doorStatusMaterial = redGlow.clone();
    this.addObjectiveDoor();

    this.droneCoreMaterial = new THREE.MeshStandardMaterial({
      color: 0x243842,
      roughness: 0.24,
      metalness: 0.92,
      emissive: 0x071116,
      emissiveIntensity: 1,
    });
    this.droneEyeMaterial = redGlow.clone();
    this.addDrone();

    this.sparks = this.addSparks();
    this.addLighting();
  }

  get droneHealth(): number {
    return this.droneHealthValue;
  }

  get droneAlive(): boolean {
    return this.droneHealthValue > 0;
  }

  get doorUnlocked(): boolean {
    return !this.droneAlive;
  }

  reset(): void {
    this.droneHealthValue = 3;
    this.hitFlash = 0;
    this.doorOpenAmount = 0;
    this.drone.visible = true;
    this.drone.position.set(0, 1.95, -5.8);
    this.drone.rotation.set(0, 0, 0);
    this.droneCoreMaterial.color.setHex(0x243842);
    this.droneCoreMaterial.emissive.setHex(0x071116);
    this.droneEyeMaterial.color.setHex(0xff384f);
    this.droneEyeMaterial.emissive.setHex(0xe31534);
    this.doorStatusMaterial.color.setHex(0xff384f);
    this.doorStatusMaterial.emissive.setHex(0xe31534);
  }

  damageDrone(): number {
    if (!this.droneAlive) return 0;
    this.droneHealthValue -= 1;
    this.hitFlash = 0.18;
    if (!this.droneAlive) {
      this.droneCoreMaterial.color.setHex(0x0b1114);
      this.droneCoreMaterial.emissive.setHex(0x000000);
      this.droneEyeMaterial.color.setHex(0x26313a);
      this.droneEyeMaterial.emissive.setHex(0x000000);
      this.doorStatusMaterial.color.setHex(0x65ffbc);
      this.doorStatusMaterial.emissive.setHex(0x26c982);
    }
    return this.droneHealthValue;
  }

  canOccupy(x: number, z: number, radius: number): boolean {
    if (
      x - radius < ROOM_LIMITS.minX ||
      x + radius > ROOM_LIMITS.maxX ||
      z - radius < ROOM_LIMITS.minZ ||
      z + radius > ROOM_LIMITS.maxZ
    ) {
      return false;
    }

    return !this.obstacles.some(
      (box) =>
        x + radius > box.minX &&
        x - radius < box.maxX &&
        z + radius > box.minZ &&
        z - radius < box.maxZ,
    );
  }

  update(elapsed: number, delta: number): void {
    const alarmPulse = 1.7 + Math.sin(elapsed * 3.1) * 0.7;
    this.alarmLights.forEach((light, index) => {
      light.intensity = alarmPulse + Math.sin(elapsed * 5 + index) * 0.2;
    });

    if (this.droneAlive) {
      this.drone.position.y = 1.95 + Math.sin(elapsed * 1.8) * 0.14;
      this.drone.rotation.y += delta * 0.72;
      this.drone.rotation.z = Math.sin(elapsed * 1.25) * 0.035;
    } else {
      this.drone.position.y = THREE.MathUtils.damp(this.drone.position.y, 0.62, 3.4, delta);
      this.drone.rotation.z = THREE.MathUtils.damp(this.drone.rotation.z, 0.88, 3, delta);
      this.doorOpenAmount = Math.min(1, this.doorOpenAmount + delta * 0.7);
      this.doorMaterial.emissive.setRGB(0.02, 0.2 * this.doorOpenAmount, 0.13 * this.doorOpenAmount);
    }

    if (this.hitFlash > 0) {
      this.hitFlash -= delta;
      this.droneCoreMaterial.emissive.setHex(0x86fbff);
      this.droneCoreMaterial.emissiveIntensity = 7;
    } else if (this.droneAlive) {
      this.droneCoreMaterial.emissive.setHex(0x071116);
      this.droneCoreMaterial.emissiveIntensity = 1;
    }

    this.sparks.rotation.y = elapsed * 0.025;
  }

  private addRoomShell(
    darkMetal: THREE.MeshStandardMaterial,
    panelMetal: THREE.MeshStandardMaterial,
    floorMetal: THREE.MeshStandardMaterial,
    cyanGlow: THREE.MeshStandardMaterial,
  ): void {
    this.addBox('floor', [24, 0.5, 22], [0, -0.25, 0], floorMetal, true);
    this.addBox('ceiling', [24, 0.45, 22], [0, 5.7, 0], darkMetal, false);
    this.addBox('far-wall', [24, 6, 0.5], [0, 2.75, -11], darkMetal, true);
    this.addBox('rear-wall', [24, 6, 0.5], [0, 2.75, 11], darkMetal, true);
    this.addBox('left-wall', [0.5, 6, 22], [-12, 2.75, 0], darkMetal, true);
    this.addBox('right-wall', [0.5, 6, 22], [12, 2.75, 0], darkMetal, true);

    const grid = new THREE.GridHelper(22, 22, 0x2a5965, 0x18323b);
    grid.position.y = 0.012;
    grid.material.opacity = 0.44;
    grid.material.transparent = true;
    this.scene.add(grid);

    for (const x of [-8, -4, 0, 4, 8]) {
      const strip = this.addBox('floor-strip', [0.04, 0.02, 20], [x, 0.025, 0], cyanGlow, false);
      strip.material = cyanGlow.clone();
      (strip.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.55;
    }

    for (const x of [-10.9, 10.9]) {
      const windowMaterial = new THREE.MeshStandardMaterial({
        color: 0x071822,
        emissive: 0x0b3142,
        emissiveIntensity: 1.2,
        roughness: 0.15,
        metalness: 0.2,
      });
      this.addBox('observation-window', [0.08, 2.4, 6.6], [x, 2.8, -1.2], windowMaterial, false);
      for (let z = -3.8; z <= 1.4; z += 1.3) {
        this.addBox('window-rib', [0.16, 2.75, 0.09], [x * 0.999, 2.8, z], panelMetal, false);
      }
    }
  }

  private addStructuralDetails(
    panelMetal: THREE.MeshStandardMaterial,
    cyanGlow: THREE.MeshStandardMaterial,
    redGlow: THREE.MeshStandardMaterial,
  ): void {
    for (const z of [-8.5, -4.5, -0.5, 3.5, 7.5]) {
      for (const x of [-11.55, 11.55]) {
        this.addBox('wall-rib', [0.5, 5.4, 0.38], [x, 2.65, z], panelMetal, true);
      }
      this.addBox('ceiling-beam', [23.2, 0.38, 0.42], [0, 5.34, z], panelMetal, false);
    }

    for (const x of [-7.8, -2.6, 2.6, 7.8]) {
      const light = this.addBox('ceiling-light', [3.2, 0.06, 0.36], [x, 5.08, -0.5], cyanGlow, false);
      light.rotation.y = Math.PI / 2;
    }

    for (const x of [-8.5, 8.5]) {
      for (const z of [-7.5, 6.7]) {
        const alarm = this.addBox('alarm-panel', [0.9, 0.08, 0.22], [x, 5.06, z], redGlow, false);
        alarm.rotation.y = Math.PI / 2;
      }
    }

    const reactorRingMaterial = cyanGlow.clone();
    reactorRingMaterial.emissiveIntensity = 3;
    for (const radius of [1.55, 1.9]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 8, 56), reactorRingMaterial);
      ring.position.set(0, 2.65, -10.65);
      ring.castShadow = true;
      this.scene.add(ring);
    }
  }

  private addObstacles(panelMetal: THREE.MeshStandardMaterial): void {
    const crateMaterial = panelMetal.clone();
    crateMaterial.color.setHex(0x334851);
    const hazardMaterial = new THREE.MeshStandardMaterial({
      color: 0xd39b36,
      emissive: 0x402700,
      emissiveIntensity: 0.5,
      roughness: 0.65,
      metalness: 0.55,
    });

    const crateData = [
      { x: -5.2, z: 0.6, w: 2.4, d: 2 },
      { x: 5.1, z: 2.6, w: 2.1, d: 2.2 },
      { x: -7.8, z: -5.7, w: 1.8, d: 1.8 },
    ];

    for (const crate of crateData) {
      this.addBox('cargo-crate', [crate.w, 1.45, crate.d], [crate.x, 0.73, crate.z], crateMaterial, true);
      this.addBox('hazard-band', [crate.w + 0.02, 0.18, crate.d + 0.02], [crate.x, 1.02, crate.z], hazardMaterial, false);
      this.obstacles.push({
        minX: crate.x - crate.w / 2,
        maxX: crate.x + crate.w / 2,
        minZ: crate.z - crate.d / 2,
        maxZ: crate.z + crate.d / 2,
      });
    }
  }

  private addObjectiveDoor(): void {
    this.addBox('door-frame-top', [5.2, 0.38, 0.6], [0, 4.95, -10.52], this.doorMaterial, true);
    this.addBox('door-frame-left', [0.38, 4.5, 0.6], [-2.42, 2.5, -10.52], this.doorMaterial, true);
    this.addBox('door-frame-right', [0.38, 4.5, 0.6], [2.42, 2.5, -10.52], this.doorMaterial, true);
    this.addBox('sealed-bulkhead', [4.3, 4.1, 0.36], [0, 2.35, -10.62], this.doorMaterial, true);
    this.addBox('door-status', [1.2, 0.12, 0.12], [0, 4.55, -10.36], this.doorStatusMaterial, false);
  }

  private addDrone(): void {
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x42545d,
      roughness: 0.28,
      metalness: 0.92,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x0d1318, roughness: 0.5, metalness: 0.8 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.63, 24, 16), this.droneCoreMaterial);
    body.scale.set(1.15, 0.72, 0.8);
    body.castShadow = true;
    this.drone.add(body);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.79, 0.07, 8, 32), shellMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = true;
    this.drone.add(ring);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), this.droneEyeMaterial);
    eye.position.set(0, 0.02, 0.59);
    this.drone.add(eye);

    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.11, 0.15), shellMaterial);
      arm.position.x = side * 0.86;
      arm.rotation.z = side * -0.18;
      arm.castShadow = true;
      this.drone.add(arm);

      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.12, 16), darkMaterial);
      rotor.rotation.z = Math.PI / 2;
      rotor.position.x = side * 1.23;
      this.drone.add(rotor);
    }

    const collider = new THREE.Mesh(
      new THREE.SphereGeometry(0.92, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    collider.name = 'drone-hitbox';
    this.drone.add(collider);
    this.droneTargets.push(collider, body, eye);

    const droneLight = new THREE.PointLight(0xff2945, 5, 5, 2);
    droneLight.position.set(0, 0.05, 0.45);
    this.drone.add(droneLight);

    this.drone.position.set(0, 1.95, -5.8);
    this.scene.add(this.drone);
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0x7bcbd6, 0x081018, 1.05));

    const keyLight = new THREE.DirectionalLight(0xc7f9ff, 2.2);
    keyLight.position.set(3, 7, 6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 35;
    this.scene.add(keyLight);

    for (const x of [-8.5, 8.5]) {
      for (const z of [-7.5, 6.7]) {
        const light = new THREE.PointLight(0xff2446, 2.2, 8, 2);
        light.position.set(x, 4.75, z);
        this.alarmLights.push(light);
        this.scene.add(light);
      }
    }

    const doorLight = new THREE.PointLight(0x39c9d7, 3, 9, 2);
    doorLight.position.set(0, 3.5, -8.8);
    this.scene.add(doorLight);
  }

  private addSparks(): THREE.Points {
    const random = seededRandom(1701);
    const count = 90;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (random() - 0.5) * 21;
      positions[index * 3 + 1] = 3.4 + random() * 1.7;
      positions[index * 3 + 2] = (random() - 0.5) * 18;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x63e8ff,
      size: 0.035,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    return points;
  }

  private addBox(
    name: string,
    size: [number, number, number],
    position: [number, number, number],
    material: THREE.Material,
    castsShadow: boolean,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = castsShadow;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }
}
