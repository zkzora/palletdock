/**
 * The Portaldot network the web app targets. UI copy reads `label`; the wallet
 * and network-details panel use the exact `walletName` and parameters. Moving to
 * another Portaldot network (mainnet) changes this file together with the
 * server config in packages/shared/src/network.ts.
 */
export const NETWORK = {
  label: 'Portaldot V3',
  walletName: 'Portaldot V3 Testnet',
  environment: 'Testnet',
  chainId: 420420777,
  chainIdHex: '0x190f1ca9',
  rpcUrl: 'https://test-evm-rpc-v3.portaldot.dev',
  symbol: 'tPOT',
  /** Native genesis of the verified Portaldot V3 Testnet fingerprint; fixture chains differ. */
  genesisHash: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
} as const;
