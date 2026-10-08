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

  private inFlight = false;

  /** True when an attempt is allowed at `now` and none is in flight. */
  ready(now = Date.now()): boolean {
    return !this.inFlight && now >= this.nextAt;
  }

  /**
   * Run one attempt if allowed. Overlapping calls (e.g. a timer firing while a
   * slow attempt is still running) are skipped, so failures cannot stack up.
   * `ok` decides whether the result counts as success.
   */
  async attempt<T>(fn: () => Promise<T>, ok: (r: T) => boolean, now: () => number = Date.now): Promise<{ ran: false } | { ran: true; result: T; nextInMs: number }> {
    if (!this.ready(now())) return { ran: false };
    this.inFlight = true;
    try {
      const result = await fn();
      const nextInMs = ok(result) ? this.success(now()) : this.failure(now());
      return { ran: true, result, nextInMs };
    } catch (e) {
      this.failure(now());
      throw e;
    } finally {
      this.inFlight = false;
    }
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
