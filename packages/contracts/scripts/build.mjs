// Reproducible build of the bundled sample contracts with the pinned solc-js
// compiler. Writes artifacts/<Name>.json containing ABI, creation and runtime
// bytecode, compiler settings, and source/artifact checksums.
//
//   pnpm contracts:build          # rebuild artifacts
//   pnpm --filter @palletdock/contracts check   # fail if committed artifacts differ
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ozRoot = path.dirname(require.resolve('@openzeppelin/contracts/package.json'));
const ozVersion = JSON.parse(readFileSync(path.join(ozRoot, 'package.json'), 'utf8')).version;
const check = process.argv.includes('--check');

// evmVersion "paris" avoids PUSH0/MCOPY/TSTORE until Portaldot V3's Revive EVM
// support for newer opcodes is confirmed by a live deployment.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  metadata: { bytecodeHash: 'none' },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object'] } },
};

const sha = (s) => createHash('sha256').update(s).digest('hex');
const files = readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.sol')).sort();
const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(path.join(root, 'src', f), 'utf8').replace(/\r\n/g, '\n') }]));

function findImports(p) {
  if (p.startsWith('@openzeppelin/contracts/')) {
    const file = path.join(ozRoot, p.slice('@openzeppelin/contracts/'.length));
    return { contents: readFileSync(file, 'utf8').replace(/\r\n/g, '\n') };
  }
  return { error: `Import not allowed: ${p}` };
}

const input = { language: 'Solidity', sources, settings: SETTINGS };
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

if (!existsSync(path.join(root, 'artifacts'))) mkdirSync(path.join(root, 'artifacts'));
let drift = false;
for (const f of files) {
  for (const [name, c] of Object.entries(output.contracts[f])) {
    const creation = '0x' + c.evm.bytecode.object;
    const artifact = {
      contractName: name,
      sourceName: `src/${f}`,
      abi: c.abi,
      bytecode: creation,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      linkReferences: c.evm.bytecode.linkReferences,
      compiler: {
        name: 'solc',
        version: solc.version(),
        settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion, metadata: SETTINGS.metadata },
        dependencies: { '@openzeppelin/contracts': ozVersion },
      },
      provenance: {
        sourceSha256: sha(sources[f].content),
        creationBytecodeSha256: sha(creation),
        compatibility: 'EVM bytecode. Portaldot V3 Revive acceptance is confirmed only by a recorded live deployment (see docs/TESTNET_EVIDENCE.md).',
      },
    };
    const text = JSON.stringify(artifact, null, 2) + '\n';
    const out = path.join(root, 'artifacts', `${name}.json`);
    if (check) {
      const prev = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
      if (prev !== text) {
        console.error(`Artifact drift: ${name}`);
        drift = true;
      }
    } else {
      writeFileSync(out, text);
      console.log(`wrote artifacts/${name}.json (${(creation.length - 2) / 2} bytes creation code, sha256 ${sha(creation).slice(0, 12)}…)`);
    }
  }
}
if (drift) process.exit(1);
