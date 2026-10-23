import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  randomUtxo,
  type Contract,
} from 'cashscript';
import { secp256k1, hash160, binToHex, encodeCashAddress } from '@bitauth/libauth';
const tokenAddr = (pkh: Uint8Array) => (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }) as any).address as string;
import {
  circleContract,
  circleStatus,
  buildPayout,
  encodeRound,
  pkhToAddress,
  encodeCircle,
  decodeCircle,
  STATE_DUST,
  type CircleParams,
} from '../src/lib/ajo.js';

// Throwaway deterministic test keys (never used on any real network).
const keys = [1, 2, 3, 4, 5].map((i) => {
  const priv = new Uint8Array(32);
  priv[31] = i;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
});
const outsider = (() => {
  const priv = new Uint8Array(32);
  priv[31] = 99;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
})();

const CATEGORY = 'aa'.repeat(31) + 'bb';
const C = 100_000n;

function params(n = 5): CircleParams {
  return {
    name: 'Test circle',
    network: 'chipnet',
    members: keys.slice(0, n).map((k) => pkhToAddress(k.pkh, 'chipnet')),
    contribution: C,
    maxFee: 10_000n,
    stateCategory: CATEGORY,
  };
}

function stateUtxo(round: number, category = CATEGORY, capability: 'mutable' | 'none' = 'mutable') {
  return randomUtxo({
    satoshis: STATE_DUST,
    token: { category, amount: 0n, nft: { capability, commitment: encodeRound(round) } },
  });
}

let provider: MockNetworkProvider;
let p: CircleParams;
let contract: Contract;

async function contribute(times: number, amount = C) {
  for (let i = 0; i < times; i++) provider.addUtxo(contract.address, randomUtxo({ satoshis: amount }));
}
const utxos = () => contract.getUtxos();

beforeEach(() => {
  provider = new MockNetworkProvider();
  p = params(5);
  contract = circleContract(p, provider);
  provider.addUtxo(contract.address, stateUtxo(0));
});

describe('AjoCircle covenant: happy path', () => {
  it('compiles to a p2sh32 contract', () => {
    expect(contract.address.length).toBeGreaterThan(50);
    expect(contract.bytesize).toBeLessThan(1000);
  });

  it('reports status: round 0, recipient member 0, pot not ready', async () => {
    await contribute(3);
    const s = circleStatus(p, await utxos());
    expect(s.round).toBe(0);
    expect(s.recipient).toBe(p.members[0]);
    expect(s.available).toBe(3n * C);
    expect(s.ready).toBe(false);
  });

  it('refuses payout before the pot is full', async () => {
    await contribute(4);
    expect(() => buildPayout(p, contract, [] as any, provider)).toThrow();
    const s = circleStatus(p, await utxos());
    expect(s.ready).toBe(false);
  });

  it('runs a full 5-round circle, paying each member in order', async () => {
    for (let round = 0; round < 5; round++) {
      await contribute(5);
      const { builder, recipient, amount, fee } = buildPayout(p, contract, await utxos(), provider);
      expect(recipient).toBe(p.members[round]);
      expect(fee).toBeLessThanOrEqual(p.maxFee);
      await builder.send();
      const paid = await provider.getUtxos(p.members[round]);
      expect(paid.reduce((s, u) => s + u.satoshis, 0n)).toBe(amount);
      const s = circleStatus(p, await utxos());
      expect(s.round).toBe(round + 1);
    }
    const s = circleStatus(p, await utxos());
    expect(s.completed).toBe(true);
    expect(() => buildPayout(p, contract, s.stateUtxo ? [s.stateUtxo] : [], provider)).toThrow(/completed/);
  });

  it('works for a 2-member circle', async () => {
    provider = new MockNetworkProvider();
    p = params(2);
    contract = circleContract(p, provider);
    provider.addUtxo(contract.address, stateUtxo(0));
    await contribute(2);
    await buildPayout(p, contract, await utxos(), provider).builder.send();
    await contribute(2);
    const r = buildPayout(p, contract, await utxos(), provider);
    expect(r.recipient).toBe(p.members[1]);
    await r.builder.send();
    expect(circleStatus(p, await utxos()).completed).toBe(true);
  });

  it('returns surplus (early contributions) to the circle', async () => {
    await contribute(7);
    const r = buildPayout(p, contract, await utxos(), provider);
    await r.builder.send();
    const s = circleStatus(p, await utxos());
    expect(s.round).toBe(1);
    expect(s.available).toBe(2n * C);
  });

  it('returns the surplus of an oversized contribution to the circle (3rd output)', async () => {
    await contribute(1, 300_000n);
    await contribute(1, 300_000n);
    const r = buildPayout(p, contract, await utxos(), provider);
    await r.builder.send();
    const s = circleStatus(p, await utxos());
    expect(s.round).toBe(1);
    expect(s.available).toBe(100_000n);
  });

  it('accepts contributions of uneven sizes as long as the pot is full', async () => {
    await contribute(1, 250_000n);
    await contribute(1, 250_000n);
    const r = buildPayout(p, contract, await utxos(), provider);
    await r.builder.send();
    expect(circleStatus(p, await utxos()).round).toBe(1);
  });
});

describe('AjoCircle covenant: attacks are rejected', () => {
  async function base() {
    await contribute(5);
    const all = await utxos();
    const s = circleStatus(p, all);
    return { all, s };
  }

  it('rejects paying the wrong member (out of turn)', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } })
      .addOutput({ to: p.members[3], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/pot must go to this round\'s member/);
  });

  it('rejects paying an outsider', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } })
      .addOutput({ to: pkhToAddress(outsider.pkh, 'chipnet'), amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/pot must go to this round\'s member/);
  });

  it('rejects skipping a round (commitment not incremented by exactly one)', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '00' } } })
      .addOutput({ to: p.members[0], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/round must increment by one/);
  });

  it('rejects underpaying the recipient (fee above maxFee)', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } })
      .addOutput({ to: p.members[0], amount: 5n * C - 50_000n });
    await expect(tx.send()).rejects.toThrow(/recipient underpaid/);
  });

  it('rejects skimming an extra output', async () => {
    await contribute(6);
    const s = circleStatus(p, await utxos());
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } })
      .addOutput({ to: p.members[0], amount: 5n * C - 6000n })
      .addOutput({ to: pkhToAddress(outsider.pkh, 'chipnet'), amount: C });
    await expect(tx.send()).rejects.toThrow(/surplus must return to circle|no extra outputs/);
  });

  it('rejects stealing the state NFT out of the circle', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: tokenAddr(outsider.pkh), amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } } as any)
      .addOutput({ to: p.members[0], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/state must stay in circle/);
  });

  it('rejects spending contributions without the state UTXO', async () => {
    const { s } = await base();
    const tx = new TransactionBuilder({ provider })
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: pkhToAddress(outsider.pkh, 'chipnet'), amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/state NFT must be mutable, right category|input 0 must hold the state NFT/);
  });

  it('rejects a fake state NFT of a different category', async () => {
    const fakeCat = 'cc'.repeat(32);
    provider.addUtxo(contract.address, stateUtxo(3, fakeCat));
    await contribute(5);
    const all = await utxos();
    const fake = all.find((u) => u.token?.category === fakeCat)!;
    const contribs = all.filter((u) => !u.token);
    const tx = new TransactionBuilder({ provider })
      .addInput(fake, contract.unlock.payout())
      .addInputs(contribs, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: fakeCat, amount: 0n, nft: { capability: 'mutable', commitment: '04' } } })
      .addOutput({ to: p.members[3], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/state NFT must be mutable, right category/);
  });

  it('rejects an immutable (capability none) NFT as state', async () => {
    provider = new MockNetworkProvider();
    contract = circleContract(p, provider);
    provider.addUtxo(contract.address, stateUtxo(0, CATEGORY, 'none'));
    await contribute(5);
    const all = await utxos();
    const st = all.find((u) => u.token)!;
    const tx = new TransactionBuilder({ provider })
      .addInput(st, contract.unlock.payout())
      .addInputs(all.filter((u) => !u.token), contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: '01' } } })
      .addOutput({ to: p.members[0], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/state NFT must be mutable, right category/);
  });

  it('rejects mixing in a foreign (non-circle) input to inflate the pot', async () => {
    await contribute(4);
    const s = circleStatus(p, await utxos());
    const foreign = provider.addUtxo(pkhToAddress(outsider.pkh, 'chipnet'), randomUtxo({ satoshis: C }));
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, contract.unlock.payout())
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addInput(foreign, outsider.sig.unlockP2PKH())
      .addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '01' } } })
      .addOutput({ to: p.members[0], amount: 5n * C - 6000n });
    await expect(tx.send()).rejects.toThrow(/all inputs must be circle UTXOs/);
  });
});

describe('AjoCircle covenant: cancel (all members sign)', () => {
  it('lets all members jointly unwind the circle', async () => {
    await contribute(3);
    const all = await utxos();
    const s = circleStatus(p, all);
    const sigArgs = keys.flatMap((k) => [k.pub, k.sig]);
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, (contract.unlock as any).cancel(...sigArgs))
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      // Refund each contributor + burn nothing: state NFT goes to member 0 for safekeeping.
      .addOutput({ to: tokenAddr(keys[0].pkh), amount: STATE_DUST, token: s.stateUtxo!.token } as any)
      .addOutput({ to: p.members[0], amount: C - 6000n })
      .addOutput({ to: p.members[1], amount: C })
      .addOutput({ to: p.members[2], amount: C });
    await expect(tx.send()).resolves.toBeTruthy();
  });

  it('rejects cancel when one member signature is missing/wrong', async () => {
    await contribute(1);
    const all = await utxos();
    const s = circleStatus(p, all);
    const signers = [...keys];
    signers[4] = outsider;
    const sigArgs = signers.flatMap((k) => [k.pub, k.sig]);
    const tx = new TransactionBuilder({ provider })
      .addInput(s.stateUtxo!, (contract.unlock as any).cancel(...sigArgs))
      .addInputs(s.contributionUtxos, contract.unlock.payout())
      .addOutput({ to: pkhToAddress(outsider.pkh, 'chipnet'), amount: C - 6000n });
    await expect(tx.send()).rejects.toThrow(/Require statement failed/);
  });
});

describe('helpers', () => {
  it('round-trips circle share links', () => {
    const d = decodeCircle(encodeCircle(p));
    expect(d).toEqual(p);
  });
  it('rejects bad parameters', () => {
    expect(() => circleContract({ ...p, members: p.members.slice(0, 1) }, provider)).toThrow();
    expect(() => circleContract({ ...p, members: ['bchtest:notanaddress'] }, provider)).toThrow();
    expect(() => circleContract({ ...p, stateCategory: 'xyz' }, provider)).toThrow();
  });
  it('different categories yield different circle addresses', () => {
    const other = circleContract({ ...p, stateCategory: 'dd'.repeat(32) }, provider);
    expect(other.address).not.toBe(contract.address);
    expect(binToHex(keys[0].pkh)).toHaveLength(40);
  });
});
