import './style.css';
import QRCode from 'qrcode';
import {
  circleContract, circleStatus, buildPayout, encodeCircle, decodeCircle, addressToPkh,
  DEFAULT_MAX_FEE, MAX_MEMBERS, MIN_MEMBERS, type CircleParams, type Net,
} from '../../src/lib/ajo';
import { DemoCircle, DEMO_NAMES } from './demo';
import { wallet } from './wallet';
import { getProvider, explorerTx, planGenesis, planContribution } from './chain';
import { MockNetworkProvider } from 'cashscript';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const app = $('#app');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const bch = (sats: bigint) => (Number(sats) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
const short = (a: string) => { const [p, r] = a.split(':'); return `${p}:${r.slice(0, 6)}…${r.slice(-5)}`; };

/** Offline provider used only to derive addresses with the right network prefix. */
const offline = (net: Net) => { const m = new MockNetworkProvider(); (m as any).network = net; return m; };

let network: Net = (localStorage.getItem('ajo-net') as Net) || 'chipnet';

// ---------- header / wallet ----------
function renderHeader() {
  const w = wallet;
  const addr = w.state === 'connected' ? w.address(network) : null;
  $('#hdr').innerHTML = `
    <a class="brand" href="#/"><span class="logo">◎</span> AjoChain</a>
    <div class="hdr-right">
      <button class="net ${network}" id="netBtn" title="Switch network">${network === 'chipnet' ? 'Chipnet (test)' : 'Mainnet'}</button>
      ${w.state === 'connected'
        ? `<button class="wallet on" id="walletBtn" title="Disconnect">${esc(w.walletName || 'Wallet')} · ${addr ? short(addr) : ''}</button>`
        : `<button class="wallet" id="walletBtn">${w.state === 'connecting' ? 'Connecting…' : 'Connect wallet'}</button>`}
    </div>`;
  $('#netBtn').onclick = () => {
    const next: Net = network === 'chipnet' ? 'mainnet' : 'chipnet';
    if (next === 'mainnet' && !confirm('Mainnet uses real BCH. AjoChain is a hackathon MVP and unaudited. Switch anyway?')) return;
    network = next; localStorage.setItem('ajo-net', network); route();
  };
  $('#walletBtn').onclick = () => (w.state === 'connected' ? w.disconnect() : openWalletModal());
}

async function openWalletModal() {
  if (wallet.state !== 'connecting') wallet.connect();
  const m = $('#modal');
  m.classList.add('show');
  const draw = async () => {
    if (wallet.state === 'connected') { m.classList.remove('show'); return; }
    const qr = wallet.qrUri ? await QRCode.toDataURL(wallet.qrUri, { errorCorrectionLevel: 'M', margin: 1, width: 260 }) : '';
    m.innerHTML = `<div class="sheet">
      <h3>Connect with WizardConnect</h3>
      <p class="muted">Scan with a WizardConnect-enabled Bitcoin Cash wallet. Your keys never leave your phone.</p>
      ${qr ? `<img class="qr" src="${qr}" alt="WizardConnect pairing QR"/>` : '<p>Starting secure relay…</p>'}
      ${wallet.uri ? `<button class="ghost" id="copyWiz">Copy pairing link</button> <a class="ghost btnlink" href="${esc(wallet.uri)}">Open in wallet app</a>` : ''}
      ${wallet.error ? `<p class="err">${esc(wallet.error)}</p>` : ''}
      <button class="ghost" id="closeModal">Close</button></div>`;
    $('#closeModal', m).onclick = () => { m.classList.remove('show'); if (wallet.state !== 'connected') wallet.disconnect(); };
    const c = $('#copyWiz', m); if (c) c.onclick = () => navigator.clipboard.writeText(wallet.uri!);
  };
  draw();
}
wallet.onChange(() => { renderHeader(); if ($('#modal').classList.contains('show')) openWalletModal(); if (location.hash.startsWith('#/c/') || location.hash.startsWith('#/create')) route(); });

// ---------- shared circle widgets ----------
function roundTrack(names: string[], round: number | null, completed: boolean) {
  return `<ol class="track">${names.map((n, i) => {
    const cls = completed || (round !== null && i < round) ? 'done' : round === i ? 'now' : '';
    return `<li class="${cls}"><span class="dot">${cls === 'done' ? '✓' : i + 1}</span><span class="nm">${esc(n)}</span></li>`;
  }).join('')}</ol>`;
}
function potBar(avail: bigint, pot: bigint) {
  const pct = pot > 0n ? Math.min(100, Number((avail * 100n) / pot)) : 0;
  return `<div class="pot"><div class="pot-top"><span>Pot this round</span><b>${bch(avail)} / ${bch(pot)} BCH</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>`;
}

// ---------- Landing + demo ----------
let demo: DemoCircle | null = null;
async function renderDemo() {
  demo ??= new DemoCircle();
  const s = await demo.refresh();
  const r = s.round ?? 0;
  app.innerHTML = `
  <section class="hero">
    <p class="kicker">Built for BCH BLAZE 2026</p>
    <h1>The savings circle your mum trusts, <span>without the treasurer.</span></h1>
    <p class="lede"><b>Ajo</b> (also <i>Esusu</i>, <i>Susu</i>) is how millions of West Africans save: friends chip in every week and each week one person takes the whole pot. AjoChain lets a Bitcoin Cash contract hold the money, so nobody can run off with it.</p>
    <div class="cta"><button class="btn" id="goDemo">Try the demo ↓</button><a class="btn ghost" href="#/create">Start a real circle</a></div>
  </section>

  <section class="card" id="demo">
    <div class="card-hd"><div><p class="kicker">Live demo · runs the real contract in your browser</p>
      <h2>${esc(demo.params.name)}</h2>
      <p class="muted">5 members · 0.001 BCH each per round · ${s.completed ? 'circle complete 🎉' : `round ${r + 1} of 5`}</p></div></div>
    ${roundTrack(DEMO_NAMES, s.round, s.completed)}
    ${potBar(s.available, s.pot)}
    ${s.completed ? '' : `<p class="turn">This round’s pot goes to <b>${DEMO_NAMES[s.recipientIndex!]}</b>. The order is written into the contract.</p>`}
    <ul class="members">${DEMO_NAMES.map((n, i) => {
      const paid = demo!.paidThisRound.has(i);
      const got = demo!.payouts.find((p) => p.round === i);
      return `<li><span class="av">${n[0]}</span><span class="who"><b>${n}</b><small>${short(demo!.params.members[i])}</small></span>
        ${got ? `<span class="tag gold">Collected ${bch(got.amount)}</span>` : ''}
        ${s.completed ? '' : paid ? '<span class="tag green">Paid in ✓</span>' : `<button class="sm" data-pay="${i}">Pay 0.001</button>`}</li>`;
    }).join('')}</ul>
    <div class="actions">
      <button class="btn" id="payout" ${s.ready ? '' : 'disabled'}>${s.completed ? 'Circle complete' : s.ready ? `Pay out round ${r + 1} → ${DEMO_NAMES[s.recipientIndex!]}` : 'Pay out (waiting for the pot to fill)'}</button>
      ${s.completed ? '<button class="btn ghost" id="reset">Start over</button>' : '<button class="btn ghost danger" id="cheat">Try to cheat</button>'}
    </div>
    <p class="muted small">Anyone can press “Pay out”: no signatures needed. The covenant only lets the money go to the right member, and keeps the round counter (a CashTokens NFT) inside the contract.</p>
    <div class="log">${demo.log.slice(0, 6).map((l) => `<div class="${l.kind}">${esc(l.text)}${l.detail ? `<small>${esc(l.detail)}</small>` : ''}</div>`).join('')}</div>
  </section>

  ${howItWorks()}`;
  app.querySelectorAll<HTMLButtonElement>('[data-pay]').forEach((b) => (b.onclick = () => { demo!.addContribution(+b.dataset.pay!); renderDemo(); }));
  const po = $<HTMLButtonElement>('#payout');
  po.onclick = async () => { po.disabled = true; po.textContent = 'Checking with the contract…'; try { await demo!.payout(); } catch (e: any) { demo!.log.unshift({ kind: 'bad', text: String(e.message || e).slice(0, 160) }); } renderDemo(); };
  $('#goDemo').onclick = () => $('#demo').scrollIntoView({ behavior: 'smooth' });
  const ch = $('#cheat'); if (ch) ch.onclick = async () => { await demo!.cheat(); renderDemo(); };
  const rs = $('#reset'); if (rs) rs.onclick = () => { demo = null; renderDemo(); };
}

function howItWorks() {
  return `<section class="card how">
    <h2>How it works</h2>
    <ol class="steps">
      <li><b>Create.</b> Enter members (in payout order) and the amount. The app builds a CashScript covenant with those rules baked in.</li>
      <li><b>Start.</b> One tx locks a small “circle state” NFT in the contract. Its commitment is the current round.</li>
      <li><b>Contribute.</b> Members send their share to the circle address from any BCH wallet, or scan the QR.</li>
      <li><b>Pay out.</b> When the pot is full, anyone taps the button. The contract checks the pot goes to this round’s member and the round goes up by one.</li>
    </ol>
    <pre class="diagram">members ──contribute──▶ [ AjoCircle covenant ] ──payout──▶ member[round]
                         │ state NFT: round=r │
                         └──── round r+1 ◀───┘</pre>
    <p class="muted small">Open source · <a href="https://github.com/Afar88/Ajochain">github.com/Afar88/Ajochain</a> · MVP, unaudited, chipnet first.</p>
  </section>`;
}

// ---------- Create ----------
function renderCreate() {
  const saved = JSON.parse(localStorage.getItem('ajo-draft') || 'null');
  const addr = wallet.state === 'connected' ? wallet.address(network) : null;
  const rows = saved?.members?.length ? saved.members : [addr || '', '', ''];
  app.innerHTML = `<section class="card">
    <p class="kicker">New circle · ${network}</p><h2>Start an Ajo circle</h2>
    <form id="f">
      <label>Circle name<input name="name" required maxlength="60" value="${esc(saved?.name || 'Our Ajo')}" /></label>
      <label>Each member pays (BCH, per round)<input name="amt" required inputmode="decimal" value="${esc(saved?.amt || '0.001')}" /></label>
      <fieldset><legend>Members, in payout order (${MIN_MEMBERS}–${MAX_MEMBERS})</legend>
        <div id="mrows">${rows.map((m: string, i: number) => memberRow(m, i)).join('')}</div>
        <button type="button" class="ghost sm" id="addM">+ Add member</button></fieldset>
      <details><summary>Advanced</summary>
        <label>Max miner fee per payout (sats)<input name="fee" value="${esc(saved?.fee || DEFAULT_MAX_FEE.toString())}" /></label>
        <label>Genesis txid (only if you’ll mint the state NFT yourself)<input name="cat" placeholder="64 hex chars, a tx whose output #0 you will spend" value="" /></label>
      </details>
      <p class="err" id="ferr"></p>
      <button class="btn" type="submit">${addr ? 'Start circle with my wallet' : 'Connect wallet & start'}</button>
    </form>
    <p class="muted small">Starting a circle costs ~0.00001 BCH plus 1000 sats that stay locked with the state NFT. Members don’t need this app: they just send BCH to the circle address.</p>
  </section>`;
  const addRow = () => { const c = $('#mrows'); if (c.children.length >= MAX_MEMBERS) return; c.insertAdjacentHTML('beforeend', memberRow('', c.children.length)); };
  $('#addM').onclick = addRow;
  const form = $<HTMLFormElement>('#f');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#ferr'); err.textContent = '';
    const fd = new FormData(form);
    const members = (fd.getAll('m') as string[]).map((s) => s.trim()).filter(Boolean);
    const draft = { name: fd.get('name'), amt: fd.get('amt'), fee: fd.get('fee'), members };
    localStorage.setItem('ajo-draft', JSON.stringify(draft));
    try {
      if (members.length < MIN_MEMBERS) throw new Error(`Add at least ${MIN_MEMBERS} members`);
      members.forEach(addressToPkh);
      const contribution = BigInt(Math.round(parseFloat(String(fd.get('amt'))) * 1e8));
      const base = { name: String(fd.get('name')), network, members, contribution, maxFee: BigInt(String(fd.get('fee') || DEFAULT_MAX_FEE)) };
      const cat = String(fd.get('cat') || '').trim().toLowerCase();
      if (cat) { const p = { ...base, stateCategory: cat }; circleContract(p, offline(p.network)); saveCircle(p); location.hash = `#/c/${encodeCircle(p)}?manual=1`; return; }
      const a = wallet.state === 'connected' ? wallet.address(network) : null;
      if (!a) { openWalletModal(); throw new Error('Connect your wallet (WizardConnect) to sign the start transaction.'); }
      err.textContent = 'Preparing transaction…';
      const g = await planGenesis(base, a);
      err.textContent = 'Approve in your wallet…';
      await wallet.signAndBroadcast(g.wc, g.walletInputs, `Start Ajo circle "${base.name}"`);
      saveCircle(g.params); localStorage.removeItem('ajo-draft');
      location.hash = `#/c/${encodeCircle(g.params)}`;
    } catch (e: any) { err.textContent = String(e.message || e); }
  };
}
const memberRow = (v: string, i: number) => `<input class="maddr" name="m" placeholder="${network === 'chipnet' ? 'bchtest:q…' : 'bitcoincash:q…'} (member ${i + 1})" value="${esc(v)}" autocomplete="off" />`;

function saveCircle(p: CircleParams) {
  const list: string[] = JSON.parse(localStorage.getItem('ajo-circles') || '[]');
  const e = encodeCircle(p);
  if (!list.includes(e)) list.unshift(e);
  localStorage.setItem('ajo-circles', JSON.stringify(list.slice(0, 20)));
}

// ---------- Live circle ----------
async function renderCircle(encoded: string, manual: boolean) {
  let p: CircleParams;
  try { p = decodeCircle(encoded); } catch { app.innerHTML = '<section class="card"><p class="err">This circle link is broken.</p></section>'; return; }
  if (p.network !== network) { network = p.network; localStorage.setItem('ajo-net', network); renderHeader(); }
  // Address derivation is offline; the Electrum provider is resolved lazily in load().
  const contract0 = circleContract(p, offline(p.network));
  let prov: Awaited<ReturnType<typeof getProvider>> | null = null;
  let contract = contract0;
  const names = p.members.map((m, i) => `Member ${i + 1}`);
  const uri = `${contract.address}?amount=${bch(p.contribution)}`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  app.innerHTML = `<section class="card"><p class="kicker">${p.network} circle</p><h2>${esc(p.name)}</h2>
    <p class="muted">${p.members.length} members · ${bch(p.contribution)} BCH each per round</p>
    <div id="live"><p class="muted">Reading the chain…</p></div>
    <div class="contrib"><img class="qr" src="${qr}" alt="Contribute QR"/>
      <div><p><b>Contribute ${bch(p.contribution)} BCH</b> to the circle address:</p>
      <code class="addr" id="caddr">${contract.address}</code>
      <div class="actions"><button class="ghost sm" id="copyAddr">Copy address</button><button class="ghost sm" id="copyLink">Share circle link</button>
      ${wallet.state === 'connected' ? '<button class="sm" id="wcPay">Pay my share (wallet)</button>' : ''}</div></div></div>
    ${manual ? `<div class="note"><b>Manual start:</b> with a CashTokens wallet, spend output #0 of tx <code>${p.stateCategory.slice(0, 12)}…</code> to create a <b>mutable NFT</b> with commitment <code>00</code>, 1000 sats, sent to:<br/><code class="addr">${contract.tokenAddress}</code></div>` : ''}
    <p class="err" id="lerr"></p></section>`;
  $('#copyAddr').onclick = () => navigator.clipboard.writeText(contract.address);
  $('#copyLink').onclick = () => navigator.clipboard.writeText(location.href.split('?')[0]);
  const wp = $('#wcPay');
  if (wp) wp.onclick = async () => {
    try { const a = wallet.address(p.network)!; const c = await planContribution(p, contract, a); await wallet.signAndBroadcast(c.wc, c.walletInputs, `Ajo contribution`); setTimeout(load, 2500); }
    catch (e: any) { $('#lerr').textContent = String(e.message || e); }
  };
  const load = async () => {
    const live = $('#live');
    try {
      if (!prov) { prov = await getProvider(p.network); contract = circleContract(p, prov); }
      const utxos = await contract.getUtxos();
      const s = circleStatus(p, utxos);
      live.innerHTML = `${s.round === null ? '<p class="note">Not started yet: the circle-state NFT is not at the contract address (or still unconfirmed).</p>' : roundTrack(names, s.round, s.completed)}
        ${potBar(s.available, s.pot)}
        ${s.recipient ? `<p class="turn">This round’s pot goes to <b>Member ${s.recipientIndex! + 1}</b> <small>${short(s.recipient)}</small></p>` : ''}
        <ul class="members">${p.members.map((m, i) => `<li><span class="av">${i + 1}</span><span class="who"><b>Member ${i + 1}</b><small>${short(m)}</small></span></li>`).join('')}</ul>
        <div class="actions"><button class="btn" id="lpay" ${s.ready ? '' : 'disabled'}>${s.completed ? 'Circle complete' : 'Pay out this round'}</button><button class="ghost" id="lref">Refresh</button></div>`;
      $('#lref').onclick = load;
      $('#lpay').onclick = async () => {
        try {
          const r = buildPayout(p, contract, await contract.getUtxos(), prov!);
          const txid = await prov!.sendRawTransaction(r.builder.build());
          $('#lerr').innerHTML = `Paid! <a href="${explorerTx(p.network, txid)}" target="_blank" rel="noopener">View transaction</a>`;
          setTimeout(load, 2500);
        } catch (e: any) { $('#lerr').textContent = String(e.message || e); }
      };
    } catch (e: any) { live.innerHTML = `<p class="err">Could not read the ${p.network} chain: ${esc(String(e.message || e))}</p><button class="ghost" id="lref">Retry</button>`; $('#lref').onclick = load; }
  };
  load();
}

// ---------- My circles ----------
function renderMine() {
  const list: string[] = JSON.parse(localStorage.getItem('ajo-circles') || '[]');
  app.innerHTML = `<section class="card"><h2>My circles</h2>${list.length ? `<ul class="members">${list.map((e) => { try { const p = decodeCircle(e); return `<li><span class="av">◎</span><span class="who"><b><a href="#/c/${e}">${esc(p.name)}</a></b><small>${p.network} · ${p.members.length} members · ${bch(p.contribution)} BCH</small></span></li>`; } catch { return ''; } }).join('')}</ul>` : '<p class="muted">No circles yet. <a href="#/create">Start one</a>.</p>'}</section>`;
}

// ---------- router ----------
function route() {
  renderHeader();
  const h = location.hash || '#/';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', h.startsWith((a as HTMLAnchorElement).getAttribute('href')!) && (a as HTMLAnchorElement).getAttribute('href') !== '#/' || ((a as HTMLAnchorElement).getAttribute('href') === '#/' && (h === '#/' || h === '#demo'))));
  if (h.startsWith('#/create')) return renderCreate();
  if (h.startsWith('#/mine')) return renderMine();
  if (h.startsWith('#/c/')) { const [enc, q] = h.slice(4).split('?'); return renderCircle(enc, q === 'manual=1'); }
  return renderDemo();
}
window.addEventListener('hashchange', route);
wallet.tryResume();
route();
