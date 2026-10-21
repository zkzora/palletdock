'use client';

import { useInView } from '@/components/motion';

/**
 * Three line figures for PalletDock concepts. Geometry is generated from an
 * isometric projection so the shapes stay consistent. Strokes draw once when
 * the section enters the viewport; reduced motion gets the finished figure.
 */

type Pt = [number, number];
type Iso = (x: number, y: number, z: number) => Pt;

const COS = Math.cos(Math.PI / 6);
const r = (n: number) => Math.round(n * 10) / 10;

function projector(cx: number, cy: number, s: number): Iso {
  return (x, y, z) => [r(cx + (x - y) * COS * s), r(cy + ((x + y) / 2 - z) * s)];
}

const path = (pts: Pt[], close = false) => `M${pts.map((p) => p.join(' ')).join(' L')}${close ? ' Z' : ''}`;

/** Outline of a box: the top face plus the two faces toward the viewer. */
function box(iso: Iso, x: number, y: number, w: number, d: number, z: number, h: number) {
  const t = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)];
  const b = [iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)];
  return {
    top: path(t, true),
    sides: `${path([t[1], b[0], b[1], b[2], t[3]])} ${path([t[2], b[1]])}`,
    silhouette: path([t[0], t[1], b[0], b[1], b[2], t[3]], true),
    corner: t[1],
    front: b[1],
    center: iso(x + w / 2, y + d / 2, z + h),
  };
}

/** A vertical plane at x = c (used for checkpoints and API panels). */
function plane(iso: Iso, c: number, y: number, d: number, z: number, h: number) {
  return path([iso(c, y, z), iso(c, y + d, z), iso(c, y + d, z + h), iso(c, y, z + h)], true);
}

const D = (n: number) => ({ '--d': n }) as React.CSSProperties;

function Box({ b, d, dashed, accent, noFill }: { b: ReturnType<typeof box>; d: number; dashed?: boolean; accent?: 'info' | 'success'; noFill?: boolean }) {
  return (
    <g className={dashed ? 'fig-layer' : undefined} style={D(d)}>
      {!noFill && <path d={b.silhouette} className="fig-fill" />}
      <path d={b.top} className={`${dashed ? 'fig-dash' : 'fig-draw'} ${accent ? `fig-${accent}` : ''}`} pathLength={dashed ? undefined : 1} style={D(d)} />
      <path d={b.sides} className={dashed ? 'fig-dash' : 'fig-draw'} pathLength={dashed ? undefined : 1} style={D(d)} />
    </g>
  );
}

function Label({ at, to, text, d, anchor = 'start' }: { at: Pt; to: Pt; text: string; d: number; anchor?: 'start' | 'end' | 'middle' }) {
  return (
    <g className="fig-layer" style={D(d)}>
      <path d={path([at, to])} className="fig-leader" />
      <text x={to[0] + (anchor === 'start' ? 4 : anchor === 'end' ? -4 : 0)} y={to[1] + 3} textAnchor={anchor} className="fig-label">
        {text}
      </text>
    </g>
  );
}

function ProjectIsolation() {
  const iso = projector(110, 112, 1);
  const bound = box(iso, -10, -10, 100, 100, 0, 100);
  const layers = [
    { z: 76, name: 'contracts' },
    { z: 40, name: 'read keys' },
    { z: 4, name: 'indexer sources' },
  ].map((l) => ({ ...l, b: box(iso, 0, 0, 80, 80, l.z, 10) }));
  // Lower layers are only visible along their front band (x or y > 54).
  const key = iso(60, 68, 50);
  const ticks = [12, 28, 44, 60].map((x) => [iso(x, 62, 14), iso(x, 72, 14)] as const);
  const code = [0, 1, 2].map((k) => path([iso(14, 18 + k * 12, 86), iso(14 + 34 - k * 8, 18 + k * 12, 86)]));
  return (
    <svg viewBox="0 0 300 230" className="fig-svg" aria-hidden="true">
      {[...layers].reverse().map((l, i) => (
        <Box key={l.name} b={l.b} d={i + 1} accent={l.name === 'read keys' ? 'info' : undefined} />
      ))}
      {code.map((c, i) => (
        <path key={i} d={c} className="fig-layer fig-detail" style={D(1)} />
      ))}
      <g className="fig-layer" style={D(2)}>
        <circle cx={key[0] - 6} cy={key[1]} r={4} className="fig-info-stroke" />
        <path d={`M${key[0] - 2} ${key[1]} H${key[0] + 9} M${key[0] + 6} ${key[1]} v3 M${key[0] + 9} ${key[1]} v3`} className="fig-info-stroke" />
      </g>
      {ticks.map(([a, b], i) => (
        <path key={i} d={path([a, b])} className={`fig-layer ${i === 3 ? 'fig-success-stroke' : 'fig-detail'}`} style={D(3)} />
      ))}
      <Box b={bound} d={0} dashed noFill />
      {layers.map((l, i) => (
        <Label key={l.name} at={l.b.corner} to={[214, l.b.corner[1]]} text={l.name} d={i + 1} />
      ))}
      <text x={bound.front[0]} y={bound.front[1] + 16} textAnchor="middle" className="fig-layer fig-label dim" style={D(0)}>
        project boundary
      </text>
    </svg>
  );
}

function WalletExecution() {
  const iso = projector(150, 60, 1.2);
  const N = 30;
  const nodes = {
    palletdock: { x: 0, y: 80 },
    wallet: { x: 50, y: 80 },
    network: { x: 50, y: 20 },
    contract: { x: 100, y: 20 },
  };
  const c = (n: { x: number; y: number }, z = 0) => iso(n.x + N / 2, n.y + N / 2, z);
  const handoff = path([c(nodes.palletdock), c(nodes.wallet)]);
  const signed = path([c(nodes.wallet), c(nodes.network), c(nodes.contract)]);
  const pd = box(iso, nodes.palletdock.x, nodes.palletdock.y, N, N, 0, 16);
  const wallet = box(iso, nodes.wallet.x, nodes.wallet.y, N, N, 0, 16);
  const contract = box(iso, nodes.contract.x, nodes.contract.y, N, N, 0, 16);
  const net = [0, 7, 14].map((z) => box(iso, nodes.network.x, nodes.network.y, N, N, z, 3));
  const key = wallet.center;
  const brace = contract.center;
  return (
    <svg viewBox="0 0 300 230" className="fig-svg" aria-hidden="true">
      <path d={handoff} className="fig-layer fig-dash" style={D(0)} />
      <path d={signed} className="fig-draw" pathLength={1} style={D(1)} />
      <path d={signed} className="fig-trace" pathLength={1} />
      {net.map((b, i) => (
        <Box key={i} b={b} d={1 + i} />
      ))}
      <Box b={pd} d={0} dashed />
      <Box b={contract} d={3} />
      <Box b={wallet} d={2} accent="info" />
      <g className="fig-layer" style={D(2)}>
        <circle cx={key[0] - 6} cy={key[1]} r={4} className="fig-info-stroke" />
        <path d={`M${key[0] - 2} ${key[1]} H${key[0] + 9} M${key[0] + 6} ${key[1]} v3 M${key[0] + 9} ${key[1]} v3`} className="fig-info-stroke" />
      </g>
      <text x={brace[0]} y={brace[1] + 3} textAnchor="middle" className="fig-layer fig-glyph" style={D(3)}>
        {'{ }'}
      </text>
      <g className="fig-layer" style={D(1)}>
        <text x={pd.center[0]} y={pd.center[1] - 26} textAnchor="middle" className="fig-label">
          PalletDock
        </text>
        <text x={pd.center[0]} y={pd.center[1] - 15} textAnchor="middle" className="fig-label dim">
          prepares · no key
        </text>
      </g>
      <g className="fig-layer" style={D(2)}>
        <text x={wallet.front[0] - 10} y={wallet.front[1] + 18} textAnchor="middle" className="fig-label fig-info-text">
          your wallet signs
        </text>
      </g>
      <g className="fig-layer" style={D(3)}>
        <text x={net[2].center[0]} y={net[2].center[1] - 26} textAnchor="middle" className="fig-label">
          network
        </text>
        <text x={net[2].center[0]} y={net[2].center[1] - 15} textAnchor="middle" className="fig-label dim">
          broadcast
        </text>
      </g>
      <g className="fig-layer" style={D(4)}>
        <text x={contract.front[0] + 10} y={contract.front[1] + 18} textAnchor="middle" className="fig-label">
          contract executes
        </text>
      </g>
    </svg>
  );
}

function IndexedEvidence() {
  const iso = projector(73, 56, 1.3);
  const tx = box(iso, 0, 4, 22, 22, 0, 22);
  const receipt = box(iso, 42, 2, 26, 26, 0, 6);
  const events = [0, 8, 16].map((z) => box(iso, 90, 2, 24, 26, z, 4));
  const checkpoint = plane(iso, 138, -4, 38, 0, 48);
  const api = plane(iso, 160, -2, 34, 0, 44);
  const apiLines = [36, 29, 22, 15].map((z, i) => path([iso(160, 3, z), iso(160, 3 + 24 - i * 4, z)]));
  const flow = path([iso(11, 15, 0), iso(160, 15, 0)]);
  const ck = iso(138, 15, 48);
  const cpFoot = iso(138, 34, 0);
  const apiFoot = iso(160, 32, 0);
  // Labels sit under each element's front corner so they never cross the shapes.
  const labels: Array<[ReturnType<typeof box>, string, number]> = [
    [tx, 'tx', 1],
    [receipt, 'receipt', 2],
    [events[0], 'event', 3],
  ];
  return (
    <svg viewBox="0 0 300 230" className="fig-svg" aria-hidden="true">
      <path d={flow} className="fig-draw" pathLength={1} style={D(0)} />
      <path d={flow} className="fig-trace" pathLength={1} />
      <Box b={tx} d={1} />
      <Box b={receipt} d={2} />
      {events.map((b, i) => (
        <Box key={i} b={b} d={2 + i} accent={i === 2 ? 'info' : undefined} />
      ))}
      <g className="fig-layer" style={D(3)}>
        <path d={checkpoint} className="fig-fill" />
        <path d={checkpoint} className="fig-dash fig-success" />
        <path d={`M${ck[0] - 4} ${ck[1] - 8} l3 3 l6 -6`} className="fig-success-stroke" />
      </g>
      <g className="fig-layer" style={D(4)}>
        <path d={api} className="fig-fill" />
        <path d={api} className="fig-line" />
        {apiLines.map((l, i) => (
          <path key={i} d={l} className={i === 0 ? 'fig-info-stroke' : 'fig-detail'} />
        ))}
      </g>
      {labels.map(([b, t, d]) => (
        <text key={t} x={b.front[0]} y={b.front[1] + 14} textAnchor="middle" className="fig-layer fig-label" style={D(d)}>
          {t}
        </text>
      ))}
      <text x={cpFoot[0] - 4} y={cpFoot[1] + 14} textAnchor="end" className="fig-layer fig-label fig-success-text" style={D(3)}>
        checkpoint
      </text>
      <text x={apiFoot[0] + 6} y={apiFoot[1] + 14} textAnchor="start" className="fig-layer fig-label" style={D(4)}>
        API
      </text>
    </svg>
  );
}

const FIGS = [
  { id: '01', title: 'Project isolation', body: 'Contracts, read keys, and indexer sources live inside one project. Every workspace route checks ownership, and a read key only opens its own project.', Fig: ProjectIsolation },
  { id: '02', title: 'Wallet-owned execution', body: 'PalletDock prepares and explains each request. Your browser wallet signs and broadcasts it; the server never holds a signing key.', Fig: WalletExecution },
  { id: '03', title: 'Indexed evidence', body: 'A transaction becomes a receipt, its log becomes an indexed event behind a checkpoint, and the API serves it with coverage and freshness.', Fig: IndexedEvidence },
];

export function OutlineFigures() {
  const [ref, drawn] = useInView<HTMLDivElement>({ once: true });
  return (
    <section className="ld-figs" aria-labelledby="figs-title">
      <div className="container">
        <div className="ld-figs-head">
          <div className="eyebrow">Principles</div>
          <h2 id="figs-title" className="ld-display">
            Built around clear boundaries: <span className="dim">who owns the project, who signs, and what counts as evidence.</span>
          </h2>
        </div>
        <div ref={ref} className={`ld-figs-grid ${drawn ? 'is-drawn' : ''}`}>
          {FIGS.map(({ id, title, body, Fig }) => (
            <figure key={id} className="ld-fig">
              <span className="mono ld-fig-n">FIG {id}</span>
              <div className="ld-fig-art">
                <Fig />
              </div>
              <figcaption>
                <strong>{title}</strong>
                <span className="muted">{body}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
