/**
 * Transaction lifecycle rail used in landing illustrations. Mirrors the five
 * independent facts the workspace records; finality is always shown as
 * unknown because no verified finality adapter exists yet.
 */
export type StepState = 'done' | 'active' | 'unknown' | 'idle';

export const LIFECYCLE: Array<{ k: string; done: string; active: string; idle: string }> = [
  { k: 'Submitted', done: 'Hash returned by wallet', active: 'Awaiting wallet approval', idle: 'Not submitted' },
  { k: 'Included', done: 'Receipt observed', active: 'Waiting for receipt', idle: 'Not observed' },
  { k: 'Executed', done: 'Receipt status 0x1', active: 'Waiting for status', idle: 'Unknown' },
  { k: 'Finality', done: 'Not confirmed', active: 'Not confirmed', idle: 'Not confirmed' },
  { k: 'Indexed', done: 'Event stored and queryable', active: 'Waiting for checkpoint', idle: 'Not indexed' },
];

/** States after `reached` of the four observable steps completed; finality stays unknown. */
export function lifecycleStates(reached: number): StepState[] {
  const observable = LIFECYCLE.filter((s) => s.k !== 'Finality');
  return LIFECYCLE.map((s) => {
    if (s.k === 'Finality') return 'unknown';
    const pos = observable.indexOf(s);
    return pos < reached ? 'done' : pos === reached ? 'active' : 'idle';
  });
}

export function Lifecycle({ states, compact }: { states: StepState[]; compact?: boolean }) {
  return (
    <ol className={`ld-life ${compact ? 'compact' : ''}`}>
      {LIFECYCLE.map((s, i) => {
        const st = states[i];
        const text = st === 'done' ? s.done : st === 'active' ? s.active : st === 'unknown' ? 'Not confirmed' : s.idle;
        return (
          <li key={s.k} className={`ld-life-step is-${st}`}>
            <span className="ld-life-mark" aria-hidden="true" />
            <span className="ld-life-k mono">{s.k}</span>
            <span className="ld-life-v">{text}</span>
          </li>
        );
      })}
    </ol>
  );
}
