import { describe, it, expect } from 'vitest';
import { DemoCircle } from '../web/src/demo.js';

describe('web demo circle (in-browser simulator logic)', () => {
  it('starts at round 1 with 3 of 5 paid, blocks cheating, and completes all rounds', async () => {
    const d = new DemoCircle();
    let s = await d.refresh();
    expect(s.round).toBe(0);
    expect(s.available).toBe(300_000n);
    await d.cheat();
    expect(d.log[0].kind).toBe('bad');
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 5; i++) if (!d.paidThisRound.has(i)) d.addContribution(i);
      await d.cheat();
      expect(d.log[0].detail).toMatch(/pot must go to this round's member/);
      await d.payout();
      expect(d.log[0].kind).toBe('ok');
    }
    s = await d.refresh();
    expect(s.completed).toBe(true);
    expect(d.payouts).toHaveLength(5);
  });
});
