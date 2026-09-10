import type { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// Some platforms emit cursor-recentering deltas immediately after capture.
// Give capture a brief settling window so opening the menu never changes aim.
export function guardPointerCapture(controls: PointerLockControls, document: Document): void {
  let settlesAt = 0;
  controls.addEventListener('lock', () => { settlesAt = performance.now() + 200; });
  document.addEventListener('mousemove', (event) => {
    if (controls.isLocked && performance.now() < settlesAt) event.stopImmediatePropagation();
  }, { capture: true });
}
