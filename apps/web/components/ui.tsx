'use client';

import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'idle' | 'unknown';

export function Status({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="status-inline" data-tone={tone}>
      {children}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mini-button"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function KV({ rows }: { rows: Array<[string, React.ReactNode] | null | false> }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map((r) => {
        const [k, v] = r as [string, React.ReactNode];
        return (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? <span className="dim">Unavailable</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<[T, string]>; value: T; onChange(v: T): void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {tabs.map(([id, text]) => (
        <button key={id} role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<[T, string]>; value: T; onChange(v: T): void; label: string }) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map(([id, text]) => (
        <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose(): void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input, select, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="mini-icon" aria-label="Close dialog" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`notice tone-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <strong style={{ display: 'block' }}>{title}</strong>}
        {children && <div className="notice-body">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Pre({ children, max }: { children: React.ReactNode; max?: number }) {
  return (
    <pre className="pre" style={max ? { maxHeight: max } : undefined}>
      {children}
    </pre>
  );
}

/** Lightweight toast for action feedback. */
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div role="status" aria-live="polite" className="toast" data-tone={toast.bad ? 'danger' : 'success'}>
      {toast.msg}
    </div>
  ) : null;
  return { show: (msg: string, bad?: boolean) => setToast({ msg, bad }), node };
}
