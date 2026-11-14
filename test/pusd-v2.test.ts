import { describe, it, expect } from 'vitest';
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder,
  randomUtxo, type Artifact, type SpendableUtxo,
} from 'cashscript';
import { encodeCashAddress, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCirclePUSDV2.json' with { type: 'json' };
import escrowArtifactJson from '../contracts/AjoPUSDMemberEscrow.json' with { type: 'json' };
import { pkhToAddress } from '../src/lib/ajo.js';

const artifact = artifactJson as unknown as Artifact;
const escrowArtifact = escrowArtifactJson as unknown as Artifact;
const STATE = 'ab'.repeat(32);
const PUSD = 'cd'.repeat(32);
const DUST = 1000n;
const CONTRIBUTION = 100n;
const MAX_FEE = 5000n;

function key(n: number) {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}
const members = [key(1), key(2)];
const initiator = key(8);

function tokenAddress(pkh: Uint8Array) {
  const result = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh });
  if (typeof result === 'string') throw new Error('Could not encode token-aware address');
  return result.address;
}

function creditCommitment(index: number, amount: bigint) {
  const littleEndian = amount.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
  return '52' + index.toString(16).padStart(2, '0') + littleEndian;
}

function makeContract(provider: MockNetworkProvider) {
  const escrows = members.map((_, i) => new Contract(escrowArtifact, [
    hexToBin(STATE).reverse(), hexToBin(PUSD).reverse(), 2n, BigInt(i),
  ], { provider, contractType: 'p2sh32' }));
  const contract = new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE,
    hexToBin(STATE).reverse(), hexToBin(PUSD).reverse(), initiator.pkh,
    escrows[0].lockingBytecode, escrows[1].lockingBytecode,
    escrows[0].lockingBytecode, escrows[0].lockingBytecode, escrows[0].lockingBytecode,
  ], { provider, contractType: 'p2sh32' });
  return { contract, escrows };
}

function addGenesis(provider: MockNetworkProvider, contract: Contract, escrows: Contract[]) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: '540000' } },
  }));
  for (let i = 0; i < members.length; i++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(i, 0n) } },
    }));
    provider.addUtxo(escrows[i].address, randomUtxo({ satoshis: DUST }));
  }
}

async function current(provider: MockNetworkProvider, contract: Contract, escrows: Contract[]) {
  const all = await contract.getUtxos();
  const state = all.find(u => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipts = members.map((_, i) => all.find(u =>
    u.token?.nft?.commitment?.startsWith('52' + i.toString(16).padStart(2, '0')),
  ) as SpendableUtxo);
  // These are the untouched genesis BCH-only escrow placeholders. This helper
  // is used only to construct the first deposit; post-deposit escrow lookup is
  // by token category, never by an order-dependent array index.
  const emptyEscrows = await Promise.all(escrows.map(async escrow => (await escrow.getUtxos())[0] as SpendableUtxo));
  return { state, receipts, emptyEscrows, all };
}

async function deposit(provider: MockNetworkProvider, contract: Contract, escrows: Contract[], index: number, fundingIndex = index) {
  const { state, receipts, emptyEscrows } = await current(provider, contract, escrows);
  const escrow = emptyEscrows[index];
  const memberAddress = tokenAddress(members[fundingIndex].pkh);
  const funding = provider.addUtxo(memberAddress, randomUtxo({
    satoshis: DUST,
    token: { category: PUSD, amount: CONTRIBUTION },
  }));
  const reserveAddress = pkhToAddress(initiator.pkh, 'chipnet');
  const reserve = provider.addUtxo(reserveAddress, randomUtxo({ satoshis: 20_000n }));
  const unlock = contract.unlock.deposit(BigInt(index), CONTRIBUTION);
  const builder = new TransactionBuilder({ provider })
    .addInput(state, unlock)
    .addInput(receipts[index], unlock)
    .addInput(escrow, escrows[index].unlock.attest())
    .addInput(funding, members[fundingIndex].sig.unlockP2PKH())
    .addInput(reserve, initiator.sig.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress, amount: state.satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress, amount: receipts[index].satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(index, CONTRIBUTION) } },
    })
    .addOutput({
      to: escrows[index].tokenAddress, amount: escrow.satoshis + funding.satoshis,
      token: { category: PUSD, amount: CONTRIBUTION },
    })
    .addOutput({ to: reserveAddress, amount: 15_000n });
  await builder.send();
}

describe('AjoCirclePUSDV2 member escrow covenant', () => {
  it('attributes each deposit to the registered member and preserves token BCH backing', async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContract(provider);
    addGenesis(provider, contract, escrows);

    await deposit(provider, contract, escrows, 0);
    const { receipts, all } = await current(provider, contract, escrows);
    const fundedEscrow = all.find(u => u.token?.category === PUSD);
    expect(receipts[0].token!.nft!.commitment).toBe(creditCommitment(0, CONTRIBUTION));
    expect(fundedEscrow?.token?.amount).toBe(CONTRIBUTION);
    expect(fundedEscrow?.satoshis).toBe(2n * DUST);
  });

  it('rejects PUSD funding from a different registered member', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await expect(deposit(provider, contract, escrows, 0, 1)).rejects.toThrow();
  });
});
