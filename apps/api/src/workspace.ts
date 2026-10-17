import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  decodeErrorResult,
  decodeFunctionData,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Abi,
  type AbiFunction,
  type Hex,
} from 'viem';
import { randomToken, sha256Hex, withTx } from '@palletdock/db';
import {
  EvmAdapter,
  RpcResponseError,
  RpcTransportError,
  SubstrateAdapter,
  probeEvm,
  probeSubstrate,
  type StorageDepositEstimate,
  type UnavailableEstimate,
} from '@palletdock/chain';
import {
  API_KEY_PREFIX,
  MAX_ARTIFACT_BYTES,
  ValidationError,
  coerceArgs,
  contractImportSchema,
  eventTopic0,
  eventsOf,
  functionsOf,
  indexerSourceSchema,
  resolveNetwork,
  signatureOf,
  toLosslessJson,
  validateAbi,
  validateArtifact,
  type PortaldotNetworkConfig,
} from '@palletdock/shared';
import { sampleArtifacts } from '@palletdock/contracts';
import { activeFingerprint, fail, isUuid, param, workspaceGuard } from './context.js';

export interface WorkspaceDeps {
  network?: PortaldotNetworkConfig;
  evm?: EvmAdapter;
  /** Connects a native adapter on demand; null disables native features (tests). */
  substrate?: (() => Promise<SubstrateAdapter>) | null;
  devControls?: boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function rpcErrorMessage(e: unknown): string {
  if (e instanceof RpcTransportError) return `EVM RPC unavailable (${e.kind}): ${e.message}`;
  if (e instanceof RpcResponseError) return `EVM RPC error ${e.code}: ${e.message}`;
  return (e as Error).message;
}

function revertDataOf(e: unknown): Hex | null {
  if (!(e instanceof RpcResponseError)) return null;
  const d = e.data as unknown;
  if (typeof d === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(d)) return d as Hex;
  if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') return (d as { data: Hex }).data;
  return null;
}

/** Decode revert data with the contract ABI (custom errors) plus Error(string)/Panic(uint256). */
export function decodeRevert(abi: Abi | null, data: Hex | null): { name: string; args: unknown; signature: string | null } | null {
  if (!data || data === '0x') return null;
  try {
    const r = decodeErrorResult({ abi: abi ?? [], data });
    return { name: r.errorName, args: toLosslessJson(r.args ?? []), signature: r.abiItem && 'name' in r.abiItem ? `${r.abiItem.name}(${(r.abiItem.inputs ?? []).map((i) => i.type).join(',')})` : null };
  } catch {
    return null;
  }
}

function hexValue(v: unknown, label: string): bigint {
  if (v === undefined || v === null || v === '') return 0n;
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.trim())) throw new ValidationError(`${label} must be a whole number of raw base units.`);
  return BigInt(v.trim());
}

function parseArgsBody(body: Record<string, unknown>): unknown[] {
  const args = body.args ?? [];
  if (!Array.isArray(args)) throw new ValidationError('args must be an array.');
  if (args.length > 64) throw new ValidationError('Too many arguments.');
  return args;
}

export function registerWorkspace(app: FastifyInstance, pool: pg.Pool, deps: WorkspaceDeps = {}) {
  const network = deps.network ?? resolveNetwork();
  const evm = deps.evm ?? new EvmAdapter(network);
  const connectSubstrate =
    deps.substrate !== undefined ? deps.substrate : process.env.PALLETDOCK_NATIVE_ADAPTER === 'disabled' ? null : () => SubstrateAdapter.connect(network, {}, 12_000);
  const devControls = deps.devControls ?? (process.env.PALLETDOCK_DEV_CONTROLS === '1' && process.env.NODE_ENV !== 'production');
  const P = '/workspace/projects/:projectId';

  const body = (r: FastifyRequest) => ((r.body ?? {}) as Record<string, unknown>);

  async function requireFingerprint(reply: FastifyReply) {
    const fp = await activeFingerprint(pool);
    if (!fp) {
      fail(reply, 'SERVICE_UNAVAILABLE', 'The Portaldot network identity has not been verified yet. Chain-bound actions are disabled until the worker records a verified fingerprint.');
      return null;
    }
    return fp;
  }

  async function contractOf(projectId: string, contractId: string) {
    if (!isUuid(contractId)) return null;
    const r = await pool.query(
      `SELECT c.*, c.deploy_block::text AS deploy_block, av.id AS abi_version_id, av.version AS abi_version, av.abi, av.abi_sha256, av.provenance AS abi_provenance, av.created_at AS abi_created_at
         FROM contracts c
         JOIN LATERAL (SELECT * FROM abi_versions a WHERE a.contract_id=c.id ORDER BY a.version DESC LIMIT 1) av ON true
        WHERE c.id=$1 AND c.project_id=$2`,
      [contractId, projectId],
    );
    return r.rows[0] ?? null;
  }

  async function storageDeposit(req: { kind: 'call' | 'instantiate'; from: string; dest?: string; input: string; code?: string; value: bigint }): Promise<StorageDepositEstimate | UnavailableEstimate> {
    if (!connectSubstrate) return { status: 'unavailable', reason: 'Native adapter disabled in this environment.' };
    if (req.value !== 0n) return { status: 'unavailable', reason: 'Dry-run with a non-zero value needs a verified EVM-to-native unit conversion, which is not available.' };
    let sub: SubstrateAdapter | null = null;
    try {
      sub = await connectSubstrate();
      const mapping = await sub.mapEvmAccount(req.from);
      return await sub.dryRunStorageDeposit({ kind: req.kind, originAccountHex: mapping.nativeAccountHex, dest: req.dest, input: req.input, code: req.code });
    } catch (e) {
      return { status: 'unavailable', reason: `Native dry-run unavailable: ${(e as Error).message.split('\n')[0]}` };
    } finally {
      await sub?.disconnect().catch(() => {});
    }
  }

  async function feeEstimate(request: { from: string; to?: string; data: Hex; value: bigint }) {
    try {
      const gas = await evm.estimateGas({ from: request.from, ...(request.to ? { to: request.to } : {}), data: request.data, value: `0x${request.value.toString(16)}` });
      let gasPrice: string | null = null;
      try {
        gasPrice = await evm.gasPrice();
      } catch {
        gasPrice = null;
      }
      return {
        status: 'estimated' as const,
        gasLimitEstimate: gas,
        gasPriceRaw: gasPrice,
        maxFeeRaw: gasPrice ? (BigInt(gas) * BigInt(gasPrice)).toString() : null,
        unit: 'raw EVM base units (denomination unverified)',
        note: 'EVM gas is not native Weight. The wallet may adjust gas and price before you approve.',
      };
    } catch (e) {
      const data = revertDataOf(e);
      return { status: 'failed' as const, error: rpcErrorMessage(e), revertData: data };
    }
  }

  // ================================================================ contracts
  app.get(`${P}/contracts`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const r = await pool.query(
      `SELECT c.id,c.name,c.address,c.source,c.deploy_tx_hash,c.deploy_block::text,c.created_at,c.removed_at,
              (SELECT max(version) FROM abi_versions a WHERE a.contract_id=c.id) AS abi_version,
              EXISTS(SELECT 1 FROM indexer_sources s WHERE s.contract_id=c.id AND s.desired_state <> 'deleted') AS indexed
         FROM contracts c WHERE c.project_id=$1 AND c.removed_at IS NULL ORDER BY c.created_at DESC`,
      [g.project.id],
    );
    return { data: r.rows };
  });

  app.post(`${P}/contracts/import`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const parsed = contractImportSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid import.');
    let abi: Abi;
    try {
      abi = validateAbi(typeof parsed.data.abi === 'string' ? JSON.parse(parsed.data.abi) : parsed.data.abi);
    } catch (e) {
      return fail(reply, 'INVALID_REQUEST', e instanceof SyntaxError ? 'ABI is not valid JSON.' : (e as Error).message);
    }
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    let code: Hex;
    let observedBlock: string;
    try {
      observedBlock = await evm.blockNumber();
      code = await evm.codeAt(parsed.data.address, BigInt(observedBlock));
    } catch (e) {
      return fail(reply, 'SERVICE_UNAVAILABLE', `Runtime code could not be checked: ${rpcErrorMessage(e)}`);
    }
    if (code === '0x') return fail(reply, 'INVALID_REQUEST', `No runtime code exists at ${parsed.data.address} on Portaldot V3 Testnet (checked at block ${observedBlock}). Check the address and network.`);
    const address = getAddress(parsed.data.address).toLowerCase();
    try {
      const out = await withTx(pool, async (c) => {
        const ct = await c.query(
          `INSERT INTO contracts(project_id,fingerprint_id,name,address,source,deploy_tx_hash,deploy_block,code_observed)
           VALUES ($1,$2,$3,$4,'imported',$5,$6,$7) RETURNING id`,
          [
            g.project.id,
            fp.id,
            parsed.data.name,
            address,
            parsed.data.deployTxHash?.toLowerCase() ?? null,
            parsed.data.deployBlock ?? null,
            JSON.stringify({ blockNumber: observedBlock, codeBytes: (code.length - 2) / 2, codeSha256: sha256(code), checkedAt: new Date().toISOString() }),
          ],
        );
        const abiJson = JSON.stringify(abi);
        await c.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,$3,'import')`, [ct.rows[0].id, abiJson, sha256(abiJson)]);
        await c.query(`UPDATE projects SET updated_at=now() WHERE id=$1`, [g.project.id]);
        return ct.rows[0].id as string;
      });
      return reply.code(201).send({ data: { id: out, address, codeObservedAtBlock: observedBlock, note: 'ABI attached. This is not source verification and does not prove ownership.' } });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return fail(reply, 'CONFLICT', 'This contract address is already tracked in this project.');
      throw e;
    }
  });

  app.get(`${P}/contracts/:contractId`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const c = await contractOf(g.project.id, param(request, 'contractId'));
    if (!c) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    const [versions, sources] = await Promise.all([
      pool.query(`SELECT id,version,abi_sha256,provenance,created_at FROM abi_versions WHERE contract_id=$1 ORDER BY version DESC`, [c.id]),
      pool.query(
        `SELECT s.id,s.status,s.desired_state,s.start_block::text,s.end_block::text,ck.block_number::text AS checkpoint_block
           FROM indexer_sources s LEFT JOIN indexer_checkpoints ck ON ck.source_id=s.id WHERE s.contract_id=$1 AND s.desired_state <> 'deleted'`,
        [c.id],
      ),
    ]);
    const abi = c.abi as Abi;
    return {
      data: {
        id: c.id,
        name: c.name,
        address: c.address,
        source: c.source,
        deployTxHash: c.deploy_tx_hash,
        deployBlock: c.deploy_block,
        codeObserved: c.code_observed,
        removedAt: c.removed_at,
        createdAt: c.created_at,
        abi,
        abiVersion: { id: c.abi_version_id, version: c.abi_version, sha256: c.abi_sha256, provenance: c.abi_provenance, createdAt: c.abi_created_at },
        abiVersions: versions.rows,
        readFunctions: functionsOf(abi, 'read').map((f) => ({ name: f.name, signature: signatureOf(f), inputs: f.inputs, outputs: f.outputs })),
        writeFunctions: functionsOf(abi, 'write').map((f) => ({ name: f.name, signature: signatureOf(f), inputs: f.inputs, payable: f.stateMutability === 'payable' })),
        events: eventsOf(abi).map((e) => ({ name: e.name, signature: signatureOf(e), topic0: eventTopic0(e) })),
        indexerSources: sources.rows,
        verificationStatus: 'unavailable',
      },
    };
  });

  app.get(`${P}/contracts/:contractId/abi`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const contractId = param(request, 'contractId');
    if (!isUuid(contractId)) return fail(reply, 'NOT_FOUND', 'Contract not found.');
    const v = (request.query as Record<string, string>).version;
    const r = await pool.query(
      `SELECT a.version,a.abi,a.abi_sha256,a.provenance,a.created_at,c.name,c.address FROM abi_versions a JOIN contracts c ON c.id=a.contract_id
        WHERE c.id=$1 AND c.project_id=$2 ${v ? 'AND a.version=$3' : ''} ORDER BY a.version DESC LIMIT 1`,
      v ? [contractId, g.project.id, Number(v) || -1] : [contractId, g.project.id],
    );
    if (!r.rowCount) return fail(reply, 'NOT_FOUND', 'ABI version not found.');
    return { data: r.rows[0] };
  });

  app.post(`${P}/contracts/:contractId/abi`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const c = await contractOf(g.project.id, param(request, 'contractId'));
    if (!c || c.removed_at) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    let abi: Abi;
    try {
      const raw = body(request).abi;
      abi = validateAbi(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (e) {
      return fail(reply, 'INVALID_REQUEST', e instanceof SyntaxError ? 'ABI is not valid JSON.' : (e as Error).message);
    }
    const abiJson = JSON.stringify(abi);
    if (sha256(abiJson) === c.abi_sha256) return fail(reply, 'CONFLICT', 'This ABI is identical to the current version.');
    const r = await pool.query(
      `INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,(SELECT max(version)+1 FROM abi_versions WHERE contract_id=$1),$2,$3,'replacement') RETURNING id,version`,
      [c.id, abiJson, sha256(abiJson)],
    );
    return reply.code(201).send({ data: r.rows[0], note: 'Earlier versions and decoded records are kept. Existing indexer sources keep decoding with the version they were configured with.' });
  });

  app.post(`${P}/contracts/:contractId/remove`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const contractId = param(request, 'contractId');
    if (!isUuid(contractId)) return fail(reply, 'NOT_FOUND', 'Contract not found.');
    const r = await withTx(pool, async (c) => {
      const u = await c.query(`UPDATE contracts SET removed_at=now() WHERE id=$1 AND project_id=$2 AND removed_at IS NULL RETURNING id`, [contractId, g.project.id]);
      if (!u.rowCount) return null;
      await c.query(`UPDATE indexer_sources SET desired_state='deleted', status='stopped', generation=generation+1, updated_at=now() WHERE contract_id=$1`, [contractId]);
      return u.rows[0];
    });
    if (!r) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    return { data: { id: contractId, removed: true, note: 'Removed from workspace tracking only. On-chain code is unchanged. Historical transactions and logs are kept.' } };
  });

  app.post(`${P}/contracts/:contractId/read`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const c = await contractOf(g.project.id, param(request, 'contractId'));
    if (!c) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    const b = body(request);
    const abi = c.abi as Abi;
    const fn = functionsOf(abi, 'read').find((f) => signatureOf(f) === b.function || f.name === b.function);
    if (!fn) return fail(reply, 'INVALID_REQUEST', 'Select a read function from the attached ABI.');
    let data: Hex;
    try {
      data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn.inputs, parseArgsBody(b)) as never });
    } catch (e) {
      return fail(reply, 'INVALID_REQUEST', (e as Error).message);
    }
    let block: string;
    let raw: Hex;
    try {
      block = await evm.blockNumber();
      raw = await evm.call({ to: c.address, data }, BigInt(block));
    } catch (e) {
      const rd = revertDataOf(e);
      if (rd || e instanceof RpcResponseError) {
        return reply.code(200).send({ data: { ok: false, error: rpcErrorMessage(e), revertData: rd, revert: decodeRevert(abi, rd) } });
      }
      return fail(reply, 'SERVICE_UNAVAILABLE', rpcErrorMessage(e));
    }
    try {
      const decoded = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw });
      return { data: { ok: true, function: signatureOf(fn), outputs: fn.outputs, result: toLosslessJson(decoded), raw, blockNumber: block, observedAt: new Date().toISOString() } };
    } catch (e) {
      return { data: { ok: false, function: signatureOf(fn), error: `Return data does not match the ABI: ${(e as Error).message.split('\n')[0]}`, raw, blockNumber: block } };
    }
  });

  app.post(`${P}/contracts/:contractId/prepare-write`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const c = await contractOf(g.project.id, param(request, 'contractId'));
    if (!c || c.removed_at) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    const b = body(request);
    const abi = c.abi as Abi;
    const fn = functionsOf(abi, 'write').find((f) => signatureOf(f) === b.function || f.name === b.function);
    if (!fn) return fail(reply, 'INVALID_REQUEST', 'Select a write function from the attached ABI.');
    if (typeof b.from !== 'string' || !isAddress(b.from, { strict: false })) return fail(reply, 'INVALID_REQUEST', 'Connect a wallet account first.');
    let data: Hex, value: bigint, args: unknown[];
    try {
      args = coerceArgs(fn.inputs, parseArgsBody(b));
      value = hexValue(b.value, 'value');
      if (value > 0n && fn.stateMutability !== 'payable') throw new ValidationError('This function is not payable; value must be 0.');
      data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: args as never });
    } catch (e) {
      return fail(reply, 'INVALID_REQUEST', (e as Error).message);
    }
    const from = getAddress(b.from);
    const [fee, deposit] = await Promise.all([
      feeEstimate({ from, to: c.address, data, value }),
      storageDeposit({ kind: 'call', from, dest: c.address, input: data, value }),
    ]);
    const revert = fee.status === 'failed' ? decodeRevert(abi, fee.revertData ?? null) : null;
    const tx = await pool.query(
      `INSERT INTO transactions(project_id,fingerprint_id,contract_id,abi_version_id,origin,kind,from_address,to_address,input,value_raw,function_name,decoded_args,submission_status,estimates)
       VALUES ($1,$2,$3,$4,'palletdock','call',$5,$6,$7,$8,$9,$10,'prepared',$11) RETURNING id`,
      [g.project.id, fp.id, c.id, c.abi_version_id, from.toLowerCase(), c.address, data, value.toString(), signatureOf(fn), JSON.stringify(toLosslessJson(args)), JSON.stringify({ fee, storageDeposit: deposit, revert })],
    );
    await pool.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,'prepared','Write prepared for wallet review.','api')`, [tx.rows[0].id]);
    return {
      data: {
        transactionId: tx.rows[0].id,
        request: { from, to: c.address, data, value: `0x${value.toString(16)}`, chainId: `0x${network.evmChainId.toString(16)}` },
        review: {
          network: `${network.name} · EVM chain ${network.evmChainId}`,
          function: signatureOf(fn),
          args: toLosslessJson(args),
          valueRaw: value.toString(),
          fee,
          storageDeposit: deposit,
          simulatedRevert: revert,
        },
      },
    };
  });

  app.get(`${P}/contracts/:contractId/events`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const contractId = param(request, 'contractId');
    if (!isUuid(contractId)) return fail(reply, 'NOT_FOUND', 'Contract not found.');
    const q = request.query as Record<string, string>;
    const values: unknown[] = [g.project.id, contractId];
    const cond = ['r.project_id=$1', 's.contract_id=$2', 'r.canonical=true'];
    const push = (sql: (i: number) => string, v: unknown) => {
      values.push(v);
      cond.push(sql(values.length));
    };
    try {
      for (const k of ['fromBlock', 'toBlock'] as const) if (q[k] && !/^(0|[1-9][0-9]{0,18})$/.test(q[k])) throw new Error(`${k} must be a whole number.`);
      if (q.fromBlock && q.toBlock && BigInt(q.toBlock) < BigInt(q.fromBlock)) throw new Error('To block must be at least From block.');
    } catch (e) {
      return fail(reply, 'INVALID_QUERY', (e as Error).message);
    }
    if (q.fromBlock) push((i) => `r.block_number >= $${i}::bigint`, q.fromBlock);
    if (q.toBlock) push((i) => `r.block_number <= $${i}::bigint`, q.toBlock);
    if (q.event && q.event !== 'all') push((i) => `d.event_name = $${i}`, q.event);
    if (q.decode && ['decoded', 'unknown_event', 'decode_error'].includes(q.decode)) push((i) => `d.status = $${i}`, q.decode);
    if (q.before && /^[0-9]+$/.test(q.before)) push((i) => `r.seq < $${i}::bigint`, q.before);
    const r = await pool.query(
      `SELECT r.id,r.seq::text,r.block_number::text,r.block_hash,r.transaction_hash,r.log_index,r.topics,r.data,r.indexed_at,d.status,d.event_name,d.event_signature,d.args,d.decode_error,av.version AS abi_version
         FROM raw_logs r JOIN indexer_sources s ON s.id=r.source_id LEFT JOIN decoded_events d ON d.raw_log_id=r.id LEFT JOIN abi_versions av ON av.id=d.abi_version_id
        WHERE ${cond.join(' AND ')} ORDER BY r.seq DESC LIMIT 101`,
      values,
    );
    return { data: r.rows.slice(0, 100), nextBefore: r.rows.length > 100 ? r.rows[99].seq : null };
  });

  // ================================================================ artifacts
  app.get(`${P}/artifacts`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const uploaded = await pool.query(
      `SELECT id,name,contract_name,bytecode_kind,compiler,checksum_sha256,provenance,created_at,abi FROM artifacts WHERE project_id=$1 ORDER BY created_at DESC`,
      [g.project.id],
    );
    const describe = (abi: Abi) => {
      const ctor = abi.find((e) => e.type === 'constructor') as { inputs?: unknown[]; stateMutability?: string } | undefined;
      return { constructorInputs: ctor?.inputs ?? [], payable: ctor?.stateMutability === 'payable' };
    };
    return {
      data: {
        samples: sampleArtifacts().map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          contractName: s.artifact.contractName,
          compiler: s.artifact.compiler,
          creationBytecodeSha256: s.artifact.provenance.creationBytecodeSha256,
          creationBytes: (s.artifact.bytecode.length - 2) / 2,
          abi: s.artifact.abi,
          ...describe(s.artifact.abi),
        })),
        artifacts: uploaded.rows.map((a) => ({ id: a.id, name: a.name, contractName: a.contract_name, bytecodeKind: a.bytecode_kind, compiler: a.compiler, checksum: a.checksum_sha256, provenance: a.provenance, createdAt: a.created_at, ...describe(a.abi) })),
      },
    };
  });

  async function storeArtifact(projectId: string, name: string, raw: unknown, provenance: 'bundled-sample' | 'uploaded') {
    const v = validateArtifact(raw);
    const checksum = sha256(v.creationBytecode.toLowerCase() + JSON.stringify(v.abi));
    const r = await pool.query(
      `INSERT INTO artifacts(project_id,name,contract_name,abi,creation_bytecode,deployed_bytecode,bytecode_kind,compiler,checksum_sha256,provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id,checksum_sha256) DO UPDATE SET name=artifacts.name RETURNING id`,
      [projectId, name, v.contractName, JSON.stringify(v.abi), v.creationBytecode.toLowerCase(), v.deployedBytecode?.toLowerCase() ?? null, v.bytecodeKind, v.compiler ? JSON.stringify(v.compiler) : null, checksum, provenance],
    );
    return { id: r.rows[0].id as string, warnings: v.warnings, bytecodeKind: v.bytecodeKind };
  }

  app.post(`${P}/artifacts`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const b = body(request);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
    let raw = b.artifact;
    if (typeof raw === 'string') {
      if (raw.length > MAX_ARTIFACT_BYTES) return fail(reply, 'PAYLOAD_TOO_LARGE', 'Artifact files are limited to 2 MB.');
      try {
        raw = JSON.parse(raw);
      } catch {
        return fail(reply, 'INVALID_REQUEST', 'Artifact is not valid JSON.');
      }
    }
    try {
      const out = await storeArtifact(g.project.id, name || (raw as { contractName?: string })?.contractName || 'Uploaded artifact', raw, 'uploaded');
      return reply.code(201).send({ data: out });
    } catch (e) {
      if (e instanceof ValidationError) return fail(reply, 'INVALID_REQUEST', e.message);
      throw e;
    }
  });

  app.post(`${P}/artifacts/samples/:sampleId`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const s = sampleArtifacts().find((x) => x.id === param(request, 'sampleId'));
    if (!s) return fail(reply, 'NOT_FOUND', 'Sample artifact not found.');
    return reply.code(201).send({ data: await storeArtifact(g.project.id, s.title, s.artifact, 'bundled-sample') });
  });

  app.post(`${P}/artifacts/:artifactId/prepare-deploy`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const artifactId = param(request, 'artifactId');
    if (!isUuid(artifactId)) return fail(reply, 'NOT_FOUND', 'Artifact not found.');
    const art = (await pool.query(`SELECT * FROM artifacts WHERE id=$1 AND project_id=$2`, [artifactId, g.project.id])).rows[0];
    if (!art) return fail(reply, 'NOT_FOUND', 'Artifact not found in this project.');
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    const b = body(request);
    if (typeof b.from !== 'string' || !isAddress(b.from, { strict: false })) return fail(reply, 'INVALID_REQUEST', 'Connect a wallet account first.');
    const abi = art.abi as Abi;
    const ctor = abi.find((e) => e.type === 'constructor') as { inputs?: AbiFunction['inputs']; stateMutability?: string } | undefined;
    let data: Hex, value: bigint, args: unknown[];
    try {
      args = coerceArgs(ctor?.inputs ?? [], parseArgsBody(b));
      value = hexValue(b.value, 'value');
      if (value > 0n && ctor?.stateMutability !== 'payable') throw new ValidationError('The constructor is not payable; value must be 0.');
      data = encodeDeployData({ abi, bytecode: art.creation_bytecode as Hex, args: args as never });
    } catch (e) {
      return fail(reply, 'INVALID_REQUEST', (e as Error).message);
    }
    const from = getAddress(b.from);
    const [fee, deposit] = await Promise.all([
      feeEstimate({ from, data, value }),
      storageDeposit({ kind: 'instantiate', from, input: '0x', code: art.creation_bytecode, value }),
    ]);
    const revert = fee.status === 'failed' ? decodeRevert(abi, fee.revertData ?? null) : null;
    const tx = await pool.query(
      `INSERT INTO transactions(project_id,fingerprint_id,artifact_id,origin,kind,from_address,to_address,input,value_raw,function_name,decoded_args,submission_status,estimates)
       VALUES ($1,$2,$3,'palletdock','deploy',$4,NULL,$5,$6,'constructor',$7,'prepared',$8) RETURNING id`,
      [g.project.id, fp.id, art.id, from.toLowerCase(), data, value.toString(), JSON.stringify(toLosslessJson(args)), JSON.stringify({ fee, storageDeposit: deposit, revert })],
    );
    await pool.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,'prepared','Deployment prepared for wallet review.','api')`, [tx.rows[0].id]);
    return {
      data: {
        transactionId: tx.rows[0].id,
        request: { from, data, value: `0x${value.toString(16)}`, chainId: `0x${network.evmChainId.toString(16)}` },
        review: {
          network: `${network.name} · EVM chain ${network.evmChainId}`,
          artifact: { name: art.name, contractName: art.contract_name, checksum: art.checksum_sha256, bytecodeKind: art.bytecode_kind, compiler: art.compiler },
          args: toLosslessJson(args),
          valueRaw: value.toString(),
          fee,
          storageDeposit: deposit,
          simulatedRevert: revert,
        },
      },
    };
  });

  // ================================================================ transactions
  async function txOf(projectId: string, txId: string) {
    if (!isUuid(txId)) return null;
    return (await pool.query(`SELECT * FROM transactions WHERE id=$1 AND project_id=$2`, [txId, projectId])).rows[0] ?? null;
  }

  app.post(`${P}/transactions/:txId/submission`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true, allowArchived: true });
    if (!g) return;
    const t = await txOf(g.project.id, param(request, 'txId'));
    if (!t) return fail(reply, 'NOT_FOUND', 'Transaction not found.');
    const b = body(request);
    const outcome = b.outcome;
    const hash = typeof b.hash === 'string' && HASH_RE.test(b.hash) ? b.hash.toLowerCase() : null;
    const err = typeof b.error === 'string' ? b.error.slice(0, 500) : null;
    if (!['rejected', 'submitted', 'unknown', 'wrong_network', 'failed_before_broadcast'].includes(String(outcome))) return fail(reply, 'INVALID_REQUEST', 'Unknown submission outcome.');
    if (outcome === 'submitted' && !hash) return fail(reply, 'INVALID_REQUEST', 'A submitted transaction needs its 32-byte hash.');
    if (t.submission_status === 'submitted' && outcome !== 'submitted') return fail(reply, 'CONFLICT', 'This transaction was already recorded as submitted; it cannot be marked otherwise.');
    if (t.hash && hash && t.hash !== hash) return fail(reply, 'CONFLICT', 'This record already has a different hash.');
    const status = outcome === 'submitted' ? 'submitted' : outcome === 'unknown' ? 'unknown' : 'rejected';
    try {
      await withTx(pool, async (c) => {
        await c.query(
          `UPDATE transactions SET submission_status=$2, hash=COALESCE(hash,$3), error_message=$4, inclusion_status=CASE WHEN $3::text IS NOT NULL THEN 'pending' ELSE inclusion_status END, updated_at=now() WHERE id=$1`,
          [t.id, status, hash, err],
        );
        const detail =
          outcome === 'submitted'
            ? `Wallet returned transaction hash ${hash}.`
            : outcome === 'unknown'
              ? `Submission result unknown${hash ? ` (hash ${hash})` : ''}: ${err ?? 'no response from wallet'}. Do not resubmit until account activity is checked.`
              : outcome === 'rejected'
                ? 'Rejected in the wallet before broadcast. Nothing was submitted.'
                : outcome === 'wrong_network'
                  ? 'Blocked before signing: the wallet is on a different chain.'
                  : `Failed before broadcast: ${err ?? 'unknown error'}`;
        await c.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,$2,$3,'browser-wallet')`, [t.id, outcome, detail]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return fail(reply, 'CONFLICT', 'This hash is already tracked in this project.');
      throw e;
    }
    return { data: { id: t.id, submissionStatus: status, hash: hash ?? t.hash } };
  });

  app.post(`${P}/transactions/register`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const hash = String(body(request).hash ?? '').trim().toLowerCase();
    if (!HASH_RE.test(hash)) return fail(reply, 'INVALID_REQUEST', 'Enter a 32-byte 0x transaction hash.');
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    let tx: Record<string, any> | null;
    try {
      tx = await evm.rpc.call<Record<string, any> | null>('eth_getTransactionByHash', [hash]);
    } catch (e) {
      return fail(reply, 'SERVICE_UNAVAILABLE', `Transaction could not be looked up: ${rpcErrorMessage(e)}`);
    }
    if (!tx) return fail(reply, 'NOT_FOUND', 'The EVM RPC does not know this transaction hash on Portaldot V3 Testnet.');
    // Decode input when the destination is a tracked contract.
    let contract: Record<string, any> | null = null;
    let fnName: string | null = null;
    let args: unknown = null;
    if (tx.to) {
      contract = (
        await pool.query(
          `SELECT c.id, av.id AS abi_version_id, av.abi FROM contracts c JOIN LATERAL (SELECT * FROM abi_versions a WHERE a.contract_id=c.id ORDER BY version DESC LIMIT 1) av ON true
            WHERE c.project_id=$1 AND lower(c.address)=lower($2) AND c.removed_at IS NULL`,
          [g.project.id, tx.to],
        )
      ).rows[0] ?? null;
      if (contract) {
        try {
          const d = decodeFunctionData({ abi: contract.abi as Abi, data: tx.input as Hex });
          fnName = d.functionName;
          args = toLosslessJson(d.args ?? []);
        } catch {
          fnName = null;
        }
      }
    }
    try {
      const r = await withTx(pool, async (c) => {
        const ins = await c.query(
          `INSERT INTO transactions(project_id,fingerprint_id,contract_id,abi_version_id,origin,kind,hash,from_address,to_address,input,value_raw,nonce,function_name,decoded_args,submission_status,inclusion_status)
           VALUES ($1,$2,$3,$4,'registered',$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted','pending') RETURNING id`,
          [
            g.project.id,
            fp.id,
            contract?.id ?? null,
            contract?.abi_version_id ?? null,
            tx.to ? 'call' : 'deploy',
            hash,
            String(tx.from).toLowerCase(),
            tx.to ? String(tx.to).toLowerCase() : null,
            tx.input,
            BigInt(tx.value ?? '0x0').toString(),
            BigInt(tx.nonce ?? '0x0').toString(),
            fnName,
            args === null ? null : JSON.stringify(args),
          ],
        );
        await c.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,'registered','Hash registered explicitly; found by eth_getTransactionByHash.','api')`, [ins.rows[0].id]);
        return ins.rows[0].id;
      });
      return reply.code(201).send({ data: { id: r } });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return fail(reply, 'CONFLICT', 'This hash is already tracked in this project.');
      throw e;
    }
  });

  app.get(`${P}/transactions`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const q = request.query as Record<string, string>;
    const values: unknown[] = [g.project.id];
    const cond = ['t.project_id=$1'];
    const f = q.filter ?? 'all';
    const filters: Record<string, string> = {
      success: `t.execution_status='success'`,
      reverted: `t.execution_status='reverted'`,
      pending: `t.submission_status='submitted' AND t.inclusion_status IN ('not_observed','pending')`,
      unknown: `t.submission_status='unknown' OR t.inclusion_status='reorged_out'`,
      rejected: `t.submission_status='rejected'`,
      prepared: `t.submission_status='prepared'`,
    };
    if (f !== 'all') {
      if (!filters[f]) return fail(reply, 'INVALID_QUERY', 'Unknown filter.');
      cond.push(`(${filters[f]})`);
    }
    if (q.hash) {
      if (!HASH_RE.test(q.hash)) return fail(reply, 'INVALID_QUERY', 'hash must be a 32-byte 0x transaction hash.');
      values.push(q.hash.toLowerCase());
      cond.push(`lower(t.hash) = $${values.length}`);
    }
    if (q.before) {
      const [ts, id] = q.before.split('|');
      if (!isUuid(id) || Number.isNaN(Date.parse(ts))) return fail(reply, 'INVALID_QUERY', 'Invalid page cursor.');
      values.push(ts, id);
      cond.push(`(t.created_at,t.id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
    }
    const r = await pool.query(
      `SELECT t.id,t.kind,t.origin,t.hash,t.function_name,t.decoded_args,t.submission_status,t.inclusion_status,t.execution_status,t.finality_status,t.indexing_status,
              t.block_number::text,t.contract_id,t.contract_address,t.created_at,c.name AS contract_name
         FROM transactions t LEFT JOIN contracts c ON c.id=t.contract_id
        WHERE ${cond.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT 51`,
      values,
    );
    const page = r.rows.slice(0, 50);
    const last = page.at(-1);
    return { data: page, nextBefore: r.rows.length > 50 && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null, scope: 'Transactions submitted through PalletDock or explicitly registered.' };
  });

  app.get(`${P}/transactions/:txId`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const t = await txOf(g.project.id, param(request, 'txId'));
    if (!t) return fail(reply, 'NOT_FOUND', 'Transaction not found.');
    const [obs, logs, contract, fp] = await Promise.all([
      pool.query(`SELECT stage,detail,source,observed_at FROM transaction_observations WHERE transaction_id=$1 ORDER BY id`, [t.id]),
      t.hash
        ? pool.query(
            `SELECT r.id,r.block_number::text,r.block_hash,r.log_index,r.canonical,r.topics,r.data,d.status,d.event_name,d.event_signature,d.args,d.decode_error,av.version AS abi_version
               FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id LEFT JOIN abi_versions av ON av.id=d.abi_version_id
              WHERE r.project_id=$1 AND lower(r.transaction_hash)=lower($2) ORDER BY r.canonical DESC, r.log_index`,
            [g.project.id, t.hash],
          )
        : Promise.resolve({ rows: [] }),
      t.contract_id ? pool.query(`SELECT id,name,address FROM contracts WHERE id=$1`, [t.contract_id]) : Promise.resolve({ rows: [] }),
      pool.query(`SELECT genesis_hash,evm_chain_id::text,status FROM network_fingerprints WHERE id=$1`, [t.fingerprint_id]),
    ]);
    let revert = t.revert_decoded;
    if (!revert && t.revert_data && t.abi_version_id) {
      const abi = (await pool.query(`SELECT abi FROM abi_versions WHERE id=$1`, [t.abi_version_id])).rows[0]?.abi;
      revert = decodeRevert(abi, t.revert_data);
    }
    return {
      data: {
        id: t.id,
        kind: t.kind,
        origin: t.origin,
        hash: t.hash,
        network: { networkId: 'portaldot-v3-testnet', ...fp.rows[0] },
        from: t.from_address,
        to: t.to_address,
        contract: contract.rows[0] ?? null,
        contractAddress: t.contract_address,
        input: t.input,
        function: t.function_name,
        decodedArgs: t.decoded_args,
        valueRaw: t.value_raw,
        nonce: t.nonce,
        status: { submission: t.submission_status, inclusion: t.inclusion_status, execution: t.execution_status, finality: t.finality_status, indexing: t.indexing_status },
        blockNumber: t.block_number,
        blockHash: t.block_hash,
        gasUsed: t.gas_used,
        effectiveGasPriceRaw: t.effective_gas_price,
        feeRaw: t.fee_raw,
        storageDeposit: t.storage_deposit ?? t.estimates?.storageDeposit ?? { status: 'unavailable', reason: 'No compatible receipt source reports storage deposits.' },
        estimates: t.estimates,
        receipt: t.receipt,
        revertData: t.revert_data,
        revert,
        error: t.error_message,
        observations: obs.rows,
        logs: logs.rows,
        unitNote: 'Fee, value and gas price are raw EVM base units. The EVM facade denomination is unverified, so no decimal conversion is shown.',
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      },
    };
  });

  app.post(`${P}/transactions/:txId/reconcile`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true, allowArchived: true });
    if (!g) return;
    const t = await txOf(g.project.id, param(request, 'txId'));
    if (!t) return fail(reply, 'NOT_FOUND', 'Transaction not found.');
    try {
      if (t.hash) {
        const receipt = await evm.receipt(t.hash);
        await pool.query(`UPDATE transactions SET last_checked_at=NULL WHERE id=$1`, [t.id]);
        await pool.query(
          `INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,'reconcile',$2,'api')`,
          [t.id, receipt ? `Receipt found in block ${receipt.blockNumber}; the tracker will record it.` : 'No receipt yet. This is not proof the transaction failed.'],
        );
        return { data: { hash: t.hash, receiptFound: !!receipt } };
      }
      if (!t.from_address) return fail(reply, 'INVALID_REQUEST', 'No sender is recorded for this transaction.');
      const [latest, pending] = await Promise.all([
        evm.rpc.call<string>('eth_getTransactionCount', [getAddress(t.from_address), 'latest']),
        evm.rpc.call<string>('eth_getTransactionCount', [getAddress(t.from_address), 'pending']),
      ]);
      const detail = `Account nonce: latest ${BigInt(latest)}, pending ${BigInt(pending)}. No hash was returned by the wallet; compare with your wallet's activity before retrying.`;
      await pool.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,'reconcile',$2,'api')`, [t.id, detail]);
      return { data: { hash: null, nonceLatest: BigInt(latest).toString(), noncePending: BigInt(pending).toString() } };
    } catch (e) {
      return fail(reply, 'SERVICE_UNAVAILABLE', rpcErrorMessage(e));
    }
  });

  // ================================================================ indexer
  app.get(`${P}/indexer`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const r = await pool.query(
      `SELECT s.id,s.contract_id,s.contract_address,s.event_names,s.start_block::text,s.end_block::text,s.desired_state,s.status,s.generation::text,s.reorg_epoch::text,
              s.last_error,s.last_error_at,s.latest_observed_block::text,s.latest_observed_at,s.finality_policy,s.created_at,s.updated_at,
              c.name AS contract_name, av.version AS abi_version,
              ck.block_number::text AS checkpoint_block, ck.block_hash AS checkpoint_hash, ck.committed_at AS checkpoint_at,
              j.attempts, j.next_run_at, j.chunk_size, j.lease_owner,
              (SELECT count(*)::int FROM raw_logs r WHERE r.source_id=s.id AND r.canonical) AS records,
              (SELECT count(*)::int FROM raw_logs r WHERE r.source_id=s.id AND NOT r.canonical) AS orphaned
         FROM indexer_sources s JOIN contracts c ON c.id=s.contract_id JOIN abi_versions av ON av.id=s.abi_version_id
         LEFT JOIN indexer_checkpoints ck ON ck.source_id=s.id LEFT JOIN indexer_jobs j ON j.source_id=s.id
        WHERE s.project_id=$1 AND s.desired_state <> 'deleted' ORDER BY s.created_at DESC`,
      [g.project.id],
    );
    const ids = r.rows.map((s) => s.id);
    const records = ids.length
      ? await pool.query(
          `SELECT r.id,r.source_id,r.block_number::text,r.transaction_hash,r.log_index,d.status,d.event_name,d.args
             FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id
            WHERE r.source_id = ANY($1::uuid[]) AND r.canonical ORDER BY r.seq DESC LIMIT 25`,
          [ids],
        )
      : { rows: [] };
    return { data: { sources: r.rows, recentRecords: records.rows, devControls } };
  });

  app.post(`${P}/indexer/sources`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const parsed = indexerSourceSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid indexer configuration.');
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    const c = await contractOf(g.project.id, parsed.data.contractId);
    if (!c || c.removed_at) return fail(reply, 'NOT_FOUND', 'Contract not found in this project.');
    if (c.fingerprint_id !== fp.id) return fail(reply, 'CONFLICT', 'This contract was tracked on a different network identity. Re-import it on the current network.');
    const abiEvents = eventsOf(c.abi as Abi);
    const selected = parsed.data.events.map((n) => abiEvents.find((e) => e.name === n || signatureOf(e) === n));
    if (selected.some((e) => !e)) return fail(reply, 'INVALID_REQUEST', 'Every selected event must exist in the attached ABI.');
    const start = BigInt(parsed.data.startBlock);
    const end = parsed.data.endBlock ? BigInt(parsed.data.endBlock) : null;
    if (end !== null && end < start) return fail(reply, 'INVALID_REQUEST', 'End block must be at least the start block.');
    if (c.deploy_block && start < BigInt(c.deploy_block)) return fail(reply, 'INVALID_REQUEST', `Start block is before the recorded deployment block ${c.deploy_block}.`);
    // The indexer verifies block ancestry, so the start block must still be served by the node.
    try {
      await evm.blockHeader(start);
    } catch (e) {
      if (e instanceof RpcResponseError && /state already discarded|unknownblock|pruned/i.test(e.message)) {
        let head = '';
        try {
          head = await evm.blockNumber();
        } catch {
          head = '';
        }
        return fail(
          reply,
          'INVALID_REQUEST',
          `Start block ${start} is older than the RPC node retains (it discards state beyond roughly the last few hundred blocks${head ? `; head is ${head}` : ''}). Choose a recent start block, ideally the deployment block soon after deploying.`,
        );
      }
      return fail(reply, 'SERVICE_UNAVAILABLE', `The start block could not be checked: ${rpcErrorMessage(e)}`);
    }
    const replaces = typeof body(request).replaceSourceId === 'string' ? String(body(request).replaceSourceId) : null;
    const id = await withTx(pool, async (tx) => {
      if (replaces) {
        if (!isUuid(replaces)) throw new ValidationError('Invalid source to replace.');
        const u = await tx.query(
          `UPDATE indexer_sources SET desired_state='deleted', status='stopped', generation=generation+1, updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING id`,
          [replaces, g.project.id],
        );
        if (!u.rowCount) throw new ValidationError('The source to replace was not found.');
      }
      const s = await tx.query(
        `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,end_block)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [g.project.id, c.id, fp.id, c.abi_version_id, c.address.toLowerCase(), selected.map((e) => e!.name), selected.map((e) => eventTopic0(e!)), start.toString(), end?.toString() ?? null],
      );
      await tx.query(`INSERT INTO indexer_jobs(source_id) VALUES ($1)`, [s.rows[0].id]);
      await tx.query(`INSERT INTO ops_logs(project_id,source,level,message,detail,indexer_source_id) VALUES ($1,'indexer','INFO','Log source configured',$2,$3)`, [
        g.project.id,
        JSON.stringify({ contract: c.address, events: selected.map((e) => signatureOf(e!)), startBlock: start.toString(), endBlock: end?.toString() ?? null, replaces }),
        s.rows[0].id,
      ]);
      return s.rows[0].id as string;
    }).catch((e) => {
      if (e instanceof ValidationError) return e;
      throw e;
    });
    if (id instanceof ValidationError) return fail(reply, 'INVALID_REQUEST', id.message);
    return reply.code(201).send({ data: { id } });
  });

  const lifecycle = async (request: FastifyRequest, reply: FastifyReply, action: 'pause' | 'resume' | 'reconnect' | 'reindex' | 'simulate-failure' | 'delete') => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true, allowArchived: action === 'delete' });
    if (!g) return;
    const sourceId = param(request, 'sourceId');
    if (!isUuid(sourceId)) return fail(reply, 'NOT_FOUND', 'Indexer source not found.');
    const s = (await pool.query(`SELECT * FROM indexer_sources WHERE id=$1 AND project_id=$2 AND desired_state <> 'deleted'`, [sourceId, g.project.id])).rows[0];
    if (!s) return fail(reply, 'NOT_FOUND', 'Indexer source not found.');
    const log = (c: pg.PoolClient, m: string, level = 'INFO') =>
      c.query(`INSERT INTO ops_logs(project_id,source,level,message,indexer_source_id) VALUES ($1,'indexer',$2,$3,$4)`, [g.project.id, level, m, sourceId]);
    if (action === 'simulate-failure' && !devControls) return fail(reply, 'FORBIDDEN_SCOPE', 'Simulated RPC failures are development controls and are disabled here.');
    await withTx(pool, async (c) => {
      switch (action) {
        case 'pause':
          await c.query(`UPDATE indexer_sources SET desired_state='paused', status='paused', generation=generation+1, updated_at=now() WHERE id=$1`, [sourceId]);
          await log(c, 'Paused by owner. In-flight work is fenced and discarded; the checkpoint is kept.');
          break;
        case 'resume':
          await c.query(
            `UPDATE indexer_sources SET desired_state='running', status=CASE WHEN status IN ('recovery_required','completed') THEN status ELSE 'pending' END, generation=generation+1, updated_at=now() WHERE id=$1`,
            [sourceId],
          );
          await c.query(`UPDATE indexer_jobs SET next_run_at=now(), attempts=0 WHERE source_id=$1`, [sourceId]);
          await log(c, 'Resumed by owner from the stored checkpoint.');
          break;
        case 'reconnect':
          await c.query(`INSERT INTO worker_commands(source_id,command) VALUES ($1,'reconnect')`, [sourceId]);
          break;
        case 'simulate-failure':
          await c.query(`INSERT INTO worker_commands(source_id,command) VALUES ($1,'simulate_rpc_failure')`, [sourceId]);
          break;
        case 'reindex':
          await c.query(`UPDATE raw_logs SET canonical=false, orphaned_at=now() WHERE source_id=$1 AND canonical`, [sourceId]);
          await c.query(`DELETE FROM indexer_checkpoints WHERE source_id=$1`, [sourceId]);
          await c.query(`DELETE FROM block_headers WHERE source_id=$1`, [sourceId]);
          await c.query(
            `UPDATE indexer_sources SET status='pending', desired_state='running', last_error=NULL, reorg_epoch=reorg_epoch+1, generation=generation+1, updated_at=now() WHERE id=$1`,
            [sourceId],
          );
          await c.query(`UPDATE indexer_jobs SET next_run_at=now(), attempts=0 WHERE source_id=$1`, [sourceId]);
          await log(c, 'Reindex requested: previous records kept as non-canonical history; coverage restarts at the start block.', 'WARN');
          break;
        case 'delete':
          await c.query(`UPDATE indexer_sources SET desired_state='deleted', status='stopped', generation=generation+1, updated_at=now() WHERE id=$1`, [sourceId]);
          await log(c, 'Source removed from the workspace. Stored raw logs are kept for audit.');
          break;
      }
    });
    return { data: { id: sourceId, action } };
  };
  for (const action of ['pause', 'resume', 'reconnect', 'reindex', 'simulate-failure', 'delete'] as const) {
    app.post(`${P}/indexer/sources/:sourceId/${action}`, (request, reply) => lifecycle(request, reply, action));
  }

  // ================================================================ monitoring
  const RANGES: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

  app.get(`${P}/monitoring`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const q = request.query as Record<string, string>;
    const range = RANGES[q.range ?? '24h'];
    if (!range) return fail(reply, 'INVALID_QUERY', 'range must be 1h, 24h, 7d, or 30d.');
    const source = q.source ?? 'all';
    if (!['all', 'rpc', 'indexer', 'api', 'worker', 'transaction', 'network'].includes(source)) return fail(reply, 'INVALID_QUERY', 'Unknown log source.');
    const level = q.level ?? 'all';
    if (!['all', 'INFO', 'WARN', 'ERROR'].includes(level)) return fail(reply, 'INVALID_QUERY', 'Unknown level.');
    const before = q.before && /^[0-9]+$/.test(q.before) ? q.before : null;
    const cfg = resolveNetwork();
    const [probes, probeHistory, workers, sources, errors, logs] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (target) target,status,method,latency_ms,error,observed_at, now()-observed_at > interval '3 minutes' AS stale
           FROM rpc_probes WHERE network_id=$1 ORDER BY target, observed_at DESC`,
        [cfg.networkId],
      ),
      pool.query(
        `SELECT target,status,latency_ms,observed_at FROM rpc_probes WHERE network_id=$1 AND observed_at > now() - $2::interval ORDER BY observed_at DESC LIMIT 200`,
        [cfg.networkId, range],
      ),
      pool.query(`SELECT worker_id,started_at,last_seen_at,info, now()-last_seen_at < interval '30 seconds' AS healthy FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 5`),
      pool.query(
        `SELECT s.id,s.status,s.latest_observed_block::text,s.latest_observed_at,ck.block_number::text AS checkpoint_block,ck.committed_at,c.name AS contract_name
           FROM indexer_sources s JOIN contracts c ON c.id=s.contract_id LEFT JOIN indexer_checkpoints ck ON ck.source_id=s.id
          WHERE s.project_id=$1 AND s.desired_state <> 'deleted'`,
        [g.project.id],
      ),
      pool.query(
        `SELECT status, COALESCE(error_code,'HTTP_'||status) AS code, count(*)::int AS n, max(created_at) AS last, (array_agg(request_id ORDER BY created_at DESC))[1] AS last_request_id
           FROM request_logs WHERE project_id=$1 AND status >= 400 AND created_at > now() - $2::interval GROUP BY status, code ORDER BY n DESC`,
        [g.project.id, range],
      ),
      pool.query(
        `SELECT * FROM (
           SELECT id::text AS id, 'ops' AS kind, source, level, message, detail, indexer_source_id, transaction_id, request_id, created_at FROM ops_logs
            WHERE (project_id=$1 OR project_id IS NULL) AND created_at > now() - $2::interval
              AND ($3 = 'all' OR source = $3) AND ($4 = 'all' OR level = $4) AND ($5::bigint IS NULL OR id < $5::bigint)
         ) x ORDER BY created_at DESC, id DESC LIMIT 51`,
        [g.project.id, range, source === 'api' ? '__none__' : source, level, before],
      ),
    ]);
    // API request records are a separate source.
    const apiLogs =
      source === 'api' || source === 'all'
        ? (
            await pool.query(
              `SELECT id::text, method, route, status, error_code, latency_ms, request_id, auth_kind, created_at FROM request_logs
                WHERE project_id=$1 AND created_at > now() - $2::interval AND ($3::bigint IS NULL OR id < $3::bigint) AND ($4 = 'all' OR ($4='ERROR' AND status>=500) OR ($4='WARN' AND status BETWEEN 400 AND 499) OR ($4='INFO' AND status < 400))
                ORDER BY created_at DESC, id DESC LIMIT 51`,
              [g.project.id, range, source === 'api' ? before : null, level],
            )
          ).rows
        : [];
    // Lag samples from checkpoint commits recorded in the range.
    const lag = await pool.query(
      `SELECT o.created_at, o.indexer_source_id, (o.detail->>'toBlock') AS to_block, (o.detail->>'head') AS head
         FROM ops_logs o JOIN indexer_sources s ON s.id=o.indexer_source_id
        WHERE s.project_id=$1 AND o.message LIKE 'Checkpoint committed%' AND o.created_at > now() - $2::interval ORDER BY o.created_at DESC LIMIT 300`,
      [g.project.id, range],
    );
    return {
      data: {
        range: q.range ?? '24h',
        probes: probes.rows,
        probeHistory: probeHistory.rows,
        workers: workers.rows,
        indexer: sources.rows.map((s) => ({
          ...s,
          lagBlocks: s.checkpoint_block && s.latest_observed_block ? String(BigInt(s.latest_observed_block) > BigInt(s.checkpoint_block) ? BigInt(s.latest_observed_block) - BigInt(s.checkpoint_block) : 0n) : null,
        })),
        checkpointSamples: lag.rows,
        apiErrors: errors.rows,
        logs: logs.rows.slice(0, 50),
        nextBefore: logs.rows.length > 50 ? logs.rows[49].id : null,
        apiRequests: apiLogs.slice(0, 50),
        retention: 'Probes are kept 14 days; logs and request records 30 days.',
      },
    };
  });

  app.post(`${P}/monitoring/probe`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true, allowArchived: true });
    if (!g) return;
    const cfg = resolveNetwork();
    const [e, s] = await Promise.all([probeEvm(cfg, evm), connectSubstrate ? probeSubstrate(cfg) : Promise.resolve(null)]);
    const rows: Array<[string, typeof e | NonNullable<typeof s>]> = [['evm', e]];
    if (s) rows.push(['substrate', s]);
    for (const [target, p] of rows) {
      await pool.query(
        `INSERT INTO rpc_probes(network_id,target,method,status,latency_ms,result,error,observed_at) VALUES ($1,$2,'identity bundle (manual)',$3,$4,$5,$6,$7)`,
        [cfg.networkId, target, p.status, p.latencyMs, p.value ? JSON.stringify(toLosslessJson(p.value)) : null, p.error?.slice(0, 2000) ?? null, p.observedAt],
      );
    }
    return { data: rows.map(([target, p]) => ({ target, status: p.status, latencyMs: p.latencyMs, error: p.error, observedAt: p.observedAt })) };
  });

  // ================================================================ accounts
  app.post(`${P}/accounts/mapping`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true, allowArchived: true });
    if (!g) return;
    const address = String(body(request).address ?? '');
    if (!isAddress(address, { strict: false })) return fail(reply, 'INVALID_REQUEST', 'Enter a 20-byte EVM address.');
    const fp = await requireFingerprint(reply);
    if (!fp) return;
    const fresh = await pool.query(
      `SELECT m.* FROM account_mappings m JOIN network_fingerprints f ON f.id=m.fingerprint_id
        WHERE m.fingerprint_id=$1 AND lower(m.evm_address)=lower($2) AND m.invalidated_at IS NULL
          AND m.spec_version = f.spec_version AND m.resolved_at > now() - interval '10 minutes'
        ORDER BY m.resolved_at DESC LIMIT 1`,
      [fp.id, address],
    );
    if (fresh.rowCount && !body(request).refresh) return { data: { ...fresh.rows[0], cached: true } };
    if (!connectSubstrate) return fail(reply, 'SERVICE_UNAVAILABLE', 'Native adapter disabled.');
    let sub: SubstrateAdapter | null = null;
    try {
      sub = await connectSubstrate();
      const id = await sub.identity();
      if (id.genesisHash !== fp.genesis_hash) return fail(reply, 'NETWORK_IDENTITY_MISMATCH', 'The native endpoint reports a different genesis hash than the verified fingerprint.');
      const m = await sub.mapEvmAccount(address);
      const r = await pool.query(
        `INSERT INTO account_mappings(fingerprint_id,direction,evm_address,native_account_hex,native_ss58,method,block_number,block_hash,spec_version)
         VALUES ($1,'evm_to_native',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [fp.id, m.evmAddress.toLowerCase(), m.nativeAccountHex, m.nativeSs58, m.method, m.blockNumber, m.blockHash, m.specVersion],
      );
      return { data: { ...r.rows[0], cached: false } };
    } catch (e) {
      return fail(reply, 'SERVICE_UNAVAILABLE', `Mapping could not be resolved: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await sub?.disconnect().catch(() => {});
    }
  });

  // ================================================================ export
  app.get(`${P}/export`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply);
    if (!g) return;
    const [fp, contracts, sources, keys] = await Promise.all([
      pool.query(`SELECT genesis_hash,evm_chain_id::text,spec_name,spec_version::text,ss58_format,token_symbol,token_decimals,last_verified_at FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active'`),
      pool.query(
        `SELECT c.id,c.name,c.address,c.source,c.deploy_tx_hash,c.deploy_block::text,c.removed_at,
                (SELECT json_agg(json_build_object('version',a.version,'sha256',a.abi_sha256,'provenance',a.provenance,'createdAt',a.created_at,'abi',a.abi) ORDER BY a.version) FROM abi_versions a WHERE a.contract_id=c.id) AS abi_versions
           FROM contracts c WHERE c.project_id=$1 ORDER BY c.created_at`,
        [g.project.id],
      ),
      pool.query(
        `SELECT s.id,s.contract_address,s.event_names,s.start_block::text,s.end_block::text,s.desired_state,s.status,s.finality_policy,ck.block_number::text AS checkpoint_block,ck.block_hash AS checkpoint_hash
           FROM indexer_sources s LEFT JOIN indexer_checkpoints ck ON ck.source_id=s.id WHERE s.project_id=$1 ORDER BY s.created_at`,
        [g.project.id],
      ),
      pool.query(`SELECT id,name,prefix,scopes,created_at,expires_at,revoked_at,last_used_at FROM api_keys WHERE project_id=$1 ORDER BY created_at`, [g.project.id]),
    ]);
    const doc = {
      format: 'palletdock.project-export/v1',
      exportedAt: new Date().toISOString(),
      project: { id: g.project.id, name: g.project.name, description: g.project.description, archivedAt: g.project.archived_at, createdAt: g.project.created_at },
      network: { networkId: network.networkId, name: network.name, evmChainId: network.evmChainId, fingerprint: fp.rows[0] ?? null },
      contracts: contracts.rows,
      indexerSources: sources.rows,
      apiKeys: keys.rows.map((k) => ({ ...k, secret: undefined, note: 'Metadata only. Secrets are never exported.' })),
    };
    reply.header('content-disposition', `attachment; filename="palletdock-${g.project.id}.json"`);
    return doc;
  });

  // ================================================================ key replacement
  app.post(`${P}/keys/:keyId/replace`, async (request, reply) => {
    const g = await workspaceGuard(pool, request, reply, { mutate: true });
    if (!g) return;
    const keyId = param(request, 'keyId');
    if (!isUuid(keyId)) return fail(reply, 'NOT_FOUND', 'Key not found.');
    const out = await withTx(pool, async (c) => {
      const old = (await c.query(`SELECT * FROM api_keys WHERE id=$1 AND project_id=$2 AND revoked_at IS NULL FOR UPDATE`, [keyId, g.project.id])).rows[0];
      if (!old) return null;
      const prefix = `${API_KEY_PREFIX}${randomToken(9)}`;
      const secret = `${prefix}.${randomToken(32)}`;
      const days = Math.max(1, Math.round((new Date(old.expires_at).getTime() - new Date(old.created_at).getTime()) / 86_400_000));
      const k = await c.query(
        `INSERT INTO api_keys(project_id,name,prefix,secret_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,now()+($6::text||' days')::interval) RETURNING id,name,prefix,scopes,created_at,expires_at`,
        [g.project.id, old.name, prefix, sha256Hex(secret), old.scopes, days],
      );
      await c.query(`UPDATE api_keys SET revoked_at=now(), replaced_by=$2 WHERE id=$1`, [keyId, k.rows[0].id]);
      return { key: k.rows[0], secret };
    });
    if (!out) return fail(reply, 'NOT_FOUND', 'Active key not found.');
    return reply.code(201).send({ data: out.key, secret: out.secret, secretShownOnce: true, replaced: keyId });
  });
}
