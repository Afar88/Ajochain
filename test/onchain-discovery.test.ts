import { describe, expect, it } from 'vitest';
import { addressToPkh, pkhToAddress } from '../src/lib/ajo.js';
import {
  decodeOnchainDiscoveryManifest,
  encodeOnchainDiscoveryManifest,
  isOnchainMemberMarker,
  readOnchainDiscoveryOpReturn,
  validateCashTokensGenesisSourceOutput,
} from '../src/lib/onchain-discovery.js';

const members = [
  pkhToAddress(new Uint8Array(20).fill(1), 'chipnet'),
  pkhToAddress(new Uint8Array(20).fill(2), 'chipnet'),
];

describe('AjoChain on-chain discovery manifest', () => {
  it('round-trips PUSD ACR v3 constructor metadata and member order', () => {
    const manifest = {
      formatVersion: 1 as const, contractVersion: 3 as const, network: 'chipnet' as const,
      asset: 'PUSD' as const, name: 'Our Ajo ACR', members,
      contribution: 123456n, maxFee: 10000n, retentionBps: 2000n,
      pusdCategory: '11'.repeat(32),
    };
    const decoded = decodeOnchainDiscoveryManifest(encodeOnchainDiscoveryManifest(manifest));
    expect(decoded).toEqual(manifest);
  });

  it('round-trips a BCH V2 manifest and preserves the ordered member list', () => {
    const manifest = {
      formatVersion: 1 as const, contractVersion: 2 as const, network: 'chipnet' as const,
      asset: 'BCH' as const, name: 'Our Ajo', members,
      contribution: 1000n, maxFee: 10000n, retentionBps: 0n,
    };
    const decoded = decodeOnchainDiscoveryManifest(encodeOnchainDiscoveryManifest(manifest));
    expect(decoded).toEqual(manifest);
  });

  it('rejects duplicate members instead of creating ambiguous member markers', () => {
    const manifest = {
      formatVersion: 1 as const, contractVersion: 1 as const, network: 'chipnet' as const,
      asset: 'BCH' as const, name: 'Legacy circle', members: [members[0], members[0]],
      contribution: 1000n, maxFee: 1000n, retentionBps: 0n,
    };
    expect(() => encodeOnchainDiscoveryManifest(manifest)).toThrow(/same member address/);
  });

  it('reads the PUSHDATA1 OP_RETURN encoding used by full manifests', () => {
    expect(readOnchainDiscoveryOpReturn(new Uint8Array([0x6a, 0x4c, 0x03, 0x41, 0x4a, 0x4f])))
      .toEqual(new Uint8Array([0x41, 0x4a, 0x4f]));
  });

  it('rejects malformed or truncated OP_RETURN pushes', () => {
    expect(readOnchainDiscoveryOpReturn(new Uint8Array([0x6a, 0x4c]))).toBeNull();
    expect(readOnchainDiscoveryOpReturn(new Uint8Array([0x6a, 0x4c, 0x04, 0x41, 0x42]))).toBeNull();
    expect(readOnchainDiscoveryOpReturn(new Uint8Array([0x51, 0x01]))).toBeNull();
  });

  it('rejects names that would be silently truncated in the manifest', () => {
    const manifest = {
      formatVersion: 1 as const, contractVersion: 2 as const, network: 'chipnet' as const,
      asset: 'BCH' as const, name: 'A'.repeat(61), members,
      contribution: 1000n, maxFee: 1000n, retentionBps: 0n,
    };
    expect(() => encodeOnchainDiscoveryManifest(manifest)).toThrow(/60 UTF-8 bytes/);
  });

  it('requires the CashTokens genesis input to spend a non-token vout-0 output', () => {
    const txid = 'ab'.repeat(32);
    expect(() => validateCashTokensGenesisSourceOutput(txid, txid, { valueSatoshis: 1n })).not.toThrow();
    expect(() => validateCashTokensGenesisSourceOutput(txid, txid, { valueSatoshis: 1n, token: { category: 'cd'.repeat(32) } })).toThrow(/non-token output 0/);
    expect(() => validateCashTokensGenesisSourceOutput(txid, 'cd'.repeat(32), { valueSatoshis: 1n })).toThrow(/previous transaction ID/);
    expect(() => validateCashTokensGenesisSourceOutput(txid, txid, undefined)).toThrow(/output 0/);
  });

  it('recognises only the exact 546-satoshi marker sent to the queried member', () => {
    const pkh = addressToPkh(members[0]);
    const script = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
    expect(isOnchainMemberMarker(script, 546n, members[0])).toBe(true);
    expect(isOnchainMemberMarker(script, 545n, members[0])).toBe(false);
    expect(isOnchainMemberMarker(script, 546n, members[1])).toBe(false);
  });
});
