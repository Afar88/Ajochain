import { describe, it, expect } from 'vitest';
import { MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo, type Utxo } from 'cashscript';
import { secp256k1, hash160 } from '@bitauth/libauth';
import { circleContract, decodeCircle, encodeRound, pkhToAddress, STATE_DUST, type CircleParams } from '../src/lib/ajo.js';
import { verifyClassicCircle } from '../src/lib/recovery.js';

// ---- Real "Our Ajo" Chipnet data, read from Fulcrum (chipnet.imaginary.cash and chipnet.bch.ninja) on 2026-11-10 ----
const OUR_AJO_INVITE = 'eyJuIjoiT3VyIEFqbyIsIm5ldCI6ImNoaXBuZXQiLCJtIjpbImJjaHRlc3Q6cXFocDI1eXFmOWEwZTg4eXljd3dkM2MwZWVjbGMzejVqYzhxdnZxdGpzIiwiYmNodGVzdDpxcTg5NHJseW1oa3V1bGNrcms0Nmh5NzQ1dHl1eWptdHBnZGFlYzZwMzgiLCJiY2h0ZXN0OnFwcjJjanp3bXUzdmVmOXJqdHpkbmRlanB2MHJ4c3Z6cnF1ankwd3N0MiJdLCJjIjoiMTAwMDAwIiwiZiI6IjEwMDAwIiwiayI6ImU1NzVmY2YwNmIzMTliYTU3NDk5Njc4MTQzMTVhMjRmYzFlMjJkODYwMWIyMzFlNWIzYmYyYTUzOTk5OWY3MzIifQ';
const OUR_AJO_CATEGORY = 'e575fcf06b319ba5749967814315a24fc1e22d8601b231e5b3bf2a539999f732';
const OUR_AJO_COVENANT = 'bchtest:pvhnq9rw2lzqzmsh3xld2ldq8nj4fej6uwmck6t0entjwwp9qyyswq0vev256';
const OUR_AJO_STATE: Utxo = {
  txid: 'b3aa279efd6db1ba88c7d6c30de1cf80824dcce8c59e481b6588df9b80b122c7', vout: 0, satoshis: 1000n,
  token: { category: OUR_AJO_CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: '00' } },
};

const keys = [1, 2, 3, 99].map((i) => {
  const priv = new Uint8Array(32); priv[31] = i;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
});
const [k0, k1, k2, outsider] = keys;
const CAT = 'cc'.repeat(32);
const testParams = (): CircleParams => ({ name: 't', network: 'chipnet', members: [k0, k1, k2].map((k) => pkhToAddress(k.pkh, 'chipnet')), contribution: 100_000n, maxFee: 10_000n, stateCategory: CAT });
const state = (round = 0, category = CAT, capability: 'mutable' | 'none' = 'mutable', sats = STATE_DUST) =>
  randomUtxo({ satoshis: sats, token: { category, amount: 0n, nft: { capability, commitment: encodeRound(round) } } });

describe('Our Ajo (original Classic circle)', () => {
  const p = decodeCircle(OUR_AJO_INVITE);
  it('invite link decodes to the original circle parameters', () => {
    expect(p.name).toBe('Our Ajo');
    expect(p.network).toBe('chipnet');
    expect(p.members).toHaveLength(3);
    expect(p.contribution).toBe(100_000n);
    expect(p.maxFee).toBe(10_000n);
    expect(p.stateCategory).toBe(OUR_AJO_CATEGORY);
  });
  it('derives the covenant address that holds the state NFT on Chipnet', () => {
    expect(circleContract(p, new MockNetworkProvider()).address).toBe(OUR_AJO_COVENANT);
  });
  it('verifies the live state: round 0, no contributions, payout not yet possible', () => {
    const r = verifyClassicCircle(p, [OUR_AJO_STATE]);
    expect(r.stateVerified).toBe(true);
    expect(r.round).toBe(0);
    expect(r.contributionBalance).toBe(0n);
    expect(r.payoutPossible).toBe(false);
    expect(r.shortfall).toBe(300_000n);
    expect(r.cancelSigners).toEqual(p.members);
    expect(r.issues).toEqual([]);
  });
});

describe('verifyClassicCircle edge cases', () => {
  const p = testParams();
  it('reports a missing state UTXO', () => {
    const r = verifyClassicCircle(p, [randomUtxo({ satoshis: 100_000n })]);
    expect(r.stateVerified).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('missing_state');
    expect(r.payoutPossible).toBe(false);
  });
  it('rejects an NFT of the wrong category as state', () => {
    const r = verifyClassicCircle(p, [state(0, 'dd'.repeat(32))]);
    expect(r.stateVerified).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['wrong_category', 'missing_state']));
  });
  it('rejects an immutable NFT of the right category', () => {
    const r = verifyClassicCircle(p, [state(0, CAT, 'none')]);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['immutable_state', 'missing_state']));
  });
  it('flags duplicate state NFTs', () => {
    expect(verifyClassicCircle(p, [state(0), state(1)]).issues.map((i) => i.code)).toContain('duplicate_state');
  });
  it('flags invalid balances and does not count them', () => {
    const bad = { ...randomUtxo({ satoshis: 1n }), satoshis: -5n } as Utxo;
    const r = verifyClassicCircle(p, [state(0), bad, randomUtxo({ satoshis: 300_000n })]);
    expect(r.issues.map((i) => i.code)).toContain('invalid_balance');
    expect(r.contributionBalance).toBe(300_000n);
    expect(r.stateVerified).toBe(false);
    expect(r.payoutPossible).toBe(false);
  });
  it('flags a completed circle', () => {
    const r = verifyClassicCircle(p, [state(3)]);
    expect(r.issues.map((i) => i.code)).toContain('completed');
    expect(r.payoutPossible).toBe(false);
  });
  it('reports payout possible once the pot is full', () => {
    const r = verifyClassicCircle(p, [state(1), randomUtxo({ satoshis: 300_000n })]);
    expect(r.payoutPossible).toBe(true);
    expect(r.shortfall).toBe(0n);
  });
});

describe('Classic cancel() authorization', () => {
  const build = async (signers: typeof keys) => {
    const provider = new MockNetworkProvider();
    const p = testParams();
    const c = circleContract(p, provider);
    provider.addUtxo(c.address, state(0, CAT, 'mutable', 10_000n));
    const [s] = await c.getUtxos();
    const [a, b, d] = signers;
    const tb = new TransactionBuilder({ provider })
      .addInput(s, c.unlock.cancel(a.pub, a.sig, b.pub, b.sig, d.pub, d.sig, k0.pub, k0.sig, k0.pub, k0.sig))
      .addOutput({ to: pkhToAddress(k0.pkh, 'chipnet'), amount: 5_000n });
    // Evaluate the unlocking script in the BCH VM, then return the raw transaction.
    await tb.debug();
    return tb.build();
  };
  it('accepts cancel signed by all three members', async () => {
    await expect(build([k0, k1, k2])).resolves.toBeTypeOf('string');
  });
  it('rejects cancel when an outsider replaces a member', async () => {
    await expect(build([k0, k1, outsider])).rejects.toThrow(/Failing statement|require|checkSig|hash160/i);
  });
  it('rejects cancel when members sign in the wrong slots', async () => {
    await expect(build([k1, k0, k2])).rejects.toThrow(/Failing statement|require|checkSig|hash160/i);
  });
});
