import type { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// The first delta after capture may describe cursor recentering, not mouse input.
// Discard that sample even when a busy browser delivers it late.
export function guardPointerCapture(controls: PointerLockControls, document: Document): void {
  let discardFirstDelta = false;
  controls.addEventListener('lock', () => { discardFirstDelta = true; });
  document.addEventListener('mousemove', (event) => {
    if (controls.isLocked && discardFirstDelta) {
      discardFirstDelta = false;
      event.stopImmediatePropagation();
    }
  }, { capture: true });
}
