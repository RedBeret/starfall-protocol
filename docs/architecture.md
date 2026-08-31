# Technical direction

## Product boundary

Starfall Protocol is a single-player 3D survival roguelite that runs entirely in the browser. GitHub Pages serves the static production build. Saved settings and run history will remain local to the player's browser; shared accounts, real-time multiplayer, and trusted global leaderboards are outside the static-hosting boundary.

## Stack

- Three.js 0.185.1 for WebGL rendering, scene management, lighting, raycasting, and later glTF content.
- TypeScript 7.0.2 for strict game-state and system boundaries.
- Vite 8.2.2 for local development and a static `dist` build.
- Browser-native Pointer Lock, Fullscreen, Web Audio, Gamepad, and local-storage APIs as features reach their milestones.
- GitHub Actions and GitHub Pages for repeatable production deployment.

The first milestone uses simple room-bound collision and Three.js raycasting instead of a physics dependency. A physics engine will be added only if moving rigid bodies or complex character collision make it necessary.

## Runtime layout

1. `Game` owns lifecycle, deterministic stepping, state, and the renderer.
2. `StationScene` builds the first room and exposes collision bounds and interactive targets.
3. Input maps keyboard, mouse, and automation-friendly aliases into actions.
4. Combat uses a camera raycast and explicit target health in the prototype.
5. The HTML HUD mirrors player health, weapon charge, objective state, and pause state.
6. `render_game_to_text` exposes the visible gameplay state for repeatable browser testing.

## Milestone gates

### M1 — technical room

A player can enter one detailed station room, move without leaving its bounds, aim, damage one security drone, complete the objective, pause, restart, and toggle fullscreen. Production build and browser tests must pass with no new console errors.

### M2 — vertical slice

A ten-minute mission spans connected rooms with one power-routing objective, a locked path, combat or stealth, one upgrade, and a complete escape/failure loop.

### M3 — procedural run

Seeded generation produces reachable rooms, objectives, enemies, and extraction. Ten fixed seeds must be completable without blocked progression.

### M4 — content and presentation

Weapons, tools, enemy families, hazards, audio, settings, accessibility, controller support, save data, progression, and the final encounter reach release quality.

## Research sources

- [Three.js installation guide](https://threejs.org/manual/en/installation.html)
- [Three.js PointerLockControls](https://threejs.org/docs/pages/PointerLockControls.html)
- [Three.js Raycaster](https://threejs.org/docs/pages/Raycaster.html)
- [Vite static deployment guide](https://vite.dev/guide/static-deploy.html)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [MDN Pointer Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API)
