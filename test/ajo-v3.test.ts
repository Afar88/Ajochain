import { describe, expect, it } from 'vitest';
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder,
  randomUtxo, type Artifact, type SpendableUtxo,
} from 'cashscript';
import { hash160, secp256k1, hexToBin } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCircleV3.json' with { type: 'json' };
import { pkhToAddress } from '../src/lib/ajo.js';
import { planV3Genesis } from '../web/src/ajo-v3-chain.js';

const artifact = artifactJson as unknown as Artifact;
const CATEGORY = 'ac'.repeat(32);
const CONTRIBUTION = 100_000n;
const MAX_FEE = 10_000n;
const RETENTION_BPS = 2_000n;
const DUST = 1_000n;

const members = [1, 2].map(n => {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
});

function makeContract(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE, RETENTION_BPS, hexToBin(CATEGORY).reverse(),
  ], { provider, contractType: 'p2sh32' });
}

function le(value: bigint, bytes: number) {
  return value.toString(16).padStart(bytes * 2, '0').match(/../g)!.reverse().join('');
}
function receipt(index: number, credit: bigint) {
  return '52' + index.toString(16).padStart(2, '0') + le(credit, 8);
}
function readCredit(commitment: string) {
  return BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
}
function genesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: 200_000n,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '5300' } },
  }));
  for (let i = 0; i < members.length; i++) provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receipt(i, 0n) } },
  }));
}
async function deposit(provider: MockNetworkProvider, contract: Contract, index: number, amount = CONTRIBUTION) {
  const all = await contract.getUtxos();
  const state = all.find(u => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const rec = all.find(u => u.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0'))) as SpendableUtxo;
  const addr = pkhToAddress(members[index].pkh, 'chipnet');
  const funding = provider.addUtxo(addr, randomUtxo({ satoshis: amount + 20_000n }));
  const old = readCredit(rec.token!.nft!.commitment);
  await new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(index), amount))
    .addInput(rec, contract.unlock.addCredit(BigInt(index), amount))
    .addInput(funding, members[index].sig.unlockP2PKH())
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis + amount, token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } } })
    .addOutput({ to: contract.tokenAddress, amount: rec.satoshis, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receipt(index, old + amount) } } })
    .addOutput({ to: addr, amount: 10_000n })
    .send();
}
async function payout(provider: MockNetworkProvider, contract: Contract) {
  const all = await contract.getUtxos();
  const state = all.find(u => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  const recs = members.map((_, i) => all.find(u => u.token?.nft?.commitment?.startsWith('52' + i.toString(16).padStart(2, '0'))) as SpendableUtxo);
  const pot = BigInt(members.length) * CONTRIBUTION;
  const retained = pot * RETENTION_BPS / 10_000n;
  const b = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(recs, contract.unlock.payout())
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis - pot + retained, token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '53' + ((round + 1) % members.length).toString(16).padStart(2, '0') } } });
  recs.forEach((r, i) => {
    const old = readCredit(r.token!.nft!.commitment);
    b.addOutput({ to: contract.tokenAddress, amount: r.satoshis, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receipt(i, old - CONTRIBUTION + (i === round ? retained : 0n)) } } });
  });
  b.addOutput({ to: pkhToAddress(members[round].pkh, 'chipnet'), amount: pot - retained - MAX_FEE });
  await b.send();
}

describe('AjoCircleV3 BCH ACR covenant', () => {
  it('retains 20% of the gross payout as the winner next-contribution credit', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    genesis(provider, contract);
    await deposit(provider, contract, 0, 150_000n);
    await deposit(provider, contract, 1);
    await payout(provider, contract);

    const utxos = await contract.getUtxos();
    expect(utxos.some(u => u.token?.nft?.commitment === receipt(0, 90_000n))).toBe(true);
    expect(utxos.some(u => u.token?.nft?.commitment === receipt(1, 0n))).toBe(true);
    expect(utxos.some(u => u.token?.nft?.commitment === '5301')).toBe(true);
  });

  it('rejects Mainnet before any ACR v3 transaction planning', async () => {
    const addresses = members.map(member => pkhToAddress(member.pkh, 'mainnet'));
    await expect(planV3Genesis({
      version: 3,
      name: 'ACR v3 Chipnet-only test',
      network: 'mainnet',
      members: addresses,
      contribution: CONTRIBUTION,
      maxFee: MAX_FEE,
      retentionBps: RETENTION_BPS,
    }, addresses[0])).rejects.toThrow(/Chipnet-only/);
  });

  it('blocks payout when any member is short, even if another has excess credit', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    genesis(provider, contract);
    await deposit(provider, contract, 0, 150_000n);
    await deposit(provider, contract, 1, 99_999n);
    await expect(payout(provider, contract)).rejects.toThrow();
  });
});
