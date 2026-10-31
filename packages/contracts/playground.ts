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
  /**
   * Differences when the visitor uses the operator's shared, already deployed contract
   * instead of deploying a copy (see sharedVariant()). Omitted fields stay the same.
   */
  shared: {
    write?: PlaygroundTemplate['write'];
    event?: PlaygroundTemplate['event'];
    read?: PlaygroundCall;
    notes: string[];
  };
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
    shared: {
      read: { function: 'retrieve()', args: [], explain: 'retrieve() returns the stored number through eth_call. Nothing is broadcast. The contract is shared, so it may already hold another visitor’s number.' },
      notes: ['Every visitor writes to the same shared contract, so previousValue in your event may come from someone else.'],
    },
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
    shared: {
      read: { function: 'totalReceived()', args: [], explain: 'totalReceived() is the sum of all payments the shared contract ever received, from every visitor, in raw EVM base units.' },
      notes: ['On the shared contract the owner is the PalletDock operator: a payment you send stays in that contract and only the operator can withdraw it. Send a small amount.'],
    },
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
    shared: {
      write: {
        function: 'approve(address,uint256)',
        args: ['{signer}', '1000000000000000000'],
        requiredInputs: [0],
        explain: 'approve(spender, value) records an allowance and moves no tokens, so it works without holding PDTT. The spender is prefilled with your own address; 1000000000000000000 = 1 PDTT.',
      },
      event: {
        name: 'Approval',
        signature: 'Approval(address,address,uint256)',
        fields: ['owner', 'spender', 'value'],
        explain: 'owner and spender are indexed topics; value is the allowance in smallest units.',
      },
      notes: ['The whole supply of the shared token belongs to the PalletDock operator, so you hold no PDTT and the guided write is approve instead of transfer. Deploy your own copy to transfer tokens.'],
    },
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
    shared: {
      read: { function: 'nextTokenId()', args: [], explain: 'nextTokenId() is the id the next mint will use. Every visitor mints on the shared contract, so it counts their tokens too.' },
      notes: ['Minting stores a new token, so it needs a small storage deposit on top of the fee.'],
    },
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

/** The template as it applies to the operator's shared contract: the shared overrides plus their notes. */
export function sharedVariant(t: PlaygroundTemplate): PlaygroundTemplate {
  const s = t.shared;
  return { ...t, read: s.read ?? t.read, write: s.write ?? t.write, event: s.event ?? t.event, notes: [...t.notes, ...s.notes] };
}

/**
 * True when on-chain runtime code is the artifact's deployed bytecode. Immutable values are
 * written into the code at deployment (for example PalletDockPayments' owner), so a byte may
 * differ only inside a run of at least 32 zero bytes in the artifact, which is where solc
 * leaves an immutable's placeholder. Anything else is a different contract.
 */
export function codeMatchesArtifact(onchain: string, deployedBytecode: string): { match: boolean; immutablesFilled: boolean } {
  const a = onchain.toLowerCase().replace(/^0x/, '');
  const b = deployedBytecode.toLowerCase().replace(/^0x/, '');
  if (!a || a.length !== b.length) return { match: false, immutablesFilled: false };
  if (a === b) return { match: true, immutablesFilled: false };
  const bytes = b.length / 2;
  const byte = (s: string, i: number) => s.slice(i * 2, i * 2 + 2);
  const inZeroRun = new Uint8Array(bytes);
  for (let i = 0; i < bytes; ) {
    if (byte(b, i) !== '00') {
      i++;
      continue;
    }
    let j = i;
    while (j < bytes && byte(b, j) === '00') j++;
    if (j - i >= 32) inZeroRun.fill(1, i, j);
    i = j;
  }
  for (let i = 0; i < bytes; i++) if (byte(a, i) !== byte(b, i) && !inZeroRun[i]) return { match: false, immutablesFilled: false };
  return { match: true, immutablesFilled: true };
}

/** Template with project-specific placeholders resolved (everything except {signer}). */
export function resolvedTemplate(t: PlaygroundTemplate, projectId: string): PlaygroundTemplate {
  const sub = (a: string) => (a === '{orderRef}' ? sampleOrderRef(projectId) : a);
  return { ...t, write: { ...t.write, args: t.write.args.map(sub) } };
}
