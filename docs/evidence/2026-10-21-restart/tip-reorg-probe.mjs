// Bounded, read-only diagnostic: do block hashes near the EVM head change
// (short tip reorgs), and only above the 'finalized' tag? 3 minutes, one sample
// every 3 s. Records every hash seen per height and any replacements.
const RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const DURATION_MS = 3 * 60_000;
const EVERY_MS = 3_000;
let id = 0;
const call = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const seen = new Map(); // height -> Set(hash)
const replacements = [];
let finalizedMax = 0;
let samples = 0;
let errors = 0;
const end = Date.now() + DURATION_MS;
while (Date.now() < end) {
  try {
    const [latest, fin] = await Promise.all([call('eth_getBlockByNumber', ['latest', false]), call('eth_getBlockByNumber', ['finalized', false])]);
    samples++;
    const fn = Number(BigInt(fin.number));
    finalizedMax = Math.max(finalizedMax, fn);
    // Look at the head and the two heights below it.
    const head = Number(BigInt(latest.number));
    for (const h of [head, head - 1, head - 2]) {
      const b = h === head ? latest : await call('eth_getBlockByNumber', ['0x' + h.toString(16), false]);
      if (!b) continue;
      const set = seen.get(h) ?? new Set();
      if (set.size && !set.has(b.hash)) replacements.push({ height: h, previous: [...set], now: b.hash, finalizedAtTime: fn, aboveFinalized: h > fn, at: new Date().toISOString() });
      set.add(b.hash);
      seen.set(h, set);
    }
  } catch {
    errors++;
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
const heights = [...seen.keys()];
console.log(JSON.stringify({ samples, errors, heightsObserved: heights.length, from: Math.min(...heights), to: Math.max(...heights), finalizedMax, replacements, replacedAtOrBelowFinalized: replacements.filter((r) => !r.aboveFinalized).length }, null, 2));
