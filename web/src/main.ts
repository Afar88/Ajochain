import './style.css';
import QRCode from 'qrcode';
import {
  circleContract, circleStatus, buildPayout, encodeCircle, decodeCircle, addressToPkh,
  DEFAULT_MAX_FEE, MAX_MEMBERS, MIN_MEMBERS, type CircleParams, type Net,
} from '../../src/lib/ajo';
import { wallet } from './wallet';
import { getProvider, explorerTx, planGenesis, planContribution, inspectWalletFunding } from './chain';
import { MockNetworkProvider } from 'cashscript';
import { PUSD_CATEGORY, PUSD_DEFAULT_RESERVE, pusdContract, pusdStatus, buildPusdPayout, type PusdCircleParams } from '../../src/lib/pusd';
import { planPusdGenesis, planPusdContribution } from './pusd-chain';
import { planV2Genesis, planV2Deposit, planV2Payout, readV2Circle, type V2CircleParams } from './ajo-v2-chain';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const app = $('#app');
const esc = (s: string) => s.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]!));
const bch = (sats: bigint) => (Number(sats) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
const short = (a: string) => { const [p, r] = a.split(':'); return `${p}:${r.slice(0, 6)}…${r.slice(-5)}`; };
const offline = (net: Net) => { const m = new MockNetworkProvider(); (m as any).network = net; return m; };

let network: Net = (localStorage.getItem('ajo-net') as Net) || 'chipnet';

function renderHeader() {
  const w = wallet;
  const addr = w.state === 'connected' ? w.address(network) : null;
  $('#hdr').innerHTML = `
    <a class="brand" href="#/"><span class="logo">◎</span> AjoChain</a>
    <div class="hdr-right">
      <button class="net ${network}" id="netBtn" title="Switch network">${network === 'chipnet' ? 'Chipnet · Test' : 'Mainnet'}</button>
      ${w.state === 'connected'
        ? `<button class="wallet on" id="walletBtn" title="Disconnect">${esc(w.walletName || 'Wallet')} · ${addr ? short(addr) : ''}</button>`
        : `<button class="wallet" id="walletBtn">${w.state === 'connecting' ? 'Connecting…' : w.state === 'reconnecting' ? 'Reconnecting…' : w.state === 'disconnecting' ? 'Disconnecting…' : 'Connect wallet'}</button>`}
    </div>`;
  $('#netBtn').onclick = () => {
    const next: Net = network === 'chipnet' ? 'mainnet' : 'chipnet';
    if (next === 'mainnet' && !confirm('Mainnet uses real BCH. AjoChain is an unaudited MVP. Switch only if you understand the risks.')) return;
    network = next; localStorage.setItem('ajo-net', network); route();
  };
  $('#walletBtn').onclick = () => (w.state === 'connected' ? openWalletDetails() : openWalletModal());
}

let walletModalRender = 0;
let walletQrUri: string | null = null;
let walletQrDataUrl = '';
let walletQrPromise: Promise<string> | null = null;

async function getWalletQr(uri: string): Promise<string> {
  if (walletQrUri === uri && walletQrDataUrl) return walletQrDataUrl;
  if (walletQrUri === uri && walletQrPromise) return walletQrPromise;
  walletQrUri = uri;
  walletQrDataUrl = '';
  walletQrPromise = QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 260 })
    .then((data) => {
      if (walletQrUri === uri) walletQrDataUrl = data;
      return data;
    })
    .catch(() => '');
  const result = await walletQrPromise;
  if (walletQrUri === uri) walletQrPromise = null;
  return walletQrUri === uri ? result : '';
}

async function renderWalletModal() {
  const m = $('#modal');
  if (!m.classList.contains('show')) return;
  if (wallet.state === 'connected') { m.classList.remove('show'); return; }
  const renderId = ++walletModalRender;
  const qr = wallet.qrUri ? await getWalletQr(wallet.qrUri) : '';
  if (renderId !== walletModalRender || !m.classList.contains('show')) return;
  const status = wallet.state === 'reconnecting'
    ? 'Connection interrupted. WizardConnect is trying to restore your session…'
    : wallet.state === 'connecting' && !wallet.qrUri
      ? 'Trying to restore your saved Selene session…'
      : wallet.state === 'disconnecting'
      ? 'Disconnecting wallet…'
      : wallet.state === 'disconnected'
        ? 'Wallet disconnected. Connect again when you are ready.'
        : 'Scan with a WizardConnect-enabled Bitcoin Cash wallet. Your keys never leave your phone.';
  m.innerHTML = `<div class="sheet"><h3>Connect with WizardConnect</h3><p class="muted">${status}</p>${qr ? `<img class="qr" src="${qr}" alt="WizardConnect pairing QR"/>` : (wallet.state === 'connecting' ? '<p>Starting secure relay…</p>' : '')}${wallet.uri ? `<button class="ghost" id="copyWiz">Copy pairing link</button> <a class="ghost btnlink" href="${esc(wallet.uri)}">Open in wallet app</a>` : ''}${wallet.error ? `<p class="err">${esc(wallet.error)}</p>` : ''}${wallet.state === 'connecting' && wallet.error ? '<button class="btn" id="retryPairing">Start a fresh pairing</button>' : ''}<button class="ghost" id="closeModal">Close</button></div>`;
  // Closing the sheet must not kill a live pairing while the user switches to Selene.
  $('#closeModal', m).onclick = () => { m.classList.remove('show'); };
  const retry = $('#retryPairing', m);
  if (retry) retry.onclick = () => wallet.startFreshPairing();
  const copy = $('#copyWiz', m);
  if (copy && wallet.uri) copy.onclick = () => navigator.clipboard.writeText(wallet.uri!);
}

function openWalletModal() {
  if (wallet.state === 'idle' || wallet.state === 'disconnected') wallet.connect();
  const m = $('#modal');
  m.classList.add('show');
  void renderWalletModal();
}
function openWalletDetails() {
  const m = $('#modal');
  const addr = wallet.address(network);
  m.innerHTML = `<div class="sheet wallet-details">
    <p class="kicker">Wallet connected</p>
    <h3>${esc(wallet.walletName || 'Selene wallet')}</h3>
    <p class="muted small">Network: ${network === 'chipnet' ? 'Chipnet testnet' : 'BCH Mainnet'}</p>
    <p class="wallet-address-label">WizardConnect receive address (index ${wallet.receiveIndex})</p>
    <code class="addr" id="walletAddress">${esc(addr || 'Address unavailable')}</code>
    <button class="ghost sm" id="copyWalletAddress" ${addr ? '' : 'disabled'}>Copy address</button>
    <div class="wallet-address-check">
      <button class="ghost sm" id="checkWalletFunding" ${addr ? '' : 'disabled'}>Check BCH funding</button>
      <p class="muted small" id="walletFundingResult">Checks BCH coins at the connected address on the selected network. It does not move funds.</p>
    </div>
    <div class="wallet-address-check">
      <label for="seleneReceiveAddress">Match the receive address shown in Selene</label>
      <input id="seleneReceiveAddress" class="addr-input" placeholder="Paste Selene BCH receive address" autocomplete="off" />
      <button class="ghost sm" id="matchSeleneAddress">Find matching WizardConnect address</button>
      <p class="muted small" id="addressMatchResult">Checks receive indices 0–50 from the WizardConnect xpub. No private keys are requested.</p>
    </div>
    <div class="wallet-menu-actions">
      <button class="ghost" id="closeWalletDetails">Close</button>
      <button class="danger" id="disconnectWallet">Disconnect wallet</button>
    </div>
    <p class="muted small">Disconnecting is separate from viewing your wallet details.</p>
  </div>`;
  m.classList.add('show');
  $('#closeWalletDetails', m).onclick = () => m.classList.remove('show');
  const copy = $('#copyWalletAddress', m);
  if (copy && addr) copy.onclick = () => navigator.clipboard.writeText(addr);
  $('#checkWalletFunding', m).onclick = async () => {
    const result = $('#walletFundingResult', m);
    result.textContent = 'Checking the selected network…';
    try {
      const funding = await inspectWalletFunding(network, addr!);
      const coins = funding.utxos.slice(0, 8).map((u) =>
        `vout ${u.vout}: ${u.satoshis.toString()} sats · ${u.txid.slice(0, 12)}…`
      );
      result.textContent = funding.count === 0
        ? 'No ordinary BCH coins found at this address on this network. No funds were moved.'
        : `Found ${funding.count} BCH coin(s), total ${funding.total.toString()} sats. CashTokens-eligible genesis coins: ${funding.eligible.length}. ${coins.join(' | ')}${funding.utxos.length > 8 ? ' | More coins not shown' : ''}`;
    } catch (e: any) {
      result.textContent = `Could not inspect BCH funding: ${String(e.message || e)}`;
    }
  };
  $('#matchSeleneAddress', m).onclick = () => {
    const field = $<HTMLInputElement>('#seleneReceiveAddress', m);
    const result = $('#addressMatchResult', m);
    const entered = field.value.trim();
    if (!entered) { result.textContent = 'Paste the receive address shown in Selene first.'; return; }
    try {
      const index = wallet.matchReceiveAddress(entered, network, 50);
      if (index === null) {
        result.textContent = 'No match in receive indices 0–50. Do not send funds; we need to inspect Selene’s exported public derivation details.';
      } else {
        result.textContent = `Matched Selene to WizardConnect receive index ${index}. AjoChain will now display and sign with this same index.`;
        openWalletDetails();
      }
    } catch (e: any) { result.textContent = String(e.message || e); }
  };
  $('#disconnectWallet', m).onclick = async () => {
    if (!confirm('Disconnect your wallet from AjoChain?')) return;
    m.classList.remove('show');
    await wallet.disconnect();
  };
}

let lastWalletState = wallet.state;
wallet.onChange(() => {
  renderHeader();
  if ($('#modal').classList.contains('show')) void renderWalletModal();
  const previousState = lastWalletState;
  lastWalletState = wallet.state;
  const connectionSettled = wallet.state === 'connected' || wallet.state === 'disconnected' ||
    (wallet.state === 'idle' && previousState === 'disconnecting');
  if (connectionSettled && (location.hash.startsWith('#/c/') || location.hash.startsWith('#/p/') ||
      location.hash.startsWith('#/create') || location.hash.startsWith('#/pusd/create'))) route();
});

function roundTrack(names: string[], round: number | null, completed: boolean) {
  return `<ol class="track">${names.map((n, i) => { const cls = completed || (round !== null && i < round) ? 'done' : round === i ? 'now' : ''; return `<li class="${cls}"><span class="dot">${cls === 'done' ? '✓' : i + 1}</span><span class="nm">${esc(n)}</span></li>`; }).join('')}</ol>`;
}
function potBar(avail: bigint, pot: bigint) {
  const pct = pot > 0n ? Math.min(100, Number((avail * 100n) / pot)) : 0;
  return `<div class="pot"><div class="pot-top"><span>Pot this round</span><b>${bch(avail)} / ${bch(pot)} BCH</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
}
function howItWorks() {
  return `<section class="card how"><p class="kicker">Simple by design</p><h2>How AjoChain works</h2><ol class="steps"><li><b>Create.</b> Set the members and contribution amount.</li><li><b>Lock.</b> The BCH covenant enforces the payout order.</li><li><b>Contribute.</b> Members send their share to the circle address.</li><li><b>Pay out.</b> When the pot is full, anyone can trigger the next payout.</li></ol><details class="advanced"><summary>Technical details</summary><pre class="diagram">members ──contribute──▶ [ AjoCircle covenant ] ──payout──▶ member[round]\n                         │ state NFT: round=r │\n                         └──── round r+1 ◀───┘</pre><p class="muted small">Open source · MVP · unaudited · Chipnet first.</p></details></section>`;
}

function renderHome() {
  const bchCount = JSON.parse(localStorage.getItem('ajo-circles') || '[]').length;
  const pusdCount = JSON.parse(localStorage.getItem('ajo-pusd-circles') || '[]').length;
  app.innerHTML = `<section class="hero hero-clean"><p class="kicker">A simpler way to save together</p><h1>Your circle. <span>Your turn. On-chain.</span></h1><p class="lede">Create a shared savings circle, invite your members, and let Bitcoin Cash smart contracts enforce the payout order. No treasurer needed.</p><div class="cta"><a class="btn" href="#/create">Start a circle <span aria-hidden="true">→</span></a><a class="btn ghost" href="#/mine">Open dashboard</a></div><div class="home-stats"><div><b>${bchCount + pusdCount}</b><span>Saved circles</span></div><div><b>${network === 'chipnet' ? 'Chipnet' : 'Mainnet'}</b><span>Selected network</span></div></div></section><section class="feature-grid home-options"><article class="card feature"><span class="feature-icon">₿</span><h3>BCH savings circle</h3><p>Run a rotating savings circle with BCH. Mainnet uses real funds; proceed carefully.</p><a href="#/create/bch">Create with BCH →</a></article><article class="card feature"><span class="feature-icon">$</span><h3>PUSD savings circle</h3><p>Experimental CashTokens flow with a separate BCH fee reserve. Chipnet only.</p><a href="#/create/pusd">Create with PUSD →</a></article><article class="card feature"><span class="feature-icon">◎</span><h3>BCH member-credit v2</h3><p>Experimental member-specific credits and rollover. Separate Chipnet prototype; not compatible with v1 circles.</p><a href="#/v2/create">Explore v2 prototype →</a></article></section><section class="trust-strip"><span class="trust-mark">✓</span><p><b>Rules enforced by code.</b><br/><span class="muted">The contract controls the payout order. You can inspect every transaction on-chain.</span></p></section>`;
}

function renderCreate() {
  const wantsPusd = new URLSearchParams(location.hash.split('?')[1] || '').get('asset') === 'pusd';
  app.innerHTML = `<section class="card create-choice"><p class="kicker">New circle</p><h2>Choose your savings asset</h2><p class="muted">Select how your group wants to contribute. Your network is controlled from the header.</p><div class="choice-grid"><a class="choice ${!wantsPusd ? 'selected' : ''}" href="#/create/bch"><span>₿</span><div><b>BCH Ajo</b><small>${network === 'chipnet' ? 'Chipnet test network' : 'BCH Mainnet · real funds'}</small></div></a><a class="choice ${wantsPusd ? 'selected' : ''}" href="#/create/pusd"><span>$</span><div><b>PUSD Ajo</b><small>Experimental · Chipnet transactions only</small></div></a></div>${wantsPusd ? '<p class="note">PUSD shares the network selector with BCH, but Mainnet creation and spending remain disabled until the PUSD deployment is independently verified.</p>' : ''}</section>`;
}

function renderBchCreate() {
  const saved = JSON.parse(localStorage.getItem('ajo-draft') || 'null');
  const addr = wallet.state === 'connected' ? wallet.address(network) : null;
  const rows = saved?.members?.length ? saved.members : [addr || '', '', ''];
  app.innerHTML = `<section class="card"><p class="kicker">BCH circle · ${network === 'chipnet' ? 'Chipnet test' : 'Mainnet'}</p><h2>Start an Ajo circle</h2><form id="f"><label>Circle name<input name="name" required maxlength="60" value="${esc(saved?.name || 'Our Ajo')}" /></label><label>Each member pays (BCH, per round)<input name="amt" required inputmode="decimal" value="${esc(saved?.amt || '0.001')}" /></label><fieldset><legend>Members, in payout order (${MIN_MEMBERS}–${MAX_MEMBERS})</legend><div id="mrows">${rows.map((m: string, i: number) => memberRow(m, i)).join('')}</div><button type="button" class="ghost sm" id="addM">+ Add member</button></fieldset><details><summary>Advanced</summary><label>Max miner fee per payout (sats)<input name="fee" value="${esc(saved?.fee || DEFAULT_MAX_FEE.toString())}" /></label><label>Genesis txid (manual state NFT)<input name="cat" placeholder="64 hex chars" value="" /></label></details><p class="err" id="ferr"></p><button class="btn" type="submit">${addr ? 'Start circle with my wallet' : 'Connect wallet & start'}</button></form><p class="muted small">Members can contribute from any BCH wallet. The covenant controls the payout order.</p></section>`;
  $('#addM').onclick = () => { const c = $('#mrows'); if (c.children.length < MAX_MEMBERS) c.insertAdjacentHTML('beforeend', memberRow('', c.children.length)); };
  const form = $<HTMLFormElement>('#f');
  form.onsubmit = async (ev) => { ev.preventDefault(); const err = $('#ferr'); err.textContent = ''; const fd = new FormData(form); const members = (fd.getAll('m') as string[]).map((s) => s.trim()).filter(Boolean); localStorage.setItem('ajo-draft', JSON.stringify({ name: fd.get('name'), amt: fd.get('amt'), fee: fd.get('fee'), members })); try { if (network !== 'chipnet' && !confirm('You are creating on BCH Mainnet. This is unaudited software using real BCH. Continue?')) return; if (members.length < MIN_MEMBERS) throw new Error(`Add at least ${MIN_MEMBERS} members`); members.forEach(addressToPkh); const contribution = BigInt(Math.round(parseFloat(String(fd.get('amt'))) * 1e8)); if (contribution <= 0n) throw new Error('Contribution must be positive'); const base = { name: String(fd.get('name')), network, members, contribution, maxFee: BigInt(String(fd.get('fee') || DEFAULT_MAX_FEE)) }; const cat = String(fd.get('cat') || '').trim().toLowerCase(); if (cat) { const p = { ...base, stateCategory: cat }; circleContract(p, offline(p.network)); saveCircle(p); location.hash = `#/c/${encodeCircle(p)}?manual=1`; return; } const a = wallet.state === 'connected' ? wallet.address(network) : null; if (!a) { openWalletModal(); throw new Error('Connect your wallet to sign the start transaction.'); } err.textContent = 'Preparing transaction…'; const g = await planGenesis(base, a); err.textContent = 'Approve in your wallet…'; await wallet.signAndBroadcast(g.wc, g.walletInputs, `Start Ajo circle "${base.name}"`, base.network); saveCircle(g.params); localStorage.removeItem('ajo-draft'); location.hash = `#/c/${encodeCircle(g.params)}`; } catch (e: any) { err.textContent = String(e.message || e); } };
}
const memberRow = (v: string, i: number) => `<input class="maddr" name="m" placeholder="${network === 'chipnet' ? 'bchtest:q…' : 'bitcoincash:q…'} (member ${i + 1})" value="${esc(v)}" autocomplete="off" />`;
function saveCircle(p: CircleParams) { const list: string[] = JSON.parse(localStorage.getItem('ajo-circles') || '[]'); const e = encodeCircle(p); if (!list.includes(e)) list.unshift(e); localStorage.setItem('ajo-circles', JSON.stringify(list.slice(0, 20))); }

const encodePusdLink = (p: PusdCircleParams) => btoa(unescape(encodeURIComponent(JSON.stringify({ ...p, contribution: p.contribution.toString() })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodePusdLink = (s: string): PusdCircleParams => { const raw = decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); const p = JSON.parse(raw); return { ...p, contribution: BigInt(p.contribution) }; };
function renderPusdCreate() {
  const addr = wallet.state === 'connected' ? wallet.address(network) : null;
  app.innerHTML = `<section class="card"><p class="kicker">PUSD circle · experimental</p><div class="status-row"><h2>Create a PUSD Ajo circle</h2><span class="tag gold">Chipnet only</span></div><p class="muted">PUSD uses a CashTokens state NFT plus a separate BCH reserve for miner fees. It is unaudited and not enabled for Mainnet transactions.</p>${network === 'mainnet' ? '<div class="note"><b>Mainnet selected.</b> The network switch is shared with BCH, but PUSD creation stays blocked until its Mainnet contract/category is verified.</div>' : ''}<form id="pf"><label>Circle name<input name="name" required maxlength="60" value="Our PUSD Ajo"/></label><label>Contribution per member (PUSD base units)<input name="amount" type="number" min="1" step="1" required value="1000000"/></label><fieldset><legend>Members in payout order (2–5)</legend><div id="pmembers">${[addr || '', '', ''].map((v, i) => memberRow(v, i)).join('')}</div><button type="button" class="ghost sm" id="padd">+ Add member</button></fieldset><label>BCH fee reserve (sats)<input name="reserve" type="number" min="1000" step="1" value="${PUSD_DEFAULT_RESERVE}"/></label><p class="err" id="perr"></p><button class="btn" type="submit" ${network === 'mainnet' ? 'disabled' : ''}>${network === 'mainnet' ? 'PUSD Mainnet unavailable' : addr ? 'Create PUSD circle' : 'Connect wallet & create'}</button></form></section>`;
  $('#padd').onclick = () => { const el = $('#pmembers'); if (el.children.length < 5) el.insertAdjacentHTML('beforeend', memberRow('', el.children.length)); };
  $<HTMLFormElement>('#pf').onsubmit = async (ev) => { ev.preventDefault(); const err = $('#perr'); err.textContent = ''; try { if (network !== 'chipnet') throw new Error('PUSD is currently available on Chipnet only. Switch to Chipnet to create or use a PUSD circle.'); const fd = new FormData($<HTMLFormElement>('#pf')); const members = (fd.getAll('m') as string[]).map(x => x.trim()).filter(Boolean); if (members.length < 2 || members.length > 5) throw new Error('Enter 2–5 member addresses'); const amount = BigInt(String(fd.get('amount'))); if (amount <= 0n) throw new Error('Contribution must be positive'); const base = { name: String(fd.get('name')), network, members, contribution: amount, pusdCategory: PUSD_CATEGORY }; const a = wallet.state === 'connected' ? wallet.address(network) : null; if (!a) { openWalletModal(); throw new Error('Connect your wallet first'); } err.textContent = 'Preparing PUSD state NFT and BCH fee reserve…'; const g = await planPusdGenesis(base, a, BigInt(String(fd.get('reserve')))); err.textContent = 'Approve the creation transaction in your wallet…'; await wallet.signAndBroadcast(g.wc, g.walletInputs, 'Create PUSD Ajo circle', g.params.network); const p = g.params; savePusdCircle(p); location.hash = `#/p/${encodePusdLink(p)}`; } catch (e: any) { err.textContent = String(e.message || e); } };
}
function savePusdCircle(p: PusdCircleParams) { const list: string[] = JSON.parse(localStorage.getItem('ajo-pusd-circles') || '[]'); const e = encodePusdLink(p); if (!list.includes(e)) list.unshift(e); localStorage.setItem('ajo-pusd-circles', JSON.stringify(list.slice(0, 20))); }

async function renderPusdCircle(encoded: string) {
  let p: PusdCircleParams; try { p = decodePusdLink(encoded); } catch { app.innerHTML = '<section class="card"><p class="err">Invalid PUSD circle link.</p></section>'; return; }
  // Opening an invite link adds this circle to the visitor's local dashboard.
  savePusdCircle(p);
  if (p.network !== network) { network = p.network; localStorage.setItem('ajo-net', network); renderHeader(); }
  if (p.network === 'mainnet') { app.innerHTML = `<section class="card"><span class="tag gold">Experimental</span><h2>${esc(p.name)}</h2><div class="note"><b>PUSD Mainnet is not enabled.</b> This circle was created with an unsupported network setting. Switch to Chipnet or use a verified PUSD Mainnet deployment.</div><a class="btn" href="#/mine">Back to my circles</a></section>`; return; }
  const offlineContract = pusdContract(p, offline(p.network)); let provider: Awaited<ReturnType<typeof getProvider>> | null = null; let contract = offlineContract;
  app.innerHTML = `<section class="card"><div class="status-row"><div><p class="kicker">Chipnet · experimental PUSD</p><h2>${esc(p.name)}</h2></div><span class="tag gold">Test only</span></div><p class="muted">${p.members.length} members · ${p.contribution.toString()} PUSD base units each per round</p><p>Contract: <code class="addr">${contract.address}</code></p><div id="pstatus"><p class="muted">Reading circle UTXOs…</p></div><div class="actions"><button class="ghost sm" id="prefresh">Refresh</button>${wallet.state === 'connected' ? '<button class="sm" id="pcontribute">Contribute PUSD</button>' : ''}</div><p class="err" id="plerr"></p></section>`;
  const load = async () => { try { if (!provider) { provider = await getProvider(p.network); contract = pusdContract(p, provider); } const utxos = await contract.getUtxos(); const s = pusdStatus(p, utxos); $('#pstatus').innerHTML = `<div class="mini-stats"><div><span>Round</span><b>${s.round === null ? 'Not started' : `${s.round + 1} / ${p.members.length}`}</b></div><div><span>Collected</span><b>${s.available.toString()}</b></div><div><span>Fee reserve</span><b>${s.reserveUtxos.length} UTXOs</b></div></div><p><b>Next recipient:</b> ${s.round === null ? '—' : `Member ${s.round + 1}`}</p><div class="actions"><button class="btn" id="ppayout" ${s.ready ? '' : 'disabled'}>Pay out PUSD round</button></div>`; $('#ppayout').onclick = async () => { try { const result = buildPusdPayout(p, contract, utxos, provider!); const txid = await provider!.sendRawTransaction(result.builder.build()); $('#plerr').innerHTML = `PUSD payout broadcast: <a href="${explorerTx(p.network, txid)}" target="_blank" rel="noopener">View transaction</a>`; setTimeout(load, 2500); } catch (e: any) { $('#plerr').textContent = String(e.message || e); } }; } catch (e: any) { $('#pstatus').innerHTML = `<p class="err">${esc(String(e.message || e))}</p>`; } };
  $('#prefresh').onclick = load; const pc = $('#pcontribute'); if (pc) pc.onclick = async () => { try { const a = wallet.address(p.network)!; const c = await planPusdContribution(p, a); await wallet.signAndBroadcast(c.wc, c.walletInputs, 'PUSD circle contribution', p.network); setTimeout(load, 2500); } catch (e: any) { $('#plerr').textContent = String(e.message || e); } }; await load();
}

async function renderCircle(encoded: string, manual: boolean) {
  let p: CircleParams; try { p = decodeCircle(encoded); } catch { app.innerHTML = '<section class="card"><p class="err">This circle link is broken.</p></section>'; return; }
  // Opening an invite link adds this circle to the visitor's local dashboard.
  saveCircle(p);
  if (p.network !== network) { network = p.network; localStorage.setItem('ajo-net', network); renderHeader(); }
  const contract0 = circleContract(p, offline(p.network)); let prov: Awaited<ReturnType<typeof getProvider>> | null = null; let contract = contract0; const names = p.members.map((m, i) => `Member ${i + 1}`); const uri = `${contract.address}?amount=${bch(p.contribution)}`; const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  app.innerHTML = `<section class="card"><div class="status-row"><div><p class="kicker">${p.network === 'chipnet' ? 'Chipnet test' : 'BCH Mainnet'} circle</p><h2>${esc(p.name)}</h2></div><span class="tag ${p.network === 'chipnet' ? 'green' : 'gold'}">${p.network === 'chipnet' ? 'Test' : 'Mainnet'}</span></div><p class="muted">${p.members.length} members · ${bch(p.contribution)} BCH each per round</p><div id="live"><p class="muted">Reading the chain…</p></div><div class="contrib"><img class="qr" src="${qr}" alt="Circle contribution QR code"/><div><p><b>Circle contribution address</b></p><p class="muted small">This is the circle\u2019s smart-contract address, not the organiser\u2019s personal wallet. Members can send BCH here from any compatible BCH wallet; they do not need to connect to AjoChain first.</p><code class="addr" id="caddr">${contract.address}</code><div class="actions"><button class="ghost sm" id="copyAddr">Copy contribution address</button><button class="ghost sm" id="copyLink">Copy invite link</button>${wallet.state === 'connected' ? '<button class="sm" id="wcPay">Pay my share</button>' : ''}</div><p class="muted small">Any excess BCH stays in the circle and carries forward toward the next round. The app tracks the group\u2019s total balance, not individual member credit.</p></div></div>${manual ? `<details class="advanced"><summary>Manual state NFT setup</summary><div class="note">Spend output #0 of tx <code>${p.stateCategory.slice(0, 12)}…</code> to create a mutable NFT with commitment <code>00</code>, 1000 sats, sent to <code class="addr">${contract.tokenAddress}</code>.</div></details>` : ''}<p class="err" id="lerr"></p></section>`;
  $('#copyAddr').onclick = () => navigator.clipboard.writeText(contract.address); $('#copyLink').onclick = () => navigator.clipboard.writeText(location.href.split('?')[0]);
  const wp = $('#wcPay'); if (wp) wp.onclick = async () => { try { const a = wallet.address(p.network)!; const c = await planContribution(p, contract, a); await wallet.signAndBroadcast(c.wc, c.walletInputs, 'Ajo contribution', p.network); setTimeout(load, 2500); } catch (e: any) { $('#lerr').textContent = String(e.message || e); } };
  const load = async () => { const live = $('#live'); try { if (!prov) { prov = await getProvider(p.network); contract = circleContract(p, prov); } const utxos = await contract.getUtxos(); const s = circleStatus(p, utxos); live.innerHTML = `${s.round === null ? '<p class="note">Not started yet: the circle-state NFT is not at the contract address (or is still unconfirmed).</p>' : roundTrack(names, s.round, s.completed)}${potBar(s.available, s.pot)}${s.recipient ? `<p class="turn">This round goes to <b>Member ${s.recipientIndex! + 1}</b> <small>${short(s.recipient)}</small></p>` : ''}<ul class="members">${p.members.map((m, i) => `<li><span class="av">${i + 1}</span><span class="who"><b>Member ${i + 1}</b><small>${short(m)}</small></span></li>`).join('')}</ul><div class="actions"><button class="btn" id="lpay" ${s.ready ? '' : 'disabled'}>${s.completed ? 'Circle complete' : 'Pay out this round'}</button><button class="ghost" id="lref">Refresh</button></div>`; $('#lref').onclick = load; $('#lpay').onclick = async () => { try { const r = buildPayout(p, contract, await contract.getUtxos(), prov!); const txid = await prov!.sendRawTransaction(r.builder.build()); $('#lerr').innerHTML = `Paid! <a href="${explorerTx(p.network, txid)}" target="_blank" rel="noopener">View transaction</a>`; setTimeout(load, 2500); } catch (e: any) { $('#lerr').textContent = String(e.message || e); } }; } catch (e: any) { live.innerHTML = `<p class="err">Could not read the ${p.network} chain: ${esc(String(e.message || e))}</p><button class="ghost" id="lref">Retry</button>`; $('#lref').onclick = load; } }; load();
}


const encodeV2Link = (p: V2CircleParams) => btoa(unescape(encodeURIComponent(JSON.stringify({ ...p, contribution: p.contribution.toString(), maxFee: p.maxFee.toString() })))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const decodeV2Link = (encoded: string): V2CircleParams => {
  const raw = decodeURIComponent(escape(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))));
  const p = JSON.parse(raw);
  if (p.version !== 2 || typeof p.stateCategory !== 'string' || !Array.isArray(p.members)) throw new Error('This is not a valid v2 circle link.');
  return { ...p, contribution: BigInt(p.contribution), maxFee: BigInt(p.maxFee) };
};
function saveV2Circle(p: V2CircleParams) {
  const list: string[] = JSON.parse(localStorage.getItem('ajo-v2-circles') || '[]');
  const encoded = encodeV2Link(p);
  if (!list.includes(encoded)) list.unshift(encoded);
  localStorage.setItem('ajo-v2-circles', JSON.stringify(list.slice(0, 20)));
}
function renderV2Create() {
  const addr = wallet.state === 'connected' ? wallet.address(network) : null;
  app.innerHTML = `<section class="card"><p class="kicker">BCH member-credit v2 · experimental</p><h2>Create a v2 circle</h2><p class="note"><b>Chipnet only.</b> This is a separate prototype with on-chain member receipts. It is not audited, does not support PUSD or cancellation, and must not be used with real BCH.</p><form id="v2f"><label>Circle name<input name="name" required maxlength="60" value="Our Ajo v2"/></label><label>Contribution per member (BCH)<input name="amount" required inputmode="decimal" value="0.001"/></label><fieldset><legend>Members in payout order (2–5)</legend><div id="v2members">${[addr || '', '', ''].map((v, i) => memberRow(v, i)).join('')}</div><button type="button" class="ghost sm" id="v2add">+ Add member</button></fieldset><label>Maximum miner fee per transaction (sats)<input name="fee" type="number" min="0" step="1" value="10000"/></label><p class="err" id="v2err"></p><button class="btn" type="submit" ${network === 'chipnet' ? '' : 'disabled'}>${network === 'chipnet' ? 'Create v2 circle' : 'Switch to Chipnet to continue'}</button></form><a class="ghost btnlink" href="#/">Back home</a></section>`;
  $('#v2add').onclick = () => { const el = $('#v2members'); if (el.children.length < 5) el.insertAdjacentHTML('beforeend', memberRow('', el.children.length)); };
  $<HTMLFormElement>('#v2f').onsubmit = async ev => {
    ev.preventDefault(); const err = $('#v2err'); err.textContent = '';
    try {
      if (network !== 'chipnet') throw new Error('The v2 prototype is Chipnet-only. Switch networks before creating it.');
      const fd = new FormData($<HTMLFormElement>('#v2f'));
      const members = (fd.getAll('m') as string[]).map(x => x.trim()).filter(Boolean);
      if (members.length < 2 || members.length > 5) throw new Error('Enter 2–5 member addresses.');
      members.forEach(addressToPkh);
      const raw = Number(fd.get('amount'));
      if (!Number.isFinite(raw) || raw <= 0 || raw * 1e8 > Number.MAX_SAFE_INTEGER) throw new Error('Enter a valid BCH contribution amount.');
      const contribution = BigInt(Math.round(raw * 1e8));
      const draft = { version: 2 as const, name: String(fd.get('name')).trim(), network, members, contribution, maxFee: BigInt(String(fd.get('fee') || '0')) };
      if (!wallet.address(network)) { openWalletModal(); throw new Error('Connect your Selene wallet to create the circle.'); }
      err.textContent = 'Preparing v2 genesis and member receipt NFTs…';
      const g = await planV2Genesis(draft, wallet.address(network)!);
      err.textContent = 'Approve the v2 creation transaction in Selene…';
      await wallet.signAndBroadcast(g.wc, g.walletInputs, `Create v2 Ajo circle "${draft.name}"`, network);
      saveV2Circle(g.params);
      location.hash = `#/v2/${encodeV2Link(g.params)}`;
    } catch (e: any) { err.textContent = String(e.message || e); }
  };
}
async function renderV2Circle(encoded: string) {
  let p: V2CircleParams;
  try { p = decodeV2Link(encoded); } catch (e: any) { app.innerHTML = `<section class="card"><p class="err">${esc(String(e.message || e))}</p></section>`; return; }
  if (p.network !== 'chipnet') { app.innerHTML = '<section class="card"><p class="err">V2 circles are Chipnet-only.</p><a href="#/">Back home</a></section>'; return; }
  saveV2Circle(p);
  if (network !== p.network) { network = p.network; localStorage.setItem('ajo-net', network); renderHeader(); }
  const myAddress = wallet.state === 'connected' ? wallet.address(network) : null;
  const myIndex = myAddress ? p.members.findIndex(m => { try { return Array.from(addressToPkh(m)).join(',') === Array.from(addressToPkh(myAddress)).join(','); } catch { return false; } }) : -1;
  app.innerHTML = `<section class="card"><div class="status-row"><div><p class="kicker">Chipnet · v2 member-credit prototype</p><h2>${esc(p.name)}</h2></div><span class="tag gold">Experimental</span></div><p class="muted">${p.members.length} members · ${bch(p.contribution)} BCH each per round</p><p class="small muted">V2 link version: 2 · Category: <code>${esc(p.stateCategory)}</code></p><div id="v2status"><p class="muted">Reading member receipts…</p></div><div class="actions"><button class="ghost" id="v2refresh">Refresh</button><button class="ghost" id="v2copy">Copy invite link</button></div><div id="v2depositArea">${myIndex >= 0 ? `<label>Deposit amount (BCH)<input id="v2depositAmount" inputmode="decimal" value="${bch(p.contribution)}"/></label><button class="btn" id="v2deposit">Add credit for Member ${myIndex + 1}</button>` : '<p class="muted small">Connect the wallet registered for a member slot to add member-specific credit.</p>'}</div><p class="err" id="v2err"></p><p class="muted small">Prototype only: no cancellation or PUSD support. Never use real BCH.</p></section>`;
  $('#v2copy').onclick = () => navigator.clipboard.writeText(location.href);
  const load = async () => {
    const status = $('#v2status');
    try {
      const state = await readV2Circle(p);
      status.innerHTML = `<div class="mini-stats"><div><span>Round</span><b>${state.round + 1} / ${p.members.length}</b></div><div><span>State reserve</span><b>${bch(state.stateSatoshis)} BCH</b></div><div><span>Next recipient</span><b>Member ${state.round + 1}</b></div></div><h3>Verified on-chain member credits</h3><ul class="members">${state.credits.map((credit, i) => `<li><span class="av">${i + 1}</span><span class="who"><b>Member ${i + 1}</b><small>${short(p.members[i])}</small></span><strong>${bch(credit)} BCH</strong></li>`).join('')}</ul><p class="note">${state.ready ? 'All members have enough credit for this round.' : 'Payout is locked until every member has at least one full contribution in their own receipt.'}</p><button class="btn" id="v2payout" ${state.ready ? '' : 'disabled'}>Pay out this round</button>`;
      $('#v2payout').onclick = async () => {
        try { $('#v2err').textContent = 'Preparing payout…'; const result = await planV2Payout(p); const provider = await getProvider(p.network); const txid = await provider.sendRawTransaction(result.builder.build()); $('#v2err').innerHTML = `Payout broadcast: <a href="${explorerTx(p.network, txid)}" target="_blank" rel="noopener">View transaction</a>`; setTimeout(load, 2500); }
        catch (e: any) { $('#v2err').textContent = String(e.message || e); }
      };
    } catch (e: any) { status.innerHTML = `<p class="err">${esc(String(e.message || e))}</p>`; }
  };
  $('#v2refresh').onclick = load;
  const deposit = $('#v2deposit');
  if (deposit) deposit.onclick = async () => {
    try {
      if (wallet.state !== 'connected' || !wallet.address(network)) throw new Error('Connect the registered member wallet first.');
      const amount = Number($<HTMLInputElement>('#v2depositAmount').value);
      if (!Number.isFinite(amount) || amount <= 0 || amount * 1e8 > Number.MAX_SAFE_INTEGER) throw new Error('Enter a valid BCH amount.');
      const sats = BigInt(Math.round(amount * 1e8));
      $('#v2err').textContent = 'Preparing member-specific deposit…';
      const plan = await planV2Deposit(p, myIndex, sats, wallet.address(network)!);
      await wallet.signAndBroadcast(plan.wc, plan.walletInputs, 'Add credit to your v2 member receipt', network);
      $('#v2err').textContent = 'Deposit broadcast. Waiting for confirmation…';
      setTimeout(load, 3000);
    } catch (e: any) { $('#v2err').textContent = String(e.message || e); }
  };
  await load();
}

function renderMine() {
  const bchList: string[] = JSON.parse(localStorage.getItem('ajo-circles') || '[]'); const pusdList: string[] = JSON.parse(localStorage.getItem('ajo-pusd-circles') || '[]'); const v2List: string[] = JSON.parse(localStorage.getItem('ajo-v2-circles') || '[]');
  const bchItems = bchList.map((e) => { try { const p = decodeCircle(e); return `<li><span class="av">₿</span><span class="who"><b><a href="#/c/${e}">${esc(p.name)}</a></b><small>${p.network} · ${p.members.length} members · ${bch(p.contribution)} BCH</small></span><span class="tag ${p.network === 'chipnet' ? 'green' : 'gold'}">${p.network}</span></li>`; } catch { return ''; } }).join('');
  const pusdItems = pusdList.map((e) => { try { const p = decodePusdLink(e); return `<li><span class="av">$</span><span class="who"><b><a href="#/p/${e}">${esc(p.name)}</a></b><small>Chipnet · ${p.members.length} members · ${p.contribution.toString()} PUSD units</small></span><span class="tag gold">PUSD</span></li>`; } catch { return ''; } }).join('');
  const v2Items = v2List.map((e) => { try { const p = decodeV2Link(e); return `<li><span class="av">◎</span><span class="who"><b><a href="#/v2/${e}">${esc(p.name)}</a></b><small>Chipnet · ${p.members.length} members · ${bch(p.contribution)} BCH · v2 receipts</small></span><span class="tag gold">V2 test</span></li>`; } catch { return ''; } }).join('');
  app.innerHTML = `<section class="card"><div class="status-row"><div><p class="kicker">Dashboard</p><h2>My circles</h2></div><a class="btn sm" href="#/create">+ New</a></div>${bchItems || pusdItems || v2Items ? `<ul class="members circle-list">${bchItems}${pusdItems}${v2Items}</ul>` : '<div class="empty"><div class="empty-icon">◎</div><h3>No circles yet</h3><p class="muted">Create your first savings circle and it will appear here.</p><a class="btn" href="#/create">Create a circle</a></div>'}</section>`;
}

function route() {
  renderHeader();
  const h = location.hash || '#/';
  document.querySelectorAll('nav a').forEach((a) => { const href = (a as HTMLAnchorElement).getAttribute('href')!; const active = href === '#/' ? h === '#/' : h.startsWith(href); a.classList.toggle('on', active); });
  if (h === '#/create' || h.startsWith('#/create?')) return renderCreate();
  if (h.startsWith('#/create/bch')) return renderBchCreate();
  if (h.startsWith('#/create/pusd')) return renderPusdCreate();
  if (h.startsWith('#/pusd/create')) return renderPusdCreate();
  if (h.startsWith('#/p/')) return renderPusdCircle(h.slice(4));
  if (h === '#/v2/create') return renderV2Create();
  if (h.startsWith('#/v2/')) return renderV2Circle(h.slice(4));
  if (h.startsWith('#/mine')) return renderMine();
  if (h.startsWith('#/c/')) { const [enc, q] = h.slice(4).split('?'); return renderCircle(enc, q === 'manual=1'); }
  return renderHome();
}
window.addEventListener('hashchange', route);
wallet.tryResume();
route();
