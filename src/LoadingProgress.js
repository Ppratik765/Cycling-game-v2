/* ============================================================
 *  LoadingProgress.js
 *  Real weighted-step progress tracker for boot sequence.
 *  Drives the overlay progress bar and status text.
 * ============================================================ */

export class LoadingProgress {
  constructor() {
    this._fillEl   = document.getElementById('loading-progress-fill');
    this._statusEl = document.getElementById('loading-status');
    this._errorEl  = document.getElementById('loading-error');
    this._errorDetailEl = document.getElementById('loading-error-detail');
    this._overlayEl = document.getElementById('loading-overlay');
    this._progressWrapper = document.getElementById('loading-progress-wrapper');

    this._totalWeight = 0;
    this._completedWeight = 0;
    this._steps = [];
    this._failed = false;
  }

  /**
   * Register a named loading step with a weight.
   * Returns a resolve/reject pair to call when done.
   */
  addStep(label, weight = 1) {
    this._totalWeight += weight;

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const step = { label, weight, promise, resolve, reject, done: false };
    this._steps.push(step);

    return step;
  }

  /**
   * Complete a step — updates progress bar and status text.
   */
  completeStep(step) {
    if (step.done) return;
    step.done = true;
    this._completedWeight += step.weight;
    step.resolve();
    this._updateUI();
  }

  /**
   * Mark a step as started — shows its label.
   */
  startStep(step) {
    if (this._failed) return;
    if (this._statusEl) {
      this._statusEl.textContent = step.label;
    }
  }

  /**
   * Fail a step — shows error state.
   */
  failStep(step, error) {
    this._failed = true;
    step.done = true;
    step.reject(error);

    if (this._progressWrapper) {
      this._progressWrapper.style.display = 'none';
    }
    if (this._errorEl) {
      this._errorEl.classList.remove('loading-error-hidden');
    }
    if (this._errorDetailEl) {
      this._errorDetailEl.textContent = error?.message || String(error);
    }
  }

  /**
   * Wait for all registered steps to complete.
   */
  async waitForAll() {
    await Promise.all(this._steps.map(s => s.promise));
  }

  /**
   * Update the progress bar fill width.
   */
  _updateUI() {
    if (this._failed) return;
    const pct = this._totalWeight > 0
      ? Math.round((this._completedWeight / this._totalWeight) * 100)
      : 0;
    if (this._fillEl) {
      this._fillEl.style.width = `${pct}%`;
    }
  }

  /**
   * Show "Ready!" and allow the overlay to be hidden.
   */
  showReady() {
    if (this._statusEl) {
      this._statusEl.textContent = 'Ready!';
    }
    if (this._fillEl) {
      this._fillEl.style.width = '100%';
    }
  }

  /**
   * Crossfade-hide the overlay.
   */
  hideOverlay() {
    if (this._overlayEl) {
      this._overlayEl.classList.add('hidden');
    }
  }

  /**
   * Yield to the browser so it can paint the UI update.
   */
  static yieldToUI() {
    return new Promise(resolve => requestAnimationFrame(() => {
      // Double-rAF ensures the paint has been flushed
      requestAnimationFrame(resolve);
    }));
  }
}
