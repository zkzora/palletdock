import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SampleArtifact {
  id: string;
  title: string;
  description: string;
  artifact: Record<string, any>;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const load = (name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));

/** Bundled, reproducibly compiled sample artifacts (see scripts/build.mjs). */
export function sampleArtifacts(): SampleArtifact[] {
  return [
    { id: 'storage', title: 'PalletDockStorage', description: 'store/retrieve a uint256 and emit NumberChanged. No constructor arguments.', artifact: load('PalletDockStorage') },
    { id: 'erc20', title: 'PalletDockToken (ERC-20)', description: 'Fixed-supply ERC-20 built on OpenZeppelin 5.1.0. Constructor mints initialSupply to the deployer.', artifact: load('PalletDockToken') },
    { id: 'erc721', title: 'PalletDockCollectible (ERC-721)', description: 'Open-mint ERC-721 test fixture built on OpenZeppelin 5.1.0.', artifact: load('PalletDockCollectible') },
    { id: 'payments', title: 'PalletDockPayments', description: 'Accepts tPOT payments with pay(orderRef), emits PaymentReceived(payer, orderRef, amount), and lets the deployer withdraw. No constructor arguments.', artifact: load('PalletDockPayments') },
  ];
}
