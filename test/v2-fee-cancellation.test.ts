import { describe, it, expect } from 'vitest';
import {
  Contract,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  randomUtxo,
  type Artifact,
} from 'cashscript';
import { hash160, secp256k1, hexToBin } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCircleV2Fee.json' with { type: 'json' };
import { pkhToAddress } from '../src/lib/ajo.js';

const artifact = artifactJson as unknown as Artifact;
const CATEGORY = 'ab'.repeat(32);
const CONTRIBUTION = 100_000n;
const MAX_FEE = 10_000n;
const DUST = 1_000n;

function key(n: number) {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}
const members = [key(1), key(2)];
const initiator = key(3);
const outsider = key(4);
const treasury = key(5);

function makeContract(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE, hexToBin(CATEGORY).reverse(),
    initiator.pkh, treasury.pkh,
  ], { provider, contractType: 'p2sh32' });
}

function receiptCommitment(index: number, credit: bigint) {
  const littleEndian = credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
  return '52' + index.toString(16).padStart(2, '0') + littleEndian;
}

function addCircle(
  provider: MockNetworkProvider,
  contract: Contract,
  stateCommitment: string,
  stateValue: bigint,
  credits: bigint[],
) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: stateValue,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: stateCommitment } },
  }));
  credits.forEach((credit, index) => provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, credit) } },
  })));
}

function addInitiatorFeeInput(provider: MockNetworkProvider) {
  const address = pkhToAddress(initiator.pkh, 'chipnet');
  const utxo = provider.addUtxo(address, randomUtxo({ satoshis: 10_000n }));
  return { address, utxo };
}

describe('AjoCircleV2Fee covenant', () => {
  it('enforces a 1% treasury output and permanently sets hasPaid on payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addCircle(provider, contract, '540000', 2n * CONTRIBUTION + DUST, [CONTRIBUTION, CONTRIBUTION]);

    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment.startsWith('52' + i.toString(16).padStart(2, '0')))!);
    const makePayout = (feeAddress: string, feeAmount: bigint, recipientAmount: bigint) =>
      new TransactionBuilder({ provider })
        .addInput(state, contract.unlock.payout())
        .addInputs(receipts, contract.unlock.payout())
        .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '540101' } } })
        .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(0, 0n) } } })
        .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(1, 0n) } } })
        .addOutput({ to: feeAddress, amount: feeAmount })
        .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: recipientAmount });

    await expect(makePayout(pkhToAddress(members[1].pkh, 'chipnet'), 2_000n, 192_000n).send()).rejects.toThrow();
    await expect(makePayout(pkhToAddress(treasury.pkh, 'chipnet'), 1_999n, 192_001n).send()).rejects.toThrow();
    await expect(makePayout(pkhToAddress(treasury.pkh, 'chipnet'), 2_000n, 192_000n).send()).resolves.toBeTruthy();
    const next = await contract.getUtxos();
    expect(next.some(u => u.token?.nft?.commitment === '540101')).toBe(true);
  });

  it('allows only the committed initiator to cancel before the first payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addCircle(provider, contract, '540000', 76_000n, [50_000n, 25_000n]);
    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment.startsWith('52' + i.toString(16).padStart(2, '0')))!);
    const { address, utxo } = addInitiatorFeeInput(provider);
    const unlocker = contract.unlock.cancel(initiator.pub, initiator.sig);
    const tx = new TransactionBuilder({ provider })
      .addInput(state, unlocker)
      .addInputs(receipts, unlocker)
      .addInput(utxo, initiator.sig.unlockP2PKH())
      .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: 51_000n })
      .addOutput({ to: pkhToAddress(members[1].pkh, 'chipnet'), amount: 26_000n })
      .addOutput({ to: address, amount: 4_000n });
    await expect(tx.send()).resolves.toBeTruthy();
  });

  it('rejects a cancellation receipt with a missing member-index byte', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '540000' } },
    }));
    // Malformed: prefix + 8-byte credit, with the one-byte member index omitted.
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: '52' + '00'.repeat(8) } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(1, 0n) } },
    }));
    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment.startsWith('52' + (i === 0 ? '00' : '01')))!);
    const { address, utxo } = addInitiatorFeeInput(provider);
    const unlocker = contract.unlock.cancel(initiator.pub, initiator.sig);
    const tx = new TransactionBuilder({ provider })
      .addInput(state, unlocker)
      .addInputs(receipts, unlocker)
      .addInput(utxo, initiator.sig.unlockP2PKH())
      .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: pkhToAddress(members[1].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: address, amount: 4_000n });
    await expect(tx.send()).rejects.toThrow();
  });

  it('rejects cancellation signed by a non-initiator', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addCircle(provider, contract, '540000', DUST, [0n, 0n]);
    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment.startsWith('52' + i.toString(16).padStart(2, '0')))!);
    const { address, utxo } = addInitiatorFeeInput(provider);
    const unlocker = contract.unlock.cancel(outsider.pub, outsider.sig);
    const tx = new TransactionBuilder({ provider })
      .addInput(state, unlocker)
      .addInputs(receipts, unlocker)
      .addInput(utxo, initiator.sig.unlockP2PKH())
      .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: pkhToAddress(members[1].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: address, amount: 4_000n });
    await expect(tx.send()).rejects.toThrow();
  });

  it('permanently rejects cancellation after the first payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addCircle(provider, contract, '540101', DUST, [0n, 0n]);
    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment.startsWith('52' + i.toString(16).padStart(2, '0')))!);
    const { address, utxo } = addInitiatorFeeInput(provider);
    const unlocker = contract.unlock.cancel(initiator.pub, initiator.sig);
    const tx = new TransactionBuilder({ provider })
      .addInput(state, unlocker)
      .addInputs(receipts, unlocker)
      .addInput(utxo, initiator.sig.unlockP2PKH())
      .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: pkhToAddress(members[1].pkh, 'chipnet'), amount: DUST })
      .addOutput({ to: address, amount: 4_000n });
    await expect(tx.send()).rejects.toThrow();
  });
});
