/**
 * Allowlisted network configuration. RPC targets are never taken from user
 * input; only the entries below (optionally overridden by deployment env) are
 * contacted. Portaldot is not the Polkadot network.
 */
export interface PortaldotNetworkConfig {
  networkId: string;
  name: string;
  environment: 'testnet';
  evmRpcUrl: string;
  substrateRpcUrl: string;
  evmChainId: number;
  evmChainIdHex: string;
  nativeTokenSymbol: string;
  /** Native (Substrate) token decimals. Do NOT apply to EVM RPC quantities. */
  nativeTokenDecimals: number;
  ss58Format: number;
  nodeConsoleUrl: string;
  developerGuideUrl: string;
}

export const PORTALDOT_V3_TESTNET: PortaldotNetworkConfig = {
  networkId: 'portaldot-v3-testnet',
  name: 'Portaldot V3 Testnet',
  environment: 'testnet',
  evmRpcUrl: 'https://test-evm-rpc-v3.portaldot.dev',
  substrateRpcUrl: 'wss://test-node-v3.portaldot.dev',
  evmChainId: 420420777,
  evmChainIdHex: '0x190f1ca9',
  /** Live runtime system_properties (2026-10-17); earlier guide versions said tPOTv3. Accepted by the owner. */
  nativeTokenSymbol: 'tPOT',
  nativeTokenDecimals: 14,
  ss58Format: 42,
  nodeConsoleUrl: 'https://node-console.portaldot.dev/',
  developerGuideUrl: 'https://github.com/ItsCogumellum/portaldot-v3-testnet-guide',
};

/**
 * Hosts an operator may point the allowlisted network at. Portaldot moved its
 * V3 endpoints to portaldot.dev in October 2026; the feso-apps.xyz hosts are retired.
 */
const ALLOWED_RPC_HOST_SUFFIXES = ['portaldot.dev'];

export function isAllowedRpcUrl(url: string, opts: { allowLoopback?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (opts.allowLoopback && (host === '127.0.0.1' || host === 'localhost')) return true;
  if (u.protocol === 'http:' || u.protocol === 'ws:') return false;
  return ALLOWED_RPC_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

/**
 * Resolve the active network from env. Overrides are restricted to the RPC
 * host allowlist (loopback only when explicitly enabled for tests).
 */
export function resolveNetwork(env: Record<string, string | undefined> = process.env): PortaldotNetworkConfig {
  const allowLoopback = env.PALLETDOCK_ALLOW_LOOPBACK_RPC === '1' && env.NODE_ENV !== 'production';
  const cfg = { ...PORTALDOT_V3_TESTNET };
  if (env.PORTALDOT_EVM_RPC_URL) {
    if (!isAllowedRpcUrl(env.PORTALDOT_EVM_RPC_URL, { allowLoopback })) {
      throw new Error('PORTALDOT_EVM_RPC_URL is not an allowlisted RPC target');
    }
    cfg.evmRpcUrl = env.PORTALDOT_EVM_RPC_URL;
  }
  if (env.PORTALDOT_SUBSTRATE_RPC_URL) {
    if (!isAllowedRpcUrl(env.PORTALDOT_SUBSTRATE_RPC_URL, { allowLoopback })) {
      throw new Error('PORTALDOT_SUBSTRATE_RPC_URL is not an allowlisted RPC target');
    }
    cfg.substrateRpcUrl = env.PORTALDOT_SUBSTRATE_RPC_URL;
  }
  return cfg;
}
