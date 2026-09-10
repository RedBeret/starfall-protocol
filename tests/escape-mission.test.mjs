import test from 'node:test';
import assert from 'node:assert/strict';
import { EscapeMission, RELAYS } from '../artifacts/test-build/EscapeMission.js';

function alignAllRelays(mission) {
  for (const relay of RELAYS) {
    for (let turn = 0; turn < relay.targetOrientation; turn += 1) {
      assert.equal(mission.rotateRelay(relay.id), true);
    }
  }
}

function state(mission) {
  return {
    phase: mission.phase,
    remainingSeconds: mission.remainingSeconds,
    securityDisabled: mission.securityDisabled,
    poweredCount: mission.poweredCount,
    doorUnlocked: mission.doorUnlocked,
    objective: mission.objective,
    relays: mission.relays,
  };
}

test('a new mission starts with a full escape window and locked route', () => {
  const mission = new EscapeMission();
  assert.equal(mission.phase, 'active');
  assert.equal(mission.remainingSeconds, 180);
  assert.equal(mission.securityDisabled, false);
  assert.equal(mission.poweredCount, 0);
  assert.equal(mission.doorUnlocked, false);
  assert.equal(mission.objective, 'Disable the security drone');
  assert.deepEqual(mission.relays.map(({ orientation, powered }) => ({ orientation, powered })), [
    { orientation: 0, powered: false },
    { orientation: 0, powered: false },
    { orientation: 0, powered: false },
  ]);
});

test('all three relay definitions retain their fixed station coordinates and targets', () => {
  assert.deepEqual(RELAYS.map(({ id, x, z, targetOrientation }) => ({ id, x, z, targetOrientation })), [
    { id: 'auxiliary', x: -3, z: 5, targetOrientation: 1 },
    { id: 'coolant', x: 3, z: -2, targetOrientation: 3 },
    { id: 'navigation', x: -3, z: -6.5, targetOrientation: 2 },
  ]);
  assert.throws(() => { RELAYS[0].targetOrientation = 0; }, TypeError);
  assert.throws(() => { RELAYS.pop(); }, TypeError);
});

test('security alone cannot complete the mission; extraction requires power and a separate action', () => {
  const mission = new EscapeMission();
  assert.equal(mission.extract(), false);
  assert.equal(mission.disableSecurity(), true);
  assert.equal(mission.disableSecurity(), false);
  assert.equal(mission.objective, 'Align the power relays (0/3)');
  assert.equal(mission.extract(), false);
  alignAllRelays(mission);
  assert.equal(mission.poweredCount, 3);
  assert.equal(mission.doorUnlocked, true);
  assert.equal(mission.phase, 'active');
  assert.equal(mission.objective, 'Reach the escape corridor');
  assert.equal(mission.extract(), true);
  assert.equal(mission.phase, 'escaped');
  assert.equal(mission.objective, 'Evacuation complete');
});

test('relays can be solved before security, but the route stays locked until both are ready', () => {
  const mission = new EscapeMission();
  alignAllRelays(mission);
  assert.equal(mission.poweredCount, 3);
  assert.equal(mission.doorUnlocked, false);
  assert.equal(mission.extract(), false);
  assert.equal(mission.disableSecurity(), true);
  assert.equal(mission.doorUnlocked, true);
  assert.equal(mission.extract(), true);
});

test('rotating a relay cycles through four positions and can disconnect an aligned route', () => {
  const mission = new EscapeMission();
  mission.disableSecurity();
  alignAllRelays(mission);
  assert.equal(mission.rotateRelay('auxiliary'), true);
  assert.equal(mission.relays[0].orientation, 2);
  assert.equal(mission.poweredCount, 2);
  assert.equal(mission.doorUnlocked, false);
  assert.equal(mission.extract(), false);
  assert.equal(mission.objective, 'Align the power relays (2/3)');
  for (const orientation of [3, 0, 1]) {
    mission.rotateRelay('auxiliary');
    assert.equal(mission.relays[0].orientation, orientation);
  }
  assert.equal(mission.doorUnlocked, true);
});

test('unknown relay identifiers are rejected without changing the mission', () => {
  const mission = new EscapeMission();
  const before = state(mission);
  for (const id of ['', 'AUXILIARY', 'unknown', '__proto__', 'constructor']) {
    assert.equal(mission.rotateRelay(id), false);
    assert.deepEqual(state(mission), before);
  }
});

test('negative and non-finite time deltas cannot rewind or corrupt the timer', () => {
  const mission = new EscapeMission();
  mission.tick(12.5);
  const before = state(mission);
  for (const delta of [-1, -Number.MIN_VALUE, Number.NaN, Infinity, -Infinity]) {
    assert.equal(mission.tick(delta), false);
    assert.deepEqual(state(mission), before);
  }
  assert.equal(mission.tick(0), true);
  assert.deepEqual(state(mission), before);
  assert.equal(mission.tick(0.25), true);
  assert.equal(mission.remainingSeconds, 167.25);
});

test('the deadline expires at exactly 180 seconds, including accumulated fixed steps', () => {
  const exact = new EscapeMission();
  exact.tick(179);
  assert.equal(exact.phase, 'active');
  exact.tick(1);
  assert.equal(exact.phase, 'failed');
  assert.equal(exact.remainingSeconds, 0);

  const fixedStep = new EscapeMission();
  for (let frame = 0; frame < 180 * 60 - 1; frame += 1) fixedStep.tick(1 / 60);
  assert.equal(fixedStep.phase, 'active');
  assert.ok(fixedStep.remainingSeconds > 0);
  fixedStep.tick(1 / 60);
  assert.equal(fixedStep.phase, 'failed');
  assert.equal(fixedStep.remainingSeconds, 0);
  assert.equal(fixedStep.objective, 'Escape window lost');
});

test('overshooting the deadline clamps time and a ready exit cannot rescue an expired mission', () => {
  const mission = new EscapeMission();
  mission.disableSecurity();
  alignAllRelays(mission);
  assert.equal(mission.tick(999), true);
  assert.equal(mission.remainingSeconds, 0);
  assert.equal(mission.phase, 'failed');
  assert.equal(mission.extract(), false);
});

test('ended missions reject further actions and keep their completed state', () => {
  for (const ending of ['escaped', 'failed']) {
    const mission = new EscapeMission();
    mission.tick(30);
    if (ending === 'escaped') {
      mission.disableSecurity();
      alignAllRelays(mission);
      mission.extract();
    } else {
      assert.equal(mission.fail(), true);
    }
    const before = state(mission);
    assert.equal(mission.tick(25), false);
    assert.equal(mission.rotateRelay('coolant'), false);
    assert.equal(mission.disableSecurity(), false);
    assert.equal(mission.extract(), false);
    assert.equal(mission.fail(), false);
    assert.deepEqual(state(mission), before);
  }
});

test('reset restores the entire mission after success, timeout, or an active run', () => {
  for (const ending of ['escaped', 'failed', 'active']) {
    const mission = new EscapeMission();
    mission.disableSecurity();
    alignAllRelays(mission);
    mission.tick(42);
    if (ending === 'escaped') mission.extract();
    if (ending === 'failed') mission.tick(180);
    assert.equal(mission.reset(), true);
    assert.deepEqual(state(mission), state(new EscapeMission()));
    assert.equal(mission.rotateRelay('auxiliary'), true);
    assert.equal(mission.poweredCount, 1);
    assert.equal(mission.tick(1), true);
  }
});

test('mutating a relay snapshot cannot alter the mission or later snapshots', () => {
  const mission = new EscapeMission();
  const snapshot = mission.relays;
  snapshot[0].orientation = 1;
  snapshot[0].powered = true;
  snapshot[0].targetOrientation = 0;
  snapshot[0].x = 999;
  snapshot.pop();
  assert.equal(mission.relays.length, 3);
  assert.equal(mission.relays[0].orientation, 0);
  assert.equal(mission.relays[0].targetOrientation, 1);
  assert.equal(mission.relays[0].x, -3);
  assert.equal(mission.poweredCount, 0);
  assert.equal(mission.doorUnlocked, false);
  const previous = mission.relays;
  mission.rotateRelay('auxiliary');
  assert.equal(previous[0].orientation, 0);
  assert.equal(previous[0].powered, false);
  assert.equal(mission.relays[0].powered, true);
});
