export const RELAYS = Object.freeze([
  Object.freeze({ id: 'auxiliary', name: 'Auxiliary power', x: -3, z: 5, targetOrientation: 1 }),
  Object.freeze({ id: 'coolant', name: 'Coolant return', x: 3, z: -2, targetOrientation: 3 }),
  Object.freeze({ id: 'navigation', name: 'Navigation uplink', x: -3, z: -6.5, targetOrientation: 2 }),
] as const);

export type RelayId = (typeof RELAYS)[number]['id'];
export type RelaySnapshot = (typeof RELAYS)[number] & {
  readonly orientation: number;
  readonly powered: boolean;
};
export type MissionPhase = 'active' | 'escaped' | 'failed';

const ESCAPE_WINDOW_SECONDS = 180;
const TIMEOUT_TOLERANCE = 1e-9;

export class EscapeMission {
  private currentPhase: MissionPhase = 'active';
  private secondsLeft = ESCAPE_WINDOW_SECONDS;
  private securityOffline = false;
  private orientations = RELAYS.map(() => 0);

  get phase(): MissionPhase {
    return this.currentPhase;
  }

  get remainingSeconds(): number {
    return this.secondsLeft;
  }

  get securityDisabled(): boolean {
    return this.securityOffline;
  }

  get poweredCount(): number {
    return RELAYS.reduce((count, relay, index) => count + Number(this.orientations[index] === relay.targetOrientation), 0);
  }

  get doorUnlocked(): boolean {
    return this.securityOffline && this.poweredCount === RELAYS.length;
  }

  get relays(): readonly RelaySnapshot[] {
    return RELAYS.map((relay, index) => ({
      ...relay,
      orientation: this.orientations[index],
      powered: this.orientations[index] === relay.targetOrientation,
    }));
  }

  get objective(): string {
    if (this.currentPhase === 'escaped') return 'Evacuation complete';
    if (this.currentPhase === 'failed') return 'Escape window lost';
    if (!this.securityOffline) return 'Disable the security drone';
    if (this.poweredCount < RELAYS.length) return `Align the power relays (${this.poweredCount}/${RELAYS.length})`;
    return 'Reach the escape corridor';
  }

  reset(): boolean {
    this.currentPhase = 'active';
    this.secondsLeft = ESCAPE_WINDOW_SECONDS;
    this.securityOffline = false;
    this.orientations = RELAYS.map(() => 0);
    return true;
  }

  tick(deltaSeconds: number): boolean {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || this.currentPhase !== 'active') return false;
    this.secondsLeft = Math.max(0, this.secondsLeft - deltaSeconds);
    if (this.secondsLeft <= TIMEOUT_TOLERANCE) {
      this.secondsLeft = 0;
      this.currentPhase = 'failed';
    }
    return true;
  }

  rotateRelay(id: string): boolean {
    if (this.currentPhase !== 'active') return false;
    const index = RELAYS.findIndex((relay) => relay.id === id);
    if (index === -1) return false;
    this.orientations[index] = (this.orientations[index] + 1) % 4;
    return true;
  }

  disableSecurity(): boolean {
    if (this.currentPhase !== 'active' || this.securityOffline) return false;
    this.securityOffline = true;
    return true;
  }

  extract(): boolean {
    if (this.currentPhase !== 'active' || !this.doorUnlocked) return false;
    this.currentPhase = 'escaped';
    return true;
  }

  fail(): boolean {
    if (this.currentPhase !== 'active') return false;
    this.currentPhase = 'failed';
    return true;
  }
}
