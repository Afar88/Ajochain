import type { TransactionBuilder } from 'cashscript';
import { addressToPkh, pkhToAddress, type Net } from './ajo.js';

export const ONCHAIN_DISCOVERY_MARKER_SATS = 546n;
const MAGIC = new Uint8Array([0x41, 0x4a, 0x4f]); // "AJO"
const FORMAT_VERSION = 1;
const MAX_NAME_BYTES = 60;
const MAX_MEMBERS = 5;
const MIN_MEMBERS = 2;
const ZERO_CATEGORY = '0'.repeat(64);

export type DiscoveryAsset = 'BCH' | 'PUSD';

export interface OnchainDiscoveryManifest {
  formatVersion: 1;
  contractVersion: 1 | 2 | 3;
  network: Net;
  asset: DiscoveryAsset;
  name: string;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  retentionBps: bigint;
  pusdCategory?: string;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('Invalid hexadecimal discovery data.');
  return new Uint8Array(value.match(/../g)!.map(pair => Number.parseInt(pair, 16)));
}

function uintLE(value: bigint, bytes: number, label: string): Uint8Array {
  if (value < 0n || value >= (1n << BigInt(bytes * 8))) throw new Error(`${label} is outside the on-chain discovery format range.`);
  const result = new Uint8Array(bytes);
  let remaining = value;
  for (let i = 0; i < bytes; i++) { result[i] = Number(remaining & 0xffn); remaining >>= 8n; }
  return result;
}

function readUintLE(bytes: Uint8Array, offset: number, length: number): bigint {
  let result = 0n;
  for (let i = length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[offset + i]);
  return result;
}

export function validateCashTokensGenesisSourceOutput(
  expectedCategory: string,
  previousTransactionId: string,
  previousOutputZero: { valueSatoshis: bigint; token?: unknown } | undefined,
): void {
  if (!/^[0-9a-f]{64}$/i.test(expectedCategory) ||
      !/^[0-9a-f]{64}$/i.test(previousTransactionId) ||
      expectedCategory.toLowerCase() !== previousTransactionId.toLowerCase()) {
    throw new Error('CashTokens category does not match the first input previous transaction ID.');
  }
  if (!previousOutputZero || typeof previousOutputZero.valueSatoshis !== 'bigint' ||
      previousOutputZero.valueSatoshis <= 0n) {
    throw new Error('The first input must spend an existing output 0 with a positive BCH value.');
  }
  if (previousOutputZero.token !== undefined) {
    throw new Error('CashTokens genesis must spend a non-token output 0.');
  }
}

function compactName(name: string): Uint8Array {
  const encoder = new TextEncoder();
  let compact = '';
  for (const character of name.trim()) {
    const candidate = compact + character;
    if (encoder.encode(candidate).length > MAX_NAME_BYTES) break;
    compact = candidate;
  }
  const encoded = encoder.encode(compact);
  if (!encoded.length) throw new Error('Circle name is required for on-chain discovery.');
  return encoded;
}

function validateManifest(manifest: OnchainDiscoveryManifest): {
  name: Uint8Array;
  members: Uint8Array[];
  category: Uint8Array;
} {
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error('Unsupported on-chain discovery format version.');
  if (![1, 2, 3].includes(manifest.contractVersion)) throw new Error('Unsupported circle contract version.');
  if (manifest.network !== 'chipnet' && manifest.network !== 'mainnet') throw new Error('Invalid discovery network.');
  if (manifest.asset !== 'BCH' && manifest.asset !== 'PUSD') throw new Error('Invalid discovery asset.');
  if (!Array.isArray(manifest.members) || manifest.members.length < MIN_MEMBERS || manifest.members.length > MAX_MEMBERS) {
    throw new Error('On-chain discovery requires 2–5 member addresses.');
  }
  const expectedPrefix = manifest.network === 'chipnet' ? 'bchtest:' : 'bitcoincash:';
  if (!manifest.members.every(member => member.toLowerCase().startsWith(expectedPrefix))) {
    throw new Error(`Every member address must use the ${manifest.network} CashAddress prefix.`);
  }
  const members = manifest.members.map(addressToPkh);
  const ids = members.map(hex);
  if (new Set(ids).size !== ids.length) throw new Error('A circle cannot register the same member address more than once.');
  if (manifest.contribution <= 0n) throw new Error('Circle contribution must be positive.');
  if (manifest.maxFee < 0n) throw new Error('Circle maximum fee cannot be negative.');
  if (manifest.retentionBps < 0n || manifest.retentionBps > 5000n) throw new Error('Retention must be between 0% and 50%.');
  const name = compactName(manifest.name);
  let category = fromHex(ZERO_CATEGORY);
  if (manifest.asset === 'PUSD') {
    if (!manifest.pusdCategory || !/^[0-9a-f]{64}$/i.test(manifest.pusdCategory)) throw new Error('PUSD discovery requires its exact 32-byte token category.');
    category = fromHex(manifest.pusdCategory);
  } else if (manifest.pusdCategory) {
    throw new Error('A BCH circle cannot declare a PUSD token category.');
  }
  return { name, members, category };
}

/**
 * Compact, deterministic transaction metadata. The state NFT category is
 * intentionally not copied into the payload: readers derive it from input 0
 * of the genesis transaction (CashTokens' vout-0 genesis rule).
 */
export function encodeOnchainDiscoveryManifest(manifest: OnchainDiscoveryManifest): Uint8Array {
  const checked = validateManifest(manifest);
  const network = manifest.network === 'chipnet' ? 0 : 1;
  const asset = manifest.asset === 'BCH' ? 0 : 1;
  const memberBytes = concat(checked.members);
  return concat([
    MAGIC,
    new Uint8Array([FORMAT_VERSION, manifest.contractVersion, network, asset, checked.members.length, checked.name.length]),
    checked.name,
    memberBytes,
    uintLE(manifest.contribution, 8, 'Contribution'),
    uintLE(manifest.maxFee, 8, 'Maximum fee'),
    uintLE(manifest.retentionBps, 2, 'Retention'),
    checked.category,
  ]);
}

export function decodeOnchainDiscoveryManifest(payload: Uint8Array): OnchainDiscoveryManifest {
  if (payload.length < 3 + 6 + 2 * 20 + 8 + 8 + 2 + 32) throw new Error('On-chain discovery payload is too short.');
  if (hex(payload.slice(0, 3)) !== hex(MAGIC)) throw new Error('This transaction is not an AjoChain discovery announcement.');
  const formatVersion = payload[3];
  const contractVersion = payload[4];
  const networkByte = payload[5];
  const assetByte = payload[6];
  const memberCount = payload[7];
  const nameLength = payload[8];
  if (formatVersion !== FORMAT_VERSION) throw new Error('Unsupported AjoChain discovery format version.');
  if (![1, 2, 3].includes(contractVersion)) throw new Error('Unsupported AjoChain contract version in discovery data.');
  if (networkByte > 1 || assetByte > 1) throw new Error('Invalid network or asset in discovery data.');
  if (memberCount < MIN_MEMBERS || memberCount > MAX_MEMBERS || nameLength < 1 || nameLength > MAX_NAME_BYTES) {
    throw new Error('Invalid member count or circle name in discovery data.');
  }
  const expectedLength = 9 + nameLength + memberCount * 20 + 8 + 8 + 2 + 32;
  if (payload.length !== expectedLength) throw new Error('Discovery payload length does not match its declared fields.');
  let offset = 9;
  const name = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(offset, offset + nameLength));
  offset += nameLength;
  const network: Net = networkByte === 0 ? 'chipnet' : 'mainnet';
  const members: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    members.push(pkhToAddress(payload.slice(offset, offset + 20), network));
    offset += 20;
  }
  const contribution = readUintLE(payload, offset, 8); offset += 8;
  const maxFee = readUintLE(payload, offset, 8); offset += 8;
  const retentionBps = readUintLE(payload, offset, 2); offset += 2;
  const category = hex(payload.slice(offset, offset + 32));
  const asset: DiscoveryAsset = assetByte === 0 ? 'BCH' : 'PUSD';
  if ((asset === 'BCH' && category !== ZERO_CATEGORY) || (asset === 'PUSD' && category === ZERO_CATEGORY)) {
    throw new Error('Discovery token category does not match the declared asset.');
  }
  const manifest: OnchainDiscoveryManifest = {
    formatVersion: 1,
    contractVersion: contractVersion as 1 | 2 | 3,
    network,
    asset,
    name,
    members,
    contribution,
    maxFee,
    retentionBps,
    ...(asset === 'PUSD' ? { pusdCategory: category } : {}),
  };
  validateManifest(manifest);
  return manifest;
}

/** Read a single OP_RETURN push payload from a locking bytecode script. */
export function readOnchainDiscoveryOpReturn(script: Uint8Array): Uint8Array | null {
  if (script.length < 2 || script[0] !== 0x6a) return null;
  const chunks: Uint8Array[] = [];
  let offset = 1;
  while (offset < script.length) {
    const opcode = script[offset++];
    let length: number;
    if (opcode <= 0x4b) length = opcode;
    else if (opcode === 0x4c) {
      if (offset >= script.length) return null;
      length = script[offset++];
    } else if (opcode === 0x4d) {
      if (offset + 2 > script.length) return null;
      length = script[offset] | (script[offset + 1] << 8); offset += 2;
    } else return null;
    if (offset + length > script.length) return null;
    chunks.push(script.slice(offset, offset + length));
    offset += length;
  }
  return concat(chunks);
}

export function isOnchainMemberMarker(
  lockingBytecode: Uint8Array,
  valueSatoshis: bigint,
  memberAddress: string,
): boolean {
  if (valueSatoshis !== ONCHAIN_DISCOVERY_MARKER_SATS || lockingBytecode.length !== 25) return false;
  if (lockingBytecode[0] !== 0x76 || lockingBytecode[1] !== 0xa9 || lockingBytecode[2] !== 0x14 ||
      lockingBytecode[23] !== 0x88 || lockingBytecode[24] !== 0xac) return false;
  return hex(lockingBytecode.slice(3, 23)) === hex(addressToPkh(memberAddress));
}

/**
 * Place a small spendable marker at each member's own address and the full
 * constructor manifest in OP_RETURN. Wallet history can then discover circles
 * on a clean device without trusting localStorage or a server-side registry.
 */
export function addOnchainDiscoveryOutputs(
  builder: TransactionBuilder,
  manifest: OnchainDiscoveryManifest,
): void {
  const payload = encodeOnchainDiscoveryManifest(manifest);
  for (const member of manifest.members) {
    builder.addOutput({ to: member, amount: ONCHAIN_DISCOVERY_MARKER_SATS });
  }
  builder.addOpReturnOutput([`0x${hex(payload)}`]);
}

export function onchainDiscoveryMarkerCost(manifest: OnchainDiscoveryManifest): bigint {
  validateManifest(manifest);
  return BigInt(manifest.members.length) * ONCHAIN_DISCOVERY_MARKER_SATS;
}

export function onchainDiscoveryOutputCount(manifest: OnchainDiscoveryManifest): number {
  validateManifest(manifest);
  return manifest.members.length + 1; // member outputs plus the OP_RETURN announcement
}
