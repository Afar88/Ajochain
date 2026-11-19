import { binToHex, decodeTransaction, decodeCashAddress, hexToBin } from '@bitauth/libauth';
import type { Contract } from 'cashscript';
import { addressToPkh, circleContract, type CircleParams, type Net } from '../../src/lib/ajo';
import {
  configuredPusdCategory, isPusdStateUtxo, pusdContract, pusdStatus,
  type PusdCircleParams,
} from '../../src/lib/pusd';
import { verifyClassicCircle } from '../../src/lib/recovery';
import {
  decodeOnchainDiscoveryManifest, isOnchainMemberMarker, readOnchainDiscoveryOpReturn,
  type OnchainDiscoveryManifest,
} from '../../src/lib/onchain-discovery';
import { readV2Circle, type V2CircleParams } from './ajo-v2-chain';
import { readV3Circle, type V3CircleParams } from './ajo-v3-chain';
import { getAddressHistory, getProvider, getRawTransaction } from './chain';
import { readPusdV3Circle, type PusdV3Params } from './pusd-v3-chain';

export type DiscoveredCircleKind = 'v1-bch' | 'v1-pusd' | 'v2-bch' | 'v3-bch' | 'v3-pusd';

export type DiscoveredCircleParams =
  | CircleParams | PusdCircleParams | V2CircleParams | V3CircleParams | PusdV3Params;

export interface DiscoveredCircle {
  identity: string;
  kind: DiscoveredCircleKind;
  params: DiscoveredCircleParams;
  manifest: OnchainDiscoveryManifest;
  stateCategory: string;
  contractAddress: string;
  markerTxid: string;
  blockHeight: number;
  round: number;
  completed: boolean;
  ready: boolean;
  credits?: bigint[];
  stateSatoshis?: bigint;
  poolTokens?: bigint;
}

interface Candidate {
  txid: string;
  height: number;
  raw: string;
  manifest: OnchainDiscoveryManifest;
  stateCategory: string;
  transaction: NonNullable<ReturnType<typeof decodeTransaction>> & { inputs: any[]; outputs: any[] };
}

function scriptForCashAddress(address: string): Uint8Array {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') throw new Error('Could not decode the reconstructed circle address.');
  if (decoded.payload.length === 32) return new Uint8Array([0xaa, 0x20, ...decoded.payload, 0x87]);
  if (decoded.payload.length === 20) {
    if (decoded.type === 'p2pkh' || decoded.type === 'p2pkhWithTokens') {
      return new Uint8Array([0x76, 0xa9, 0x14, ...decoded.payload, 0x88, 0xac]);
    }
    return new Uint8Array([0xa9, 0x14, ...decoded.payload, 0x87]);
  }
  throw new Error('Unsupported reconstructed CashAddress script type.');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function p2pkhScript(address: string): Uint8Array {
  const pkh = addressToPkh(address);
  return new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

function markerScriptPresent(outputs: any[], address: string): boolean {
  return outputs.some(output =>
    isOnchainMemberMarker(output.lockingBytecode, output.valueSatoshis, address),
  );
}

function validNftOutput(
  output: any,
  script: Uint8Array,
  category: string,
  capability: 'none' | 'mutable' | 'minting',
  commitment: string,
  value: bigint,
): boolean {
  if (!output?.token || binToHex(output.lockingBytecode) !== binToHex(script)) return false;
  return binToHex(output.token.category).toLowerCase() === category.toLowerCase()
    && output.token.amount === 0n
    && output.token.nft?.capability === capability
    && binToHex(output.token.nft.commitment).toLowerCase() === commitment.toLowerCase()
    && output.valueSatoshis === value;
}

function verifyGenesisOutputs(
  transaction: { outputs: any[] },
  manifest: OnchainDiscoveryManifest,
  stateCategory: string,
  tokenAddress: string,
): void {
  const script = scriptForCashAddress(tokenAddress);
  const outputs = transaction.outputs;
  const stateCommitment = manifest.contractVersion === 1
    ? '00'
    : manifest.asset === 'PUSD' ? '530000' : '5300';
  const stateCapability = manifest.contractVersion === 1 ? 'mutable' : 'minting';
  const stateValue = 1000n;
  if (!outputs.some(output => validNftOutput(
    output, script, stateCategory, stateCapability, stateCommitment, stateValue,
  ))) {
    throw new Error('The creation transaction does not contain the expected state NFT at the reconstructed covenant address.');
  }

  if (manifest.contractVersion === 2 || manifest.contractVersion === 3) {
    for (let index = 0; index < manifest.members.length; index++) {
      const commitment = '52' + index.toString(16).padStart(2, '0') + '00'.repeat(8);
      if (!outputs.some(output => validNftOutput(
        output, script, stateCategory, 'none', commitment, 1000n,
      ))) {
        throw new Error(`The creation transaction is missing member receipt ${index + 1}.`);
      }
    }
  }
}

function findCandidate(
  txid: string,
  height: number,
  raw: string,
  walletAddress: string,
): Candidate | null {
  const transaction = decodeTransaction(hexToBin(raw));
  if (typeof transaction === 'string') return null;
  if (!transaction.inputs.length || transaction.inputs[0].outpointIndex !== 0) return null;

  let manifest: OnchainDiscoveryManifest | null = null;
  for (const output of transaction.outputs) {
    const payload = readOnchainDiscoveryOpReturn(output.lockingBytecode);
    if (!payload) continue;
    try {
      const decoded = decodeOnchainDiscoveryManifest(payload);
      if (manifest) return null; // Ambiguous transaction metadata: fail closed.
      manifest = decoded;
    } catch {
      // Ignore unrelated OP_RETURN outputs, including malformed user memos.
    }
  }
  if (!manifest || manifest.network === undefined) return null;
  if (!markerScriptPresent(transaction.outputs, walletAddress)) return null;
  const walletKey = hex(addressToPkh(walletAddress));
  if (!manifest.members.some(member => hex(addressToPkh(member)) === walletKey)) return null;

  // Libauth exposes outpointTransactionHash in the same display order as a txid.
  const stateCategory = binToHex(transaction.inputs[0].outpointTransactionHash).toLowerCase();
  return { txid, height, raw, manifest, stateCategory, transaction };
}

function reconstructParams(candidate: Candidate):
  | { kind: 'v1-bch'; params: CircleParams }
  | { kind: 'v1-pusd'; params: PusdCircleParams }
  | { kind: 'v2-bch'; params: V2CircleParams }
  | { kind: 'v3-bch'; params: V3CircleParams }
  | { kind: 'v3-pusd'; params: PusdV3Params } {
  const m = candidate.manifest;
  if (m.asset === 'BCH' && m.contractVersion === 1) {
    return {
      kind: 'v1-bch',
      params: { name: m.name, network: m.network, members: m.members, contribution: m.contribution, maxFee: m.maxFee, stateCategory: candidate.stateCategory },
    };
  }
  if (m.asset === 'PUSD' && m.contractVersion === 1) {
    return {
      kind: 'v1-pusd',
      params: { name: m.name, network: m.network, members: m.members, contribution: m.contribution, stateCategory: candidate.stateCategory, pusdCategory: m.pusdCategory },
    };
  }
  if (m.asset === 'BCH' && m.contractVersion === 2) {
    return {
      kind: 'v2-bch',
      params: { version: 2, name: m.name, network: m.network, members: m.members, contribution: m.contribution, maxFee: m.maxFee, stateCategory: candidate.stateCategory },
    };
  }
  if (m.asset === 'BCH' && m.contractVersion === 3) {
    return {
      kind: 'v3-bch',
      params: { version: 3, name: m.name, network: m.network, members: m.members, contribution: m.contribution, maxFee: m.maxFee, retentionBps: m.retentionBps, stateCategory: candidate.stateCategory },
    };
  }
  if (m.asset === 'PUSD' && m.contractVersion === 3) {
    return {
      kind: 'v3-pusd',
      params: { version: 3, name: m.name, network: m.network, members: m.members, contribution: m.contribution, maxFee: m.maxFee, retentionBps: m.retentionBps, stateCategory: candidate.stateCategory, pusdCategory: m.pusdCategory },
    };
  }
  throw new Error('This AjoChain circle version/asset combination is not supported.');
}

function identity(kind: DiscoveredCircleKind, stateCategory: string, params: DiscoveredCircleParams): string {
  return [params.network, kind, stateCategory.toLowerCase()].join(':');
}

/**
 * Scan the connected public address history for AjoChain creation transactions.
 * Every candidate is reconstructed from its on-chain manifest and accepted only
 * after its genesis outputs and current contract state are independently checked.
 * No database or localStorage record is used as proof of existence or balance.
 */
export async function discoverCirclesFromBlockchain(
  network: Net,
  walletAddress: string,
): Promise<DiscoveredCircle[]> {
  const history = await getAddressHistory(network, walletAddress);
  const unique = [...new Map(history.map(item => [item.txid, item])).values()];
  const candidates: Candidate[] = [];
  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (cursor < unique.length) {
      const item = unique[cursor++];
      try {
        const raw = await getRawTransaction(network, item.txid);
        const candidate = findCandidate(item.txid, item.height, raw, walletAddress);
        if (candidate && candidate.manifest.network === network) candidates.push(candidate);
      } catch {
        // History entries can be pruned or unavailable at one Electrum server.
        // A missing transaction is not treated as a verified circle.
      }
    }
  });
  await Promise.all(workers);

  const provider = await getProvider(network);
  const discovered = new Map<string, DiscoveredCircle>();
  for (const candidate of candidates) {
    try {
      const reconstructed = reconstructParams(candidate);
      let contract: Contract;
      let live: Omit<DiscoveredCircle, 'identity' | 'kind' | 'params' | 'manifest' | 'stateCategory' | 'contractAddress' | 'markerTxid' | 'blockHeight'>;

      switch (reconstructed.kind) {
        case 'v1-bch': {
          const params = reconstructed.params;
          contract = circleContract(params, provider);
          verifyGenesisOutputs(candidate.transaction, candidate.manifest, candidate.stateCategory, contract.tokenAddress);
          const utxos = await contract.getUtxos();
          const report = verifyClassicCircle(params, utxos);
          const completed = report.issues.some(issue => issue.code === 'completed');
          const allowedIssues = report.issues.every(issue => issue.code === 'completed' || issue.code === 'wrong_category');
          if (!report.stateOutpoint || !allowedIssues) throw new Error('Classic V1 on-chain state failed verification.');
          live = { round: report.round ?? 0, completed, ready: report.payoutPossible, stateSatoshis: report.stateValue };
          break;
        }
        case 'v1-pusd': {
          const params = reconstructed.params;
          contract = pusdContract(params, provider);
          verifyGenesisOutputs(candidate.transaction, candidate.manifest, candidate.stateCategory, contract.tokenAddress);
          const utxos = await contract.getUtxos();
          const states = utxos.filter(utxo => isPusdStateUtxo(utxo, params.stateCategory));
          if (states.length !== 1) throw new Error('Legacy PUSD state NFT is missing or duplicated.');
          const status = pusdStatus(params, utxos);
          if (!status.stateUtxo || status.round === null) throw new Error('Legacy PUSD state cannot be verified.');
          live = { round: status.round, completed: status.completed, ready: status.ready, stateSatoshis: status.stateUtxo.satoshis };
          break;
        }
        case 'v2-bch': {
          const params = reconstructed.params;
          contract = (await readV2Circle(params)).contract;
          verifyGenesisOutputs(candidate.transaction, candidate.manifest, candidate.stateCategory, contract.tokenAddress);
          const state = await readV2Circle(params);
          live = { round: state.round, completed: Boolean(state.completed), ready: state.ready, credits: state.credits, stateSatoshis: state.stateSatoshis };
          break;
        }
        case 'v3-bch': {
          const params = reconstructed.params;
          const state = await readV3Circle(params);
          contract = state.contract;
          verifyGenesisOutputs(candidate.transaction, candidate.manifest, candidate.stateCategory, contract.tokenAddress);
          live = { round: state.round, completed: Boolean(state.completed), ready: state.ready, credits: state.credits, stateSatoshis: state.stateSatoshis };
          break;
        }
        case 'v3-pusd': {
          const params = reconstructed.params;
          const state = await readPusdV3Circle(params);
          contract = state.contract;
          verifyGenesisOutputs(candidate.transaction, candidate.manifest, candidate.stateCategory, contract.tokenAddress);
          live = { round: state.round, completed: Boolean(state.completed), ready: state.ready, credits: state.credits, poolTokens: state.pool?.token?.amount ?? 0n, stateSatoshis: state.state.satoshis };
          break;
        }
      }

      const key = identity(reconstructed.kind, candidate.stateCategory, reconstructed.params);
      if (!discovered.has(key)) {
        discovered.set(key, {
          identity: key,
          kind: reconstructed.kind,
          params: reconstructed.params,
          manifest: candidate.manifest,
          stateCategory: candidate.stateCategory,
          contractAddress: contract.address,
          markerTxid: candidate.txid,
          blockHeight: candidate.height,
          ...live!,
        });
      }
    } catch {
      // A marker/manifest is only a discovery hint. Invalid genesis or live
      // covenant state is deliberately excluded from the verified result.
    }
  }
  return [...discovered.values()].sort((a, b) => b.blockHeight - a.blockHeight);
}
