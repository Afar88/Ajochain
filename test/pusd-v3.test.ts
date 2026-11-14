import { describe, expect, it } from 'vitest';
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, type Artifact } from 'cashscript';
import { hexToBin, encodeCashAddress } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCirclePUSDV3.json' with { type: 'json' };

const artifact = artifactJson as unknown as Artifact;
const STATE = 'ef'.repeat(32);
const PUSD = 'de'.repeat(32);
const C = 100_000n;
const MAX_FEE = 10_000n;
const RETENTION_BPS = 2_000n;
const members = [new Uint8Array(20).fill(1), new Uint8Array(20).fill(2)];

function contractFor(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0], members[1], new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, C, MAX_FEE, RETENTION_BPS,
    hexToBin(STATE).reverse(), hexToBin(PUSD).reverse(),
  ], { provider, contractType: 'p2sh32' });
}
function le(value: bigint) {
  return value.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}
function receipt(index: number, credit: bigint) {
  return '52' + index.toString(16).padStart(2, '0') + le(credit);
}

describe('AjoCirclePUSDV3 ACR covenant', () => {
  it('retains 20% PUSD in the pool and credits it to the winning member', async () => {
    const provider = new MockNetworkProvider();
    const contract = contractFor(provider);
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530001' } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(0, 150_000n) } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(1, 100_000n) } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 3_000n,
      token: { category: PUSD, amount: 250_000n },
    }));
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 20_000n }));

    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.category === STATE && u.token.nft?.capability === 'minting')!;
    const receipts = [0, 1].map(i => all.find(u => u.token?.nft?.commitment === receipt(i, i === 0 ? 150_000n : 100_000n))!);
    const pool = all.find(u => u.token?.category === PUSD)!;
    const reserve = all.find(u => !u.token)!;
    const builder = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs(receipts, contract.unlock.payout())
      .addInput(pool, contract.unlock.payout())
      .addInput(reserve, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530101' } } })
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(0, 90_000n) } } })
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(1, 0n) } } })
      .addOutput({ to: (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: members[0] }) as any).address, amount: 1_000n, token: { category: PUSD, amount: 160_000n } })
      .addOutput({ to: contract.tokenAddress, amount: 2_000n, token: { category: PUSD, amount: 90_000n } })
      .addOutput({ to: contract.address, amount: 10_000n });
    await builder.send();

    const remaining = await contract.getUtxos();
    expect(remaining.some(u => u.token?.category === PUSD && u.token.amount === 90_000n)).toBe(true);
    expect(remaining.some(u => u.token?.nft?.commitment === receipt(0, 90_000n))).toBe(true);
    expect(remaining.some(u => u.token?.nft?.commitment === receipt(1, 0n))).toBe(true);
  });
});
