/**
 * Bounded exponential backoff with "equal jitter": after n consecutive
 * failures the next attempt waits between d/2 and d, where
 * d = min(maxMs, baseMs * 2^(n-1)). A success resets to the healthy cadence.
 */
export class Backoff {
  private failures = 0;
  private nextAt = 0;

  constructor(
    private readonly opts: { baseMs: number; maxMs: number; healthyMs: number; random?: () => number },
  ) {}

  /** True when an attempt is allowed at `now`. */
  ready(now = Date.now()): boolean {
    return now >= this.nextAt;
  }

  /** Record a successful attempt; schedules the next one at the healthy cadence. */
  success(now = Date.now()): number {
    this.failures = 0;
    this.nextAt = now + this.opts.healthyMs;
    return this.opts.healthyMs;
  }

  /** Record a failed attempt; returns the delay until the next attempt. */
  failure(now = Date.now()): number {
    this.failures++;
    const exp = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** Math.min(this.failures - 1, 30));
    const delay = Math.round(exp / 2 + (this.opts.random ?? Math.random)() * (exp / 2));
    this.nextAt = now + delay;
    return delay;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
