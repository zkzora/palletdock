/**
 * Guided playground workflows for the bundled sample artifacts. One definition
 * per template, served by the API (GET /auth/playground-config and the project
 * playground route) so the web pages never duplicate it. Every value here was
 * checked against the artifact ABI and Solidity source in this package.
 *
 * Argument strings use the ABI form inputs' text format. `{signer}` is replaced
 * in the browser with the connected wallet account (never by the server).
 */
export type PlaygroundTemplateId = 'storage' | 'erc20' | 'erc721' | 'payments';

export interface PlaygroundCall {
  /** Exact ABI signature, e.g. store(uint256). */
  function: string;
  args: string[];
  explain: string;
}

export interface PlaygroundTemplate {
  id: PlaygroundTemplateId;
  /** Sample artifact id (see sampleArtifacts()). */
  sampleId: string;
  contractName: string;
  title: string;
  summary: string;
  outcome: string;
  constructorArgs: string[];
  constructorNotes: string[];
  read: PlaygroundCall;
  write: PlaygroundCall & {
    /** The function is payable and the visitor must type an explicit, non-zero amount. */
    explicitValue?: boolean;
    /** Arguments the visitor must fill in before review (indexes into args). */
    requiredInputs?: number[];
  };
  event: { name: string; signature: string; fields: string[]; explain: string };
  notes: string[];
}

export const PLAYGROUND_TEMPLATES: readonly PlaygroundTemplate[] = [
  {
    id: 'storage',
    sampleId: 'storage',
    contractName: 'PalletDockStorage',
    title: 'Storage',
    summary: 'Store and read one uint256. The smallest end-to-end journey.',
    outcome: 'Deploy, read retrieve(), write store(42), and follow NumberChanged(previousValue, newValue) from the receipt to the indexer and the project API.',
    constructorArgs: [],
    constructorNotes: ['No constructor arguments.'],
    read: { function: 'retrieve()', args: [], explain: 'retrieve() returns the stored number through eth_call. Nothing is broadcast. A new contract returns 0.' },
    write: { function: 'store(uint256)', args: ['42'], explain: 'store(42) sets the number and emits NumberChanged with the previous and new value.' },
    event: {
      name: 'NumberChanged',
      signature: 'NumberChanged(address,uint256,uint256)',
      fields: ['caller', 'previousValue', 'newValue'],
      explain: 'caller is the signing account (indexed topic); previousValue and newValue are decoded from the log data.',
    },
    notes: [],
  },
  {
    id: 'payments',
    sampleId: 'payments',
    contractName: 'PalletDockPayments',
    title: 'Payments',
    summary: 'Accept a tagged test-token payment with pay(orderRef).',
    outcome: 'Deploy, read totalReceived(), pay a sample order with an amount you choose, and follow PaymentReceived(payer, orderRef, amount) to the API.',
    constructorArgs: [],
    constructorNotes: ['No constructor arguments. The deploying account becomes the immutable owner.'],
    read: { function: 'totalReceived()', args: [], explain: 'totalReceived() is the sum of all payments ever received, in raw EVM base units.' },
    write: {
      function: 'pay(bytes32)',
      args: ['{orderRef}'],
      explicitValue: true,
      explain: 'pay(orderRef) is payable: the amount you enter is sent with the call and recorded in the event. A zero amount reverts with ZeroAmount().',
    },
    event: {
      name: 'PaymentReceived',
      signature: 'PaymentReceived(address,bytes32,uint256)',
      fields: ['payer', 'orderRef', 'amount'],
      explain: 'payer and orderRef are indexed topics; amount is the value sent, in raw EVM base units.',
    },
    notes: [
      'The order reference is a sample: the ASCII text "pd-sample-order-" plus part of this project id, zero-padded to 32 bytes.',
      'withdraw(to) sends the whole contract balance to an address and only the deploying account (owner) may call it. The playground never initiates it; you can call it yourself from the Write tab.',
    ],
  },
  {
    id: 'erc20',
    sampleId: 'erc20',
    contractName: 'PalletDockToken',
    title: 'ERC-20 token',
    summary: 'Fixed-supply PDTT token (OpenZeppelin 5.1.0) minted to the deployer.',
    outcome: 'Deploy with an initial supply, read totalSupply(), transfer tokens to a recipient you choose, and follow Transfer(from, to, value) to the API.',
    constructorArgs: ['1000000000000000000000'],
    constructorNotes: [
      'initialSupply is in the token’s smallest units. The token has 18 decimals, so 1000000000000000000000 = 1,000 PDTT.',
      'The whole supply is minted to the deploying account, which emits Transfer from the zero address in the deployment block.',
    ],
    read: { function: 'totalSupply()', args: [], explain: 'totalSupply() returns the fixed supply in smallest units (18 decimals).' },
    write: {
      function: 'transfer(address,uint256)',
      args: ['', '1000000000000000000'],
      requiredInputs: [0],
      explain: 'transfer(to, value) moves tokens from the signer. Enter a valid recipient address; 1000000000000000000 = 1 PDTT.',
    },
    event: {
      name: 'Transfer',
      signature: 'Transfer(address,address,uint256)',
      fields: ['from', 'to', 'value'],
      explain: 'from and to are indexed topics; value is in smallest units.',
    },
    notes: ['PDTT is a test token with no value. Token amounts are lossless decimal strings.'],
  },
  {
    id: 'erc721',
    sampleId: 'erc721',
    contractName: 'PalletDockCollectible',
    title: 'ERC-721 collectible',
    summary: 'Open-mint PDTC collectible (OpenZeppelin 5.1.0).',
    outcome: 'Deploy, read nextTokenId(), mint the next token to an address, and follow Transfer(from, to, tokenId) to the API.',
    constructorArgs: [],
    constructorNotes: ['No constructor arguments.'],
    read: { function: 'nextTokenId()', args: [], explain: 'nextTokenId() is the id the next mint will use. A new contract returns 0.' },
    write: {
      function: 'mint(address)',
      args: ['{signer}'],
      requiredInputs: [0],
      explain: 'mint(to) mints the next token id to `to`. This test contract lets any account mint to any address; it has no owner or allowlist.',
    },
    event: {
      name: 'Transfer',
      signature: 'Transfer(address,address,uint256)',
      fields: ['from', 'to', 'tokenId'],
      explain: 'A mint is a Transfer from the zero address. All three fields are indexed topics.',
    },
    notes: ['No base URI is set, so tokenURI(tokenId) returns an empty string for a minted token and reverts for one that does not exist. There is no burn function.'],
  },
];

export function playgroundTemplate(id: unknown): PlaygroundTemplate | null {
  return PLAYGROUND_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Sample order reference for the payments journey: ASCII "pd-sample-order-" + 8 hex chars of the project id, zero-padded to bytes32. */
export function sampleOrderRef(projectId: string): string {
  const text = `pd-sample-order-${projectId.replace(/-/g, '').slice(0, 8)}`;
  const hex = Buffer.from(text, 'ascii').toString('hex');
  return `0x${hex.padEnd(64, '0')}`;
}

/** Template with project-specific placeholders resolved (everything except {signer}). */
export function resolvedTemplate(t: PlaygroundTemplate, projectId: string): PlaygroundTemplate {
  const sub = (a: string) => (a === '{orderRef}' ? sampleOrderRef(projectId) : a);
  return { ...t, write: { ...t.write, args: t.write.args.map(sub) } };
}
