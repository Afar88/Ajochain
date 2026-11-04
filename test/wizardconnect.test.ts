import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { buildWizardSignRequest } from '../web/src/wallet';

const txid = hexToBin('11'.repeat(32));
const lockingBytecode = hexToBin(`76a914${'22'.repeat(20)}88ac`);

const walletTransaction = () => {
  const input = {
    outpointTransactionHash: txid,
    outpointIndex: 0,
    sequenceNumber: 0xfffffffe,
    unlockingBytecode: new Uint8Array(),
  };
  return {
    transaction: {
      version: 2,
      locktime: 0,
      inputs: [input],
      outputs: [{ lockingBytecode, valueSatoshis: 1_000n }],
    },
    sourceOutputs: [{
      ...input,
      lockingBytecode,
      valueSatoshis: 2_000n,
    }],
  };
};

describe('WizardConnect signing request serialization', () => {
  it('sends the unsigned transaction as hex and source outputs in canonical relay format', () => {
    const wc = walletTransaction();
    const request = buildWizardSignRequest(wc, [0], 4, 'Start Ajo circle');

    expect(request.transaction.transaction).toBe(binToHex(encodeTransaction(wc.transaction)));
    expect(request.transaction.sourceOutputs).toHaveLength(1);
    expect(request.transaction.sourceOutputs[0].outpointTransactionHash).toBe('11'.repeat(32));
    expect(request.transaction.sourceOutputs[0].lockingBytecode).toBe(binToHex(lockingBytecode));
    expect(request.transaction.sourceOutputs[0].valueSatoshis).toBe('<bigint: 2000n>');
    expect(request.transaction.broadcast).toBe(false);
    expect(request.transaction.userPrompt).toBe('Start Ajo circle');
    expect(request.inputPaths).toEqual([[0, 'receive', 4]]);
    expect(() => JSON.stringify(request)).not.toThrow();
  });

  it('rejects source-output counts that do not match transaction inputs', () => {
    const wc = walletTransaction();
    wc.sourceOutputs = [];
    expect(() => buildWizardSignRequest(wc, [0], 0, 'Test')).toThrow(/source-output count mismatch/);
  });

  it('rejects invalid or duplicate signing input indexes', () => {
    const wc = walletTransaction();
    expect(() => buildWizardSignRequest(wc, [1], 0, 'Test')).toThrow(/Invalid wallet signing input index/);
    expect(() => buildWizardSignRequest(wc, [0, 0], 0, 'Test')).toThrow(/duplicate input indexes/);
  });
});
