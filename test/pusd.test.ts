import { describe, it, expect, beforeEach } from 'vitest';
import { Contract, MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';
import artifactJson from '../contracts/AjoCirclePUSD.json' with { type: 'json' };

const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const STATE = 'ab'.repeat(32);
const DUST = 1000n;
const STATE_SATS = 1000n;
const TOKEN_SATS = 1500n;
const C = 100n;
const FEE_RESERVE_SATS = 20_000n;
const FEE_RESERVE_CHANGE = 15_000n;
const members = [1,2,3,4,5].map(i => {
  const priv = new Uint8Array(32); priv[31] = i;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
});
const outsider = (() => {
  const priv = new Uint8Array(32); priv[31] = 99;
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, pkh: hash160(pub), sig: new SignatureTemplate(priv) };
})();
const tokenAddress = (pkh: Uint8Array) => (encodeCashAddress({prefix:'bchtest',type:'p2pkhWithTokens',payload:pkh}) as any).address as string;
const args = [
  members[0].pkh,members[1].pkh,members[2].pkh,members[3].pkh,members[4].pkh,
  5n,C,BufferlessHex(STATE),BufferlessHex(PUSD)
] as const;
function BufferlessHex(s:string) { return Uint8Array.from(s.match(/.{2}/g)!.map(x=>parseInt(x,16))).reverse(); }

let provider: MockNetworkProvider;
let contract: Contract;
function state(round:number) {
  return randomUtxo({satoshis:STATE_SATS,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:round.toString(16).padStart(2,'0')}}});
}
function token(category=PUSD, amount=100n, satoshis=TOKEN_SATS) {
  return randomUtxo({satoshis,token:{category,amount}});
}
async function feeReserveUtxo() {
  provider.addUtxo(contract.address,randomUtxo({satoshis:FEE_RESERVE_SATS}));
  return (await contract.getUtxos()).find(u=>!u.token && u.satoshis===FEE_RESERVE_SATS)!;
}
async function fundRound(round:number, amounts=[C,C,C,C,C]) {
  // The first state NFT is seeded once; later rounds spend the NFT returned by
  // the preceding payout rather than minting a fresh mock state token.
  if (round === 0) provider.addUtxo(contract.address,state(round));
  for (const amount of amounts) provider.addUtxo(contract.address,token(PUSD,amount));
}
async function payoutTx(st:any, inputs:any[], recipient=members[0], nextRound=1, paid=500n, surplus=0n) {
  const b=new TransactionBuilder({provider});
  b.addInput(st,contract.unlock.payout());
  b.addInputs(inputs,contract.unlock.payout());
  b.addInput(await feeReserveUtxo(),contract.unlock.payout());
  b.addOutput({to:contract.tokenAddress,amount:STATE_SATS,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:nextRound.toString(16).padStart(2,'0')}}});
  const tokenBchIn=inputs.reduce((sum,u)=>sum+u.satoshis,0n);
  const surplusBch=surplus>0n?DUST:0n;
  b.addOutput({to:tokenAddress(recipient.pkh),amount:tokenBchIn-surplusBch,token:{category:PUSD,amount:paid}});
  if (surplus>0n) b.addOutput({to:contract.tokenAddress,amount:surplusBch,token:{category:PUSD,amount:surplus}});
  b.addOutput({to:contract.tokenAddress,amount:FEE_RESERVE_CHANGE});
  return b;
}
beforeEach(() => {
  provider=new MockNetworkProvider();
  contract=new Contract(artifactJson as any,args as any,{provider,contractType:'p2sh32'});
});

describe('AjoCirclePUSD',()=>{
  it('pays the full PUSD pot to all five members over five rounds',async()=>{
    for(let r=0;r<5;r++){
      await fundRound(r);
      const all=await contract.getUtxos();
      const st=all.find(u=>u.token?.category===STATE)!;
      const inputs=all.filter(u=>u.token?.category===PUSD);
      await (await payoutTx(st,inputs,members[r],r+1,500n)).send();
      const paid=await provider.getUtxos(tokenAddress(members[r].pkh));
      expect(paid.reduce((s,u)=>s+(u.token?.amount??0n),0n)).toBe(500n);
    }
  });

  it('rejects a contribution using the wrong token category',async()=>{
    const st=randomUtxo({satoshis:3500n,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:'00'}}}), bad=randomUtxo({satoshis:3500n,token:{category:'cd'.repeat(32),amount:300n}});
    provider.addUtxo(contract.address,st);
    provider.addUtxo(contract.address,bad);
    const all=await contract.getUtxos();
    const stateInput=all.find(u=>u.token?.category===STATE)!;
    const badInput=all.find(u=>u.token?.category==='cd'.repeat(32))!;
    const b=new TransactionBuilder({provider}).addInput(stateInput,contract.unlock.payout()).addInput(badInput,contract.unlock.payout())
      .addOutput({to:contract.tokenAddress,amount:3500n,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:'01'}}})
      .addOutput({to:tokenAddress(members[0].pkh),amount:DUST,token:{category:'cd'.repeat(32),amount:300n}});
    await expect(b.send()).rejects.toThrow(/contribution must be PUSD/);
  });

  it('rejects a pot short by one token unit',async()=>{
    await fundRound(0,[100n,100n,100n,100n,99n]);
    const all=await contract.getUtxos(), st=all.find(u=>u.token?.category===STATE)!, ins=all.filter(u=>u.token?.category===PUSD);
    await expect((await payoutTx(st,ins,members[0],1,499n)).send()).rejects.toThrow(/PUSD pot not full yet/);
  });

  it('rejects paying the wrong member',async()=>{
    await fundRound(0);
    const all=await contract.getUtxos(), st=all.find(u=>u.token?.category===STATE)!, ins=all.filter(u=>u.token?.category===PUSD);
    await expect((await payoutTx(st,ins,members[1],1,500n)).send()).rejects.toThrow(/pot must go to this round's member/);
  });

  it('rejects skipping a round',async()=>{
    await fundRound(0);
    const all=await contract.getUtxos(), st=all.find(u=>u.token?.category===STATE)!, ins=all.filter(u=>u.token?.category===PUSD);
    await expect((await payoutTx(st,ins,members[0],2,500n)).send()).rejects.toThrow(/round must increment by one/);
  });

  it('returns PUSD surplus only to the circle',async()=>{
    provider.addUtxo(contract.address,state(0));
    for (const amount of [250n,100n,100n,100n,100n]) provider.addUtxo(contract.address,token(PUSD,amount,TOKEN_SATS));
    const all=await contract.getUtxos(), st=all.find(u=>u.token?.category===STATE)!, ins=all.filter(u=>u.token?.category===PUSD);
    const b=new TransactionBuilder({provider}).addInput(st,contract.unlock.payout()).addInputs(ins,contract.unlock.payout())
      .addInput(await feeReserveUtxo(),contract.unlock.payout())
      .addOutput({to:contract.tokenAddress,amount:STATE_SATS,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:'01'}}})
      .addOutput({to:tokenAddress(members[0].pkh),amount:6500n,token:{category:PUSD,amount:500n}})
      .addOutput({to:tokenAddress(outsider.pkh),amount:1000n,token:{category:PUSD,amount:150n}})
      .addOutput({to:contract.tokenAddress,amount:FEE_RESERVE_CHANGE});
    await expect(b.send()).rejects.toThrow(/PUSD surplus must return to circle/);
  });

  it('returns valid PUSD surplus to the circle',async()=>{
    provider.addUtxo(contract.address,state(0));
    for (const amount of [250n,100n,100n,100n,100n]) provider.addUtxo(contract.address,token(PUSD,amount,TOKEN_SATS));
    const all=await contract.getUtxos(), st=all.find(u=>u.token?.category===STATE)!, ins=all.filter(u=>u.token?.category===PUSD);
    await (await payoutTx(st,ins,members[0],1,500n,150n)).send();
    const remaining=await contract.getUtxos();
    expect(remaining.filter(u=>u.token?.category===PUSD).reduce((sum,u)=>sum+(u.token?.amount??0n),0n)).toBe(150n);
  });

  it('rejects a non-member attempting cancel',async()=>{
    const st=state(0);
    provider.addUtxo(contract.address,st);
    const stateInput=(await contract.getUtxos()).find(u=>u.token?.category===STATE)!;
    const sigArgs=[outsider,members[1],members[2],outsider,outsider].flatMap(k=>[k.pub,k.sig]);
    const b=new TransactionBuilder({provider}).addInput(stateInput,(contract.unlock as any).cancel(...sigArgs))
      .addOutput({to:tokenAddress(outsider.pkh),amount:DUST,token:{category:STATE,amount:0n,nft:{capability:'mutable',commitment:'00'}}});
    await expect(b.send()).rejects.toThrow();
  });
});
