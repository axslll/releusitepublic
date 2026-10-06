/**
 * Tracks how much CPU a piece of work has used over a sliding window, as a percentage of the whole
 * machine (what Task Manager / top show as total CPU). Callers `record()` the CPU time they used and ask
 * whether the limit has been `exceeded()`.
 */
export class CpuGuard {
  /**
   * @param {object} o
   * @param {number} o.limitPercent  e.g. 25
   * @param {number} o.windowMs      how far back to look, e.g. 30_000
   * @param {number} o.cores         logical CPUs of the machine
   * @param {() => number} [o.now]   clock (injectable for tests)
   */
  constructor({ limitPercent, windowMs, cores, now = Date.now }) {
    this.limitPercent = limitPercent;
    this.windowMs = windowMs;
    this.cores = Math.max(1, cores);
    this.now = now;
    this.samples = []; // { t, us } - CPU microseconds used, and when
  }

  /** Adds CPU time (microseconds, user + system) that was just used. */
  record(cpuMicros) {
    this.samples.push({ t: this.now(), us: Math.max(0, cpuMicros) });
    this.#prune();
  }

  /** CPU used in the window, as % of the whole machine. */
  percent() {
    this.#prune();
    const used = this.samples.reduce((sum, s) => sum + s.us, 0);
    return (used / (this.windowMs * 1000 * this.cores)) * 100;
  }

  exceeded() {
    return this.percent() > this.limitPercent;
  }

  reset() {
    this.samples = [];
  }

  #prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }
}
