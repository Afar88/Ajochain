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

function creditFromCommitment(commitment: string) {
  const encoded = commitment.slice(4).match(/../g)!.reverse().join('');
  return BigInt('0x' + encoded);
}

function addGenesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: 200_000n,
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
  amount = CONTRIBUTION,
) {
  const all = await contract.getUtxos();
  const state = all.find((u) => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipt = all.find((u) => u.token?.nft?.commitment?.startsWith('52' + memberIndex.toString(16).padStart(2, '0'))) as SpendableUtxo;
  const oldCredit = creditFromCommitment(receipt.token!.nft!.commitment);
  const fundingAddress = pkhToAddress(members[fundingIndex].pkh, 'chipnet');
  const funding = provider.addUtxo(fundingAddress, randomUtxo({ satoshis: amount + 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, members[fundingIndex].sig.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + amount,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(memberIndex, oldCredit + amount) } },
    })
    .addOutput({ to: fundingAddress, amount: 10_000n });
  await builder.send();
}

async function payoutRound(provider: MockNetworkProvider, contract: Contract, recipientIndex: number) {
  const all = await contract.getUtxos();
  const state = all.find((u) => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipts = members.map((_, i) => all.find((u) =>
    u.token?.nft?.commitment?.startsWith('52' + i.toString(16).padStart(2, '0')),
  ) as SpendableUtxo);
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - BigInt(members.length) * CONTRIBUTION,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '530' + ((recipientIndex + 1) % members.length).toString(16) } },
    });

  for (let i = 0; i < receipts.length; i++) {
    const credit = creditFromCommitment(receipts[i].token!.nft!.commitment);
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipts[i].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(i, credit - CONTRIBUTION) } },
    });
  }
  builder.addOutput({
    to: pkhToAddress(members[recipientIndex].pkh, 'chipnet'),
    amount: BigInt(members.length) * CONTRIBUTION - MAX_FEE,
  });
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

  it('accumulates repeated deposits on the same member receipt', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);

    await deposit(provider, contract, 0, 0, 60_000n);
    await deposit(provider, contract, 0, 0, 40_000n);

    const utxos = await contract.getUtxos();
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(0, CONTRIBUTION))).toBe(true);
  });

  it('pays a complete round and preserves excess member credit as rollover', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0, 0, 150_000n);
    await deposit(provider, contract, 1, 1, 100_000n);

    await payoutRound(provider, contract, 0);

    const utxos = await contract.getUtxos();
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(0, 50_000n))).toBe(true);
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(1, 0n))).toBe(true);
    expect(utxos.some((u) => u.token?.nft?.commitment === '5301')).toBe(true);
  });

  it('completes two full cycles and wraps payout order back to member zero', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);

    for (let cycle = 0; cycle < 2; cycle++) {
      await deposit(provider, contract, 0);
      await deposit(provider, contract, 1);
      await payoutRound(provider, contract, cycle % members.length);
    }

    const utxos = await contract.getUtxos();
    expect(utxos.some((u) => u.token?.nft?.commitment === '5300')).toBe(true);
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(0, 0n))).toBe(true);
    expect(utxos.some((u) => u.token?.nft?.commitment === creditCommitment(1, 0n))).toBe(true);
  });

  it('rejects a member trying to add credit to another member receipt', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);

    await expect(deposit(provider, contract, 1, 0)).rejects.toThrow();
  });

  it('rejects payout when member receipt inputs are swapped', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);

    const all = await contract.getUtxos();
    const state = all.find((u) => u.token?.nft?.capability === 'minting') as SpendableUtxo;
    const receipt0 = all.find((u) => u.token?.nft?.commitment?.startsWith('5200')) as SpendableUtxo;
    const receipt1 = all.find((u) => u.token?.nft?.commitment?.startsWith('5201')) as SpendableUtxo;
    const tx = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs([receipt1, receipt0], contract.unlock.payout())
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
