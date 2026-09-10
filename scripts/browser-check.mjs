import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// Exercise real input against the production build; only time is accelerated.
const suppliedUrl = process.argv[2];
const url = suppliedUrl ?? 'http://127.0.0.1:4187/starfall-protocol/';
const output = 'artifacts/browser-check';
await mkdir(output, { recursive: true });
let server;
let browser;
let page;
const errors = [];
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };

try {
  if (!suppliedUrl) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4187', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    let serverFailure;
    let serverOutput = '';
    server.on('error', (error) => { serverFailure = error; });
    server.on('exit', (code) => { serverFailure = new Error(`Preview server exited: ${code}`); });
    server.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
    server.stderr.on('data', (chunk) => { serverOutput += String(chunk); });
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (serverFailure) throw new Error(`${serverFailure}\n${serverOutput}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500) });
        ready = response.ok && (await response.text()).includes('Starfall Protocol');
      } catch { /* The local listener may not yet be ready. */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Preview server did not start\n${serverOutput}`);
  }
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
  const step = (ms) => page.evaluate((duration) => window.advanceTime(duration), ms);
  const shot = async () => { await page.keyboard.press('Space'); await step(250); };
  const restart = async () => {
    await page.keyboard.press('r');
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).pointerLocked);
  };
  const move = async (key, seconds) => {
    await page.keyboard.down(key);
    await step(seconds * 1000);
    await page.keyboard.up(key);
  };
  const go = async (x, z) => {
    const before = await state();
    const dx = x - before.player.x;
    if (Math.abs(dx) > 0.06) await move(dx < 0 ? 'a' : 'd', Math.abs(dx) / 3.8);
    const middle = await state();
    const dz = z - middle.player.z;
    if (Math.abs(dz) > 0.06) await move(dz < 0 ? 'w' : 's', Math.abs(dz) / 3.8);
    const after = await state();
    assert.ok(Math.abs(after.player.x - x) < 0.15, `Blocked x route: wanted ${x}, got ${after.player.x}`);
    if (after.mode === 'playing') assert.ok(Math.abs(after.player.z - z) < 0.15, `Blocked z route: wanted ${z}, got ${after.player.z}`);
  };
  const capture = async (name) => {
    await page.screenshot({ path: `${output}/${name}.png` });
    await writeFile(`${output}/${name}.json`, JSON.stringify(await state(), null, 2));
  };

  await step(0);
  await capture('briefing');
  await page.click('#start-button');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).pointerLocked);
  await shot(); await shot(); await shot();
  let current = await state();
  assert.equal(current.weapon.hits, 3);
  assert.equal(current.mode, 'playing');
  assert.equal(current.door.unlocked, false);
  assert.equal(current.mission.securityDisabled, true);
  check('drone death advances the mission without ending it');

  await go(0, -9.8);
  await move('w', 2);
  assert.ok((await state()).player.z > -10.05);
  assert.equal((await state()).mode, 'playing');
  check('sealed bulkhead blocks early extraction');
  await go(0, 6.5);
  await go(-3, 6.5);
  assert.equal((await state()).mission.nearbyRelay, 'auxiliary');
  await page.keyboard.press('e');
  assert.equal((await state()).mission.poweredCount, 1);
  await capture('relay-online');

  await page.keyboard.down('w');
  await page.keyboard.press('p');
  await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).pointerLocked);
  const paused = await state();
  assert.equal(paused.mode, 'paused');
  assert.equal(await page.locator('#relay-prompt').evaluate((element) => element.classList.contains('is-hidden')), true);
  await step(5_000);
  assert.deepEqual(await state(), paused);
  await page.keyboard.up('w');
  await capture('paused');
  await page.click('#start-button');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).pointerLocked);
  await step(500);
  assert.equal((await state()).player.z, paused.player.z);
  check('pause freezes timer and world; resume clears held movement');

  await go(0, 6.5);
  await go(0, -0.4);
  await go(3, -0.4);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('e');
  assert.equal((await state()).mission.poweredCount, 2);
  await go(0, -0.4);
  await go(0, -4.8);
  await go(-3, -4.8);
  await page.keyboard.press('e'); await page.keyboard.press('e');
  current = await state();
  assert.equal(current.mission.poweredCount, 3);
  assert.equal(current.door.unlocked, true);
  assert.equal(current.door.passable, false);
  await step(1_500);
  assert.equal((await state()).door.passable, true);
  check('physical relays unlock the bulkhead only after all three align');
  await go(0, -4.8);
  await go(0, -11.8);
  await capture('escape-corridor');
  await move('w', 2);
  current = await state();
  assert.equal(current.mode, 'complete');
  assert.equal(current.mission.phase, 'escaped');
  assert.ok(current.mission.remainingSeconds > 0);
  await page.locator('#run-results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#run-results').isVisible(), true);
  await capture('escaped');
  check('player can traverse the unlocked corridor and complete extraction');

  await restart();
  current = await state();
  assert.equal(current.player.health, 100);
  assert.equal(current.drone.health, 3);
  assert.equal(current.mission.poweredCount, 0);
  assert.equal(current.mission.remainingSeconds, 180);
  assert.equal(current.door.passable, false);
  await step(10);
  await restart();
  await step(10);
  assert.equal((await state()).mission.remainingSeconds, 180);
  check('restart resets player, mission, door, and fractional clock');
  await step(31_000);
  assert.equal((await state()).mode, 'failed');
  assert.equal((await state()).player.health, 0);
  await capture('combat-failure');
  check('hostile fire produces a recoverable failure');

  await restart();
  await shot(); await shot(); await shot();
  await step(180_000);
  assert.equal((await state()).mode, 'failed');
  assert.equal((await state()).mission.remainingSeconds, 0);
  assert.match(await page.locator('#overlay-copy').innerText(), /escape window closed/i);
  await capture('deadline-failure');
  check('deadline expires without relying on enemy damage');

  await restart();
  await move('d', 5);
  assert.ok((await state()).player.x <= 10.68);
  await shot();
  assert.equal((await state()).weapon.hits, 0);
  await step(1_200);
  assert.equal((await state()).weapon.charge, 6);
  check('room collision, missed shots, and weapon recharge');
  await restart();
  const beforeSprint = await state();
  await page.keyboard.down('Shift');
  await move('w', 1);
  await page.keyboard.up('Shift');
  assert.ok(beforeSprint.player.z - (await state()).player.z > 6);
  await page.mouse.move(680, 330);
  assert.notEqual((await state()).player.headingDegrees, 0);
  await page.keyboard.press('f');
  await page.waitForFunction(() => document.fullscreenElement?.tagName === 'HTML');
  assert.equal(await page.locator('#hud').isVisible(), true);
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  check('sprint, mouse look, and fullscreen preserve the HUD');

  await page.keyboard.press('p');
  await page.setViewportSize({ width: 960, height: 540 });
  await capture('compact-layout');
  const startBounds = await page.locator('#start-button').boundingBox();
  assert.ok(startBounds && startBounds.y >= 0 && startBounds.y + startBounds.height <= 540);
  check('compact desktop pause screen keeps resume reachable');
  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(`${output}/report.json`, JSON.stringify({ url, checks, errors }, null, 2));
  console.log(`Browser checks passed: ${checks.length}`);
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
