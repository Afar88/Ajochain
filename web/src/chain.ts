// Live-network helpers: Electrum provider, genesis (start a circle) and contribute
// transactions that the connected WizardConnect wallet signs.
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type SpendableUtxo,
  type Contract,
} from 'cashscript';
import { addressToPkh, circleContract, STATE_DUST, encodeRound, type CircleParams, type Net } from '../../src/lib/ajo';
import { addOnchainDiscoveryOutputs, onchainDiscoveryMarkerCost, onchainDiscoveryOutputCount } from '../../src/lib/onchain-discovery.js';

import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';

// Public Fulcrum servers (WebSocket, TLS). Probed in parallel; the first to answer wins.
const SERVERS: Record<Net, [string, number][]> = {
  chipnet: [['chipnet.imaginary.cash', 50004], ['chipnet.bch.ninja', 50004], ['cbch.loping.net', 62104]],
  mainnet: [['bch.imaginary.cash', 50004], ['electroncash.de', 50004], ['bch.loping.net', 50004]],
};

function makeProvider(net: Net, host: string, port: number) {
  const electrum = new ElectrumClient('AjoChain', '1.5.0', new ElectrumWebSocket(host, { port, encrypted: true, timeout: 8000 } as any));
  return new ElectrumNetworkProvider(net, { electrum } as any);
}

const providers: Partial<Record<Net, Promise<ElectrumNetworkProvider>>> = {};
/** Resolve a working Electrum provider for the network (cached). */
export function getProvider(net: Net): Promise<ElectrumNetworkProvider> {
  if (!providers[net]) {
    // Optional override, e.g. localStorage.setItem('ajo-electrum-chipnet', 'myserver.example:50004')
    const override = typeof localStorage !== 'undefined' ? localStorage.getItem(`ajo-electrum-${net}`) : null;
    const list: [string, number][] = override
      ? [[override.split(':')[0], Number(override.split(':')[1] || 50004)]]
      : SERVERS[net];
    const probes = list.map(async ([h, port]) => {
      const candidate = makeProvider(net, h, port);
      await Promise.race([
        candidate.getBlockHeight(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${h} timed out`)), 9000)),
      ]);
      return candidate;
    });
    providers[net] = Promise.any(probes).catch(() => {
      delete providers[net];
      throw new Error(`No ${net} Electrum server reachable (${list.map((l) => l[0]).join(', ')})`);
    });
  }
  return providers[net]!;
}

/** Read the address's public transaction history directly from the selected Electrum server. */
export async function getAddressHistory(net: Net, address: string): Promise<{ txid: string; height: number }[]> {
  const provider = await getProvider(net);
  const pkh = addressToPkh(address);
  const lockingBytecode = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', lockingBytecode));
  const scriptHash = Array.from(digest.reverse(), byte => byte.toString(16).padStart(2, '0')).join('');
  // Use CashScript's public request wrapper so concurrent requests share the provider lifecycle safely.
  const history = await provider.performRequest('blockchain.scripthash.get_history', scriptHash) as unknown;
  if (!Array.isArray(history)) throw new Error('The Electrum server returned an invalid script-hash history response.');
  return history.flatMap((entry: any) => {
    if (!entry || typeof entry.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.tx_hash) || !Number.isInteger(entry.height)) return [];
    return [{ txid: entry.tx_hash.toLowerCase(), height: entry.height as number }];
  });
}

/** Fetch the raw transaction bytes for an on-chain discovery candidate. */
export async function getRawTransaction(net: Net, txid: string): Promise<string> {
  const provider = await getProvider(net);
  const raw = await provider.getRawTransaction(txid);
  if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(raw)) throw new Error('Electrum returned an invalid raw transaction.');
  return raw;
}

export function explorerTx(net: Net, txid: string) {
  return net === 'chipnet'
    ? `https://chipnet.imaginary.cash/tx/${txid}`
    : `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
}

/** Rough fee estimate for P2PKH-funded txs (placeholder unlockers are empty when built). */
function estimateFee(nIn: number, nOut: number) {
  return BigInt(10 + nIn * 150 + nOut * 100 + 100);
}

/** Inspect the connected receive address before a circle is created. */
export async function inspectWalletFunding(net: Net, walletAddress: string) {
  const prov = await getProvider(net);
  const utxos = (await prov.getUtxos(walletAddress)).filter((u) => !u.token);
  const total = utxos.reduce((sum, u) => sum + u.satoshis, 0n);
  const eligible = utxos.filter((u) => u.vout === 0 && u.satoshis >= 3000n);
  return {
    count: utxos.length,
    total,
    eligible,
    utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, satoshis: u.satoshis })),
  };
}

/**
 * Plan the genesis transaction that starts a circle.
 * The state NFT's category = txid of the wallet UTXO spent at input 0, which must be
 * an output with index 0 (CashTokens genesis rule). So the category, and therefore
 * the circle address, is known before anything is signed.
 */
export async function planGenesis(base: Omit<CircleParams, 'stateCategory'>, walletAddress: string) {
  const prov = await getProvider(base.network);
  const utxos = (await prov.getUtxos(walletAddress)).filter((u) => !u.token);
  const genesisUtxo = utxos.find((u) => u.vout === 0);
  if (!genesisUtxo) {
    throw new Error(utxos.length
      ? `AjoChain can see ${utxos.length} BCH coin(s) totalling ${utxos.reduce((sum, u) => sum + u.satoshis, 0n).toString()} sats at the connected address, but none is eligible for CashTokens genesis. It needs a non-token coin at transaction output index 0 (vout 0). That coin has no 3,000-satoshi minimum; the wallet's total BCH must still cover the state NFT, member markers, and miner fee. Open Wallet details and run “Check BCH funding” to inspect the coins.`
      : 'No BCH coins were found at the connected receive address on this network. Check that Selene and AjoChain use the same network and receive address, then run “Check BCH funding” again. Do not send more BCH until the address and network are confirmed.');
  }
  const params: CircleParams = { ...base, stateCategory: genesisUtxo.txid };
  const contract = circleContract(params, prov);

  const discovery = { formatVersion: 1 as const, contractVersion: 1 as const, network: base.network, asset: 'BCH' as const, name: base.name, members: base.members, contribution: base.contribution, maxFee: base.maxFee, retentionBps: 0n };
  const discoveryCost = onchainDiscoveryMarkerCost(discovery);
  const outputCount = 2 + onchainDiscoveryOutputCount(discovery);
  const inputs: SpendableUtxo[] = [genesisUtxo];
  let total = genesisUtxo.satoshis;
  for (const u of utxos) {
    if (total >= STATE_DUST + discoveryCost + estimateFee(inputs.length, outputCount) + 250n + 546n) break;
    if (u === genesisUtxo) continue;
    inputs.push(u); total += u.satoshis;
  }
  const fee = estimateFee(inputs.length, outputCount) + 250n;
  const change = total - STATE_DUST - discoveryCost - fee;
  if (change < 0n) throw new Error('Not enough BCH in wallet to start the circle');

  const b = new TransactionBuilder({ provider: prov });
  for (const u of inputs) b.addInput(u, placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({
    to: contract.tokenAddress,
    amount: STATE_DUST,
    token: { category: genesisUtxo.txid, amount: 0n, nft: { capability: 'mutable', commitment: encodeRound(0) } },
  });
  addOnchainDiscoveryOutputs(b, discovery);
  if (change >= 546n) b.addOutput({ to: walletAddress, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: `Start Ajo circle "${base.name}"` });
  return { params, contract, wc, walletInputs: inputs.map((_, i) => i) };
}

/** Plan a contribution from the connected wallet to the circle address. */
export async function planContribution(params: CircleParams, contract: Contract, walletAddress: string) {
  const prov = await getProvider(params.network);
  const utxos = (await prov.getUtxos(walletAddress)).filter((u) => !u.token)
    .sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1));
  const inputs: SpendableUtxo[] = [];
  let total = 0n;
  for (const u of utxos) {
    if (total >= params.contribution + estimateFee(inputs.length, 2) + 546n) break;
    inputs.push(u); total += u.satoshis;
  }
  const fee = estimateFee(inputs.length, 2);
  const change = total - params.contribution - fee;
  if (change < 0n) throw new Error('Not enough BCH in your wallet for this contribution');
  const b = new TransactionBuilder({ provider: prov });
  for (const u of inputs) b.addInput(u, placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({ to: contract.address, amount: params.contribution });
  if (change >= 546n) b.addOutput({ to: walletAddress, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: `Ajo contribution to "${params.name}"` });
  return { wc, walletInputs: inputs.map((_, i) => i) };
}
