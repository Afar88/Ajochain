import { describe, it, expect } from 'vitest';
import {
  Contract,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  randomUtxo,
  type Artifact,
  type SpendableUtxo,
} from 'cashscript';
import { hash160, secp256k1, hexToBin } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCircleV2.json' with { type: 'json' };
import { pkhToAddress } from '../src/lib/ajo.js';

const artifact = artifactJson as unknown as Artifact;
const CATEGORY = 'ab'.repeat(32);
const CONTRIBUTION = 100_000n;
const MAX_FEE = 10_000n;
const DUST = 1000n;

const members = [1, 2].map((n) => {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
});

function makeContract(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE, hexToBin(CATEGORY).reverse(),
  ], { provider, contractType: 'p2sh32' });
}

// CashScript integers use little-endian byte encoding in commitments.
function littleEndianHex(value: bigint, byteLength: number) {
  return value.toString(16).padStart(byteLength * 2, '0')
    .match(/../g)!.reverse().join('');
}

function creditCommitment(index: number, amount: bigint) {
  return '52' + index.toString(16).padStart(2, '0') + littleEndianHex(amount, 8);
}

function addGenesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '5300' } },
  }));
  for (let i = 0; i < members.length; i++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(i, 0n) } },
    }));
  }
}

async function deposit(
  provider: MockNetworkProvider,
  contract: Contract,
  memberIndex: number,
  fundingIndex = memberIndex,
) {
  const all = await contract.getUtxos();
  const state = all.find((u) => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipt = all.find((u) => u.token?.nft?.commitment === creditCommitment(memberIndex, 0n)) as SpendableUtxo;
  const fundingAddress = pkhToAddress(members[fundingIndex].pkh, 'chipnet');
  const funding = provider.addUtxo(fundingAddress, randomUtxo({ satoshis: 120_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), CONTRIBUTION))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), CONTRIBUTION))
    .addInput(funding, members[fundingIndex].sig.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + CONTRIBUTION,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '5300' } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(memberIndex, CONTRIBUTION) } },
    })
    .addOutput({ to: fundingAddress, amount: 10_000n });
  await builder.send();
}

describe('AjoCircleV2 member-credit covenant prototype', () => {
  it('compiles to a contract and binds a credit to the registered funding address', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);

    await deposit(provider, contract, 0);
    const utxos = await contract.getUtxos();
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(0, CONTRIBUTION))).toBe(true);
  });

  it('rejects a member trying to add credit to another member receipt', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);

    await expect(deposit(provider, contract, 1, 0)).rejects.toThrow();
  });

  it('blocks payout while any member receipt is below one contribution', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);

    const all = await contract.getUtxos();
    const state = all.find((u) => u.token?.nft?.capability === 'minting') as SpendableUtxo;
    const receipts = [0, 1].map((i) => all.find((u) => u.token?.nft?.commitment?.startsWith('52' + i.toString(16).padStart(2, '0'))) as SpendableUtxo);
    const tx = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs(receipts, contract.unlock.payout())
      .addOutput({
        to: contract.tokenAddress,
        amount: state.satoshis - 2n * CONTRIBUTION,
        token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '5301' } },
      })
      .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(0, 0n) } } })
      .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(1, 0n) } } })
      .addOutput({ to: pkhToAddress(members[0].pkh, 'chipnet'), amount: 190_000n });
    await expect(tx.send()).rejects.toThrow();
  });
});
