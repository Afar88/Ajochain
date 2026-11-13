// Wallet-funded PUSD circle creation and contribution planning.
import {
  TransactionBuilder, placeholderP2PKHUnlocker,
  type SpendableUtxo,
} from 'cashscript';
import { getProvider } from './chain';
import { encodeCashAddress } from '@bitauth/libauth';
import { addressToPkh } from '../../src/lib/ajo';
import { assertPusdCategoryConfiguredForNetwork, pusdContract, PUSD_CATEGORY, PUSD_DUST, PUSD_DEFAULT_RESERVE, type PusdCircleParams } from '../../src/lib/pusd';
import { encodeRound } from '../../src/lib/ajo';

const estimateFee = (inputs:number, outputs:number) => BigInt(10 + inputs * 150 + outputs * 100 + 100);

export async function planPusdGenesis(
  base: Omit<PusdCircleParams,'stateCategory'>,
  walletAddress: string,
  reserveSats = PUSD_DEFAULT_RESERVE,
) {
  assertPusdCategoryNotMainnetOnChipnet(base.network, base.pusdCategory ?? PUSD_CATEGORY);
  const provider = await getProvider(base.network);
  const walletUtxos = await provider.getUtxos(walletAddress);
  const coins = walletUtxos.filter(u=>!u.token).sort((a,b)=>a.satoshis>b.satoshis?-1:1);
  const genesis = coins.find(u=>u.vout===0 && u.satoshis>=PUSD_DUST+reserveSats+1000n);
  if(!genesis) throw new Error('Wallet needs an output #0 BCH coin large enough to create the state NFT and fee reserve. Send BCH to your receive address and retry.');
  const params:PusdCircleParams={...base,stateCategory:genesis.txid};
  const contract=pusdContract(params,provider);
  const inputs:SpendableUtxo[]=[genesis];
  let total=genesis.satoshis;
  for(const u of coins){
    if(total>=PUSD_DUST+reserveSats+estimateFee(inputs.length,3)+546n) break;
    if(u.txid===genesis.txid && u.vout===genesis.vout) continue;
    inputs.push(u); total+=u.satoshis;
  }
  const fee=estimateFee(inputs.length,3);
  const change=total-PUSD_DUST-reserveSats-fee;
  if(change<0n) throw new Error('Not enough BCH to create the PUSD circle and its initial fee reserve');
  const b=new TransactionBuilder({provider});
  for(const u of inputs) b.addInput(u,placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({to:contract.tokenAddress,amount:PUSD_DUST,token:{category:genesis.txid,amount:0n,nft:{capability:'mutable',commitment:encodeRound(0)} }});
  b.addOutput({to:contract.address,amount:reserveSats});
  if(change>=546n) b.addOutput({to:walletAddress,amount:change});
  const wc=b.generateWcTransactionObject({broadcast:false,userPrompt:`Create PUSD Ajo circle "${base.name}" and fund its BCH fee reserve`});
  return {params,contract,wc,walletInputs:inputs.map((_,i)=>i),reserveSats};
}

export async function planPusdContribution(
  params:PusdCircleParams,
  walletAddress:string,
  reserveSats=PUSD_DEFAULT_RESERVE,
) {
  assertPusdCategoryNotMainnetOnChipnet(params.network, params.pusdCategory ?? PUSD_CATEGORY);
  const provider=await getProvider(params.network);
  const contract=pusdContract(params,provider);
  const walletUtxos=await provider.getUtxos(walletAddress);
  const tokenInputs=walletUtxos.filter(u=>u.token?.category=== (params.pusdCategory??PUSD_CATEGORY) && (u.token?.amount??0n)>0n);
  const tokenTotal=tokenInputs.reduce((s,u)=>s+(u.token?.amount??0n),0n);
  if(tokenTotal<params.contribution) throw new Error(`Not enough PUSD: wallet has ${tokenTotal} base units; needs ${params.contribution}`);
  let remaining=params.contribution;
  const pickedTokens:SpendableUtxo[]=[];
  for(const u of [...tokenInputs].sort((a,b)=>(b.token?.amount??0n)>(a.token?.amount??0n)?1:-1)){
    if(remaining<=0n) break;
    pickedTokens.push(u);
    remaining-=u.token?.amount??0n;
  }
  const tokenBacking=pickedTokens.reduce((s,u)=>s+u.satoshis,0n);
  const tokenChange=-remaining;
  const hasTokenChange=tokenChange>0n;
  if(tokenBacking<(hasTokenChange?2n*PUSD_DUST:PUSD_DUST)) throw new Error('Selected PUSD inputs do not carry enough BCH dust backing for token change');
  const walletTokenAddress=encodeCashAddress({prefix:params.network==='mainnet'?'bitcoincash':'bchtest',type:'p2pkhWithTokens',payload:addressToPkh(walletAddress)});
  if(typeof walletTokenAddress==='string') throw new Error('Could not derive wallet token-change address');
  const coins=walletUtxos.filter(u=>!u.token).sort((a,b)=>a.satoshis>b.satoshis?-1:1);
  const bchInputs:SpendableUtxo[]=[];
  let total=0n;
  for(const u of coins){
    if(total>=reserveSats+estimateFee(pickedTokens.length+bchInputs.length,hasTokenChange?4:3)+546n) break;
    bchInputs.push(u);total+=u.satoshis;
  }
  const fee=estimateFee(pickedTokens.length+bchInputs.length,hasTokenChange?4:3);
  const change=total-reserveSats-fee;
  if(change<0n) throw new Error('Not enough BCH to fund the circle fee reserve and transaction fee');
  const b=new TransactionBuilder({provider});
  for(const u of pickedTokens) b.addInput(u,placeholderP2PKHUnlocker(walletAddress));
  for(const u of bchInputs) b.addInput(u,placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({to:contract.tokenAddress,amount:hasTokenChange?tokenBacking-PUSD_DUST:tokenBacking,token:{category:params.pusdCategory??PUSD_CATEGORY,amount:params.contribution}});
  if(hasTokenChange) b.addOutput({to:walletTokenAddress.address,amount:PUSD_DUST,token:{category:params.pusdCategory??PUSD_CATEGORY,amount:BigInt(tokenChange)}});
  b.addOutput({to:contract.address,amount:reserveSats});
  if(change>=546n) b.addOutput({to:walletAddress,amount:change});
  const walletInputs=Array.from({length:pickedTokens.length+bchInputs.length},(_,i)=>i);
  const wc=b.generateWcTransactionObject({broadcast:false,userPrompt:`Contribute ${params.contribution} PUSD to "${params.name}" and replenish BCH fee reserve`});
  return {wc,walletInputs,contract,tokenAmount:params.contribution,reserveSats};
}
