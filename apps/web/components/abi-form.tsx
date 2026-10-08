'use client';

interface Param {
  name?: string;
  type: string;
  components?: Param[];
}

function hint(p: Param): string {
  if (p.type.endsWith(']')) return 'JSON array, e.g. ["1","2"] — quote large integers';
  if (p.type === 'tuple') return `JSON object {${(p.components ?? []).map((c) => c.name || '?').join(', ')}} or array`;
  if (/^u?int/.test(p.type)) return 'whole number (decimal or 0x hex)';
  if (p.type === 'address') return '0x… 20 bytes';
  if (p.type === 'bool') return 'true or false';
  if (/^bytes\d+$/.test(p.type)) return `0x… exactly ${p.type.slice(5)} bytes`;
  if (p.type === 'bytes') return '0x… hex';
  return '';
}

/** Inputs for ABI parameters. Values are sent as raw strings; the server validates and encodes them. */
export function AbiInputs({ params, values, onChange, errors, idPrefix }: { params: Param[]; values: string[]; onChange(v: string[]): void; errors?: string; idPrefix: string }) {
  if (!params.length) return <p className="dim" style={{ margin: 0, fontSize: 13 }}>No arguments.</p>;
  return (
    <>
      {params.map((p, i) => (
        <div className="field" key={`${idPrefix}-${i}`}>
          <label htmlFor={`${idPrefix}-${i}`}>
            {p.name || `arg${i}`} <span className="mono dim">{p.type === 'tuple' ? `tuple(${(p.components ?? []).map((c) => c.type).join(',')})` : p.type}</span>
          </label>
          <input
            id={`${idPrefix}-${i}`}
            className="input mono"
            value={values[i] ?? ''}
            spellCheck={false}
            placeholder={hint(p)}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
        </div>
      ))}
      {errors && <p className="field-error">{errors}</p>}
    </>
  );
}
