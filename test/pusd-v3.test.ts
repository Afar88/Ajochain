import { describe, expect, it } from 'vitest';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type Artifact } from 'cashscript';
import { hash160, secp256k1, hexToBin, encodeCashAddress } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCirclePUSDV3.json' with { type: 'json' };

const artifact = artifactJson as unknown as Artifact;
const STATE = 'ef'.repeat(32);
const PUSD = 'de'.repeat(32);
const C = 100_000n;
const MAX_FEE = 10_000n;
const RETENTION_BPS = 2_000n;
const members = [1, 2].map(n => { const priv = new Uint8Array(32); priv[31] = n; const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array; return { pkh: hash160(pub), sig: new SignatureTemplate(priv) }; });

function contractFor(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh, new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
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
      .addOutput({ to: (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: members[0].pkh }) as any).address, amount: 1_000n, token: { category: PUSD, amount: 160_000n } })
      .addOutput({ to: contract.tokenAddress, amount: 2_000n, token: { category: PUSD, amount: 90_000n } })
      .addOutput({ to: contract.address, amount: 10_000n })
      .addOutput({ to: regular, amount: 7_000n });
    await builder.send();

    const remaining = await contract.getUtxos();
    expect(remaining.some(u => u.token?.category === PUSD && u.token.amount === 90_000n)).toBe(true);
    expect(remaining.some(u => u.token?.nft?.commitment === receipt(0, 90_000n))).toBe(true);
    expect(remaining.some(u => u.token?.nft?.commitment === receipt(1, 0n))).toBe(true);
  });

  it('credits a member-specific PUSD deposit and creates the first reconciled pool', async () => {
    const provider = new MockNetworkProvider();
    const contract = contractFor(provider);
    const regular = (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: members[0].pkh }) as any).address;
    const tokenAddr = (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: members[0].pkh }) as any).address;
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530000' } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(0, 0n) } },
    }));
    provider.addUtxo(tokenAddr, randomUtxo({ satoshis: 1_000n, token: { category: PUSD, amount: C } }));
    provider.addUtxo(regular, randomUtxo({ satoshis: 20_000n }));

    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const rec = all.find(u => u.token?.nft?.commitment === receipt(0, 0n))!;
    const tokenInput = (await provider.getUtxos(tokenAddr)).find(u => u.token?.category === PUSD)!;
    const reserve = (await provider.getUtxos(regular)).find(u => !u.token)!;
    const builder = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.addCredit(0n, C, false))
      .addInput(rec, contract.unlock.addCredit(0n, C, false))
      .addInput(tokenInput, members[0].sig.unlockP2PKH())
      .addInput(reserve, members[0].sig.unlockP2PKH())
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530001' } } })
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(0, C) } } })
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: PUSD, amount: C } })
      .addOutput({ to: contract.address, amount: 10_000n });
    await builder.send();

    const after = await contract.getUtxos();
    expect(after.some(u => u.token?.nft?.commitment === '530001')).toBe(true);
    expect(after.some(u => u.token?.nft?.commitment === receipt(0, C))).toBe(true);
    expect(after.some(u => u.token?.category === PUSD && u.token.amount === C)).toBe(true);
  });


  it('adds later member deposits to the existing pool without losing token backing', async () => {
    const provider = new MockNetworkProvider();
    const contract = contractFor(provider);
    const regular = (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: members[1].pkh }) as any).address;
    const tokenAddr = (encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: members[1].pkh }) as any).address;
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530001' } },
    }));
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: 1_000n,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(1, 0n) } },
    }));
    provider.addUtxo(contract.address, randomUtxo({ satoshis: 1_000n, token: { category: PUSD, amount: C } }));
    provider.addUtxo(tokenAddr, randomUtxo({ satoshis: 1_000n, token: { category: PUSD, amount: C } }));
    provider.addUtxo(regular, randomUtxo({ satoshis: 20_000n }));

    const all = await contract.getUtxos();
    const state = all.find(u => u.token?.nft?.capability === 'minting')!;
    const rec = all.find(u => u.token?.nft?.commitment === receipt(1, 0n))!;
    const pool = all.find(u => u.token?.category === PUSD)!;
    const tokenInput = (await provider.getUtxos(tokenAddr)).find(u => u.token?.category === PUSD)!;
    const reserve = (await provider.getUtxos(regular)).find(u => !u.token)!;
    const builder = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.addCredit(1n, C, true))
      .addInput(rec, contract.unlock.addCredit(1n, C, true))
      .addInput(pool, contract.unlock.addCredit(1n, C, true))
      .addInput(tokenInput, members[1].sig.unlockP2PKH())
      .addInput(reserve, members[1].sig.unlockP2PKH())
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '530001' } } })
      .addOutput({ to: contract.tokenAddress, amount: 1_000n, token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: receipt(1, C) } } })
      .addOutput({ to: contract.tokenAddress, amount: 2_000n, token: { category: PUSD, amount: 2n * C } })
      .addOutput({ to: contract.address, amount: 10_000n });
    await builder.send();

    const after = await contract.getUtxos();
    expect(after.some(u => u.token?.category === PUSD && u.token.amount === 2n * C && u.satoshis === 2_000n)).toBe(true);
    expect(after.some(u => u.token?.nft?.commitment === receipt(1, C))).toBe(true);
  });

});
