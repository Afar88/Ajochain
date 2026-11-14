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
import artifactJson from '../contracts/AjoCircleV2Fee.json' with { type: 'json' };
import { pkhToAddress } from '../src/lib/ajo.js';

const artifact = artifactJson as unknown as Artifact;
const CATEGORY = 'cd'.repeat(32);
const CONTRIBUTION = 100_000n;
const MAX_FEE = 10_000n;
const DUST = 1000n;

function key(n: number) {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
}
const members = [key(1), key(2)];
const initiator = key(8);
const treasury = key(9);
const wrongTreasury = key(10);

function makeContract(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE, hexToBin(CATEGORY).reverse(),
    initiator.pkh, treasury.pkh,
  ], { provider, contractType: 'p2sh32' });
}

function creditCommitment(index: number, amount: bigint) {
  return '52' + index.toString(16).padStart(2, '0') +
    amount.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}

function addGenesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '540000' } },
  }));
  for (let i = 0; i < members.length; i++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(i, 0n) } },
    }));
  }
}

async function deposit(provider: MockNetworkProvider, contract: Contract, index: number) {
  const all = await contract.getUtxos();
  const state = all.find(u => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipt = all.find(u => u.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0'))) as SpendableUtxo;
  const address = pkhToAddress(members[index].pkh, 'chipnet');
  const funding = provider.addUtxo(address, randomUtxo({ satoshis: CONTRIBUTION + 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(index), CONTRIBUTION))
    .addInput(receipt, contract.unlock.addCredit(BigInt(index), CONTRIBUTION))
    .addInput(funding, members[index].sig.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + CONTRIBUTION,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(index, CONTRIBUTION) } },
    })
    .addOutput({ to: address, amount: 10_000n });
  await builder.send();
}

async function currentCircle(provider: MockNetworkProvider, contract: Contract) {
  const all = await contract.getUtxos();
  const state = all.find(u => u.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipts = members.map((_, i) => all.find(u =>
    u.token?.nft?.commitment?.startsWith('52' + i.toString(16).padStart(2, '0')),
  ) as SpendableUtxo);
  return { state, receipts };
}

async function payout(provider: MockNetworkProvider, contract: Contract, treasuryPkh = treasury.pkh) {
  const { state, receipts } = await currentCircle(provider, contract);
  const gross = BigInt(members.length) * CONTRIBUTION;
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const projectFee = gross / 100n;
  const minerFee = 8_000n;
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - gross,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '540101' } },
    });
  for (let i = 0; i < receipts.length; i++) {
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipts[i].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: creditCommitment(i, 0n) } },
    });
  }
  builder.addOutput({ to: pkhToAddress(treasuryPkh, 'chipnet'), amount: projectFee });
  builder.addOutput({
    to: pkhToAddress(members[round].pkh, 'chipnet'),
    amount: gross - projectFee - minerFee,
  });
  await builder.send();
}

async function cancel(provider: MockNetworkProvider, contract: Contract, signer = initiator) {
  const { state, receipts } = await currentCircle(provider, contract);
  const fundingAddress = pkhToAddress(signer.pkh, 'chipnet');
  const funding = provider.addUtxo(fundingAddress, randomUtxo({ satoshis: 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.cancel(signer.pub, signer.sig));
  builder.addInputs(receipts, contract.unlock.cancel(signer.pub, signer.sig));
  builder.addInput(funding, signer.sig.unlockP2PKH());
  for (let i = 0; i < receipts.length; i++) {
    builder.addOutput({
      to: pkhToAddress(members[i].pkh, 'chipnet'),
      amount: receipts[i].satoshis + CONTRIBUTION,
    });
  }
  builder.addOutput({ to: fundingAddress, amount: 15_000n });
  await builder.send();
}

describe('AjoCircleV2Fee versioned covenant', () => {
  it('enforces the 1% treasury output and permanent paid state on payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);

    await payout(provider, contract);
    const { state } = await currentCircle(provider, contract);
    expect(state.token!.nft!.commitment).toBe('540101');
  });

  it('rejects a payout sent to a different treasury address', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);

    await expect(payout(provider, contract, wrongTreasury.pkh)).rejects.toThrow();
  });

  it('allows initiator cancellation before the first payout and refunds exact member credit', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);

    await cancel(provider, contract);
    expect(await contract.getUtxos()).toHaveLength(0);
  });

  it('permanently rejects cancellation after the first payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);
    await payout(provider, contract);

    await expect(cancel(provider, contract)).rejects.toThrow();
  });

  it('keeps cancellation locked after a complete rotation returns the round to zero', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);
    await payout(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);
    await payout(provider, contract);

    const { state } = await currentCircle(provider, contract);
    expect(state.token!.nft!.commitment).toBe('540001');
    await expect(cancel(provider, contract)).rejects.toThrow();
  });

  it('rejects cancellation signed by a non-initiator', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0);
    await deposit(provider, contract, 1);

    await expect(cancel(provider, contract, members[0])).rejects.toThrow();
  });
});
