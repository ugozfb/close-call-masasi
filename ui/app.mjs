// Close Call Masasi: tarayici arayuzu. Tum hesap ve imza ../src/core.mjs cekirdeginden gelir
// (komut satiriyla ayni kod). Oda metinleri yalniz veri olarak islenir: DOM'a daima textContent ile
// yazilir, hicbir oda metni HTML ya da komut olarak yorumlanmaz.
//
// Ozel anahtar: dosyadan ya da yapistirarak yuklenirse Web Crypto'da disari cikarilamaz bir anahtar olarak
// yalniz bu sekmenin belleginde durur; localStorage'a yazilmaz, sunucuya gitmez, sayfa yenilenince unutulur.
// Harici imza modunda anahtar tarayiciya hic girmez.
import * as C from "../src/core.mjs";
import { dec, fmt } from "../src/fold.mjs";
import { TEXT, LANGS } from "./i18n.mjs";

const VERSION = "0.3.4";
const LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
// Yalniz yerel testte (127.0.0.1) ve test sayfasi ayarladiysa: sahte hakem anahtari.
const TEST = LOCAL && globalThis.__CLOSECALL_TEST__ ? globalThis.__CLOSECALL_TEST__ : null;
const REFEREE = TEST && TEST.refereeDid ? TEST.refereeDid : C.CONTEST.refereeDid;
const BASE = LOCAL ? `${location.origin}/tc` : C.CONTEST.service;
const R = C.CONTEST.refereeRooms;
const OFFER_ROOMS = ["close1", "close1-offers"];
const TRADE_ROOM = "close1";
// technocore okuma siniri IP basina dakikada 120 istek (config.RATE_READ). Hakem odalari 5 dakikada bir
// yazar; onlari 20 saniyede bir, teklif odalarini 5 saniyede bir okumak ~33 istek/dk eder. Bir oda tek
// okumada tam sayfa (200) donerse arada mesaj kaciyor demektir; o oda 2 saniyeye iner (~51 istek/dk).
// Boylece ayni IP'den komut satiri da rahatca kullanilabilir.
const PAGE = 200;                                   // sunucunun tek okumada verdigi en cok mesaj (store.MAX_LIMIT)
const POLL_MS = TEST && TEST.pollMs ? TEST.pollMs : 5000;
const FAST_MS = TEST && TEST.pollMs ? TEST.pollMs : 2000;
const REF_MS = TEST && TEST.pollMs ? TEST.pollMs : 20000;
const EXTRA_MS = TEST && TEST.pollMs ? TEST.pollMs : 30000;   // hakemin kayitli dedigi diger odalar
const EXTRA_MAX = 10;

// ------------------------------------------------------------------ dil
const storedLang = lsGet("closecall.lang", null);
let LANG = LANGS.includes(storedLang) ? storedLang
  : String(navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en";
/** Arayuz metni: once secili dil, yoksa Turkce. */
function t(key, ...args) {
  const v = key in TEXT[LANG] ? TEXT[LANG][key] : TEXT.tr[key];
  return typeof v === "function" ? v(...args) : v;
}
const LOC = () => t("locale");

function applyStatic() {
  document.documentElement.lang = LANG;
  document.title = t("doc.title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  for (const b of document.querySelectorAll("#langSwitch button")) {
    b.classList.toggle("on", b.dataset.lang === LANG);
    b.setAttribute("aria-pressed", b.dataset.lang === LANG ? "true" : "false");
  }
}

function setLang(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return;
  LANG = lang;
  lsSet("closecall.lang", lang);
  applyStatic();
  render();
}

// ------------------------------------------------------------------ durum
const S = {
  conn: { ok: null, err: "", lastOk: 0, badReferee: 0, backoffUntil: 0, directFail: false },
  rooms: {},
  ref: { price: new Map(), flow: new Map(), positions: new Map() },
  refRaw: { price: [], flow: [], positions: [] },  // son birkac ham hakem kaydi (indirme icin)
  offers: new Map(),
  trades: new Map(),                                // id -> ilk gorulen iki imzali islem kaydi
  tradeRecs: new Map(),                             // id -> ayni id'li tum dogrulanmis islem kayitlari
  id: { mode: "none", did: null, signer: null },
  mine: null,                                       // bu DID'e ait gorulen islemler, sonuclar ve kapanislar (kalici)
  settings: Object.assign({ closeWidth: "0.02", margin: 1, offerRoom: "close1-offers", offerFormat: "close-call.offer.v1" },
    lsGet("closecall.settings", {})),
  log: lsGet("closecall.log", []),
  ui: { tab: "islemler", openLevel: null, side: "buy", scanning: false, checksOpen: false },
  form: { px: "", qty: "", until: "", taker: "any", touchedPx: false, touchedUntil: false },
};

function lsGet(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ozel pencere ya da kapali depolama: sessizce gec */
  }
}
const saveLog = () => lsSet("closecall.log", S.log.slice(-500));
const saveSettings = () => lsSet("closecall.settings", S.settings);

// ------------------------------------------------------------------ kucuk yardimcilar
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const $ = (id) => document.getElementById(id);
const mount = (id, ...kids) => $(id).replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const group = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const clock = (ms) => new Date(ms).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" });
const clockS = (ms) => new Date(ms).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ago = (iso) => {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "?";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? t("ago.now") : m < 60 ? t("ago.min", m) : t("ago.hour", Math.floor(m / 60), m % 60);
};
const amt = (v) => { try { return C.formatAmount(v); } catch { return String(v); } };
const short = (did) => C.shortDid(did);
const sideTr = (s) => (s === "buy" ? "LONG" : "SHORT");

function toast(msg, kind = "") {
  const el = h("div", { class: `toast ${kind}` }, msg);
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "fail" ? 9000 : 5000);
}

function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copy.ok"));
  } catch {
    toast(t("copy.fail"), "fail");
  }
}

// ------------------------------------------------------------------ bu DID'e ait kalici kayit
// Yalniz herkese acik veri: odalarda gorulen iki imzali islemler, hakemin sonuclari ve tur kapanislari.
// Sayfa yenilendiginde ya da mesajlar okuma penceresinden ciktiginda tahmini defter kaybolmasin diye.
const mineKey = (did) => `closecall.mine.${did}`;
function loadMine(did) {
  const m = lsGet(mineKey(did), null);
  return m && typeof m === "object" ? { trades: m.trades || {}, outcomes: m.outcomes || {}, closes: m.closes || {} }
    : { trades: {}, outcomes: {}, closes: {} };
}
const saveMine = () => { if (S.id.did && S.mine) lsSet(mineKey(S.id.did), S.mine); };

/** Iki imzali islem kaydini (dogrulanmis) S.trades ve S.tradeRecs'e ekler; zaten varsa eklemez. */
function addTradeRecord(tr) {
  const list = S.tradeRecs.get(tr.terms.id);
  if (list && list.some((x) => x.room === tr.room && (x.seq === tr.seq || x.takerSig === tr.takerSig))) return false;
  if (list) list.push(tr);
  else S.tradeRecs.set(tr.terms.id, [tr]);
  if (!S.trades.has(tr.terms.id)) S.trades.set(tr.terms.id, tr);
  return true;
}

/**
 * Bu tarayicidan gonderilip sunucunun kabul ettigi trade mesajlari, oda okumasinda kacirilsa bile bilinir:
 * kanit kaydindaki metinden, sunucunun verdigi seq ve ts ile yeniden kurulur (imzalar yeniden dogrulanir).
 */
async function ingestOwnLog() {
  for (const e of S.log) {
    if (e.kind !== "kabul" || !(e.status >= 200 && e.status < 300)) continue;
    const rec = { seq: e.posted && Number.isInteger(e.posted.seq) ? e.posted.seq : null, ts: (e.posted && e.posted.ts) || e.time,
      from: e.did, text: e.text, nonce: e.nonce, sig: e.sig };
    for (const tr of C.extractTrades(e.room, [rec])) {
      if (await C.verifyTrade(tr)) addTradeRecord(tr);
    }
  }
}

async function adoptIdentity(id) {
  S.id = id;
  S.mine = id.did ? loadMine(id.did) : null;
  if (S.mine) {
    for (const tr of Object.values(S.mine.trades)) {
      if (!S.trades.has(tr.terms.id) && (await C.verifyTrade(tr))) addTradeRecord(tr);
    }
  }
  await ingestOwnLog();
  updateMine();
}

function updateMine() {
  const did = S.id.did;
  if (!did || !S.mine) return;
  let dirty = false;
  for (const tr of S.trades.values()) {
    if (tr.terms.maker !== did && tr.taker !== did) continue;
    const id = tr.terms.id;
    if (!S.mine.trades[id]) {
      S.mine.trades[id] = { terms: tr.terms, taker: tr.taker, makerSig: tr.makerSig, takerSig: tr.takerSig, room: tr.room, seq: tr.seq, ts: tr.ts };
      dirty = true;
    }
    const st = myTradeState(tr);
    if (DEFINITE.has(st.state) && JSON.stringify(S.mine.outcomes[id]) !== JSON.stringify(st)) {
      S.mine.outcomes[id] = st;
      dirty = true;
    }
    const n = st.n;
    const close = Number.isInteger(n) ? refAt(n) : null;
    if (close && S.mine.closes[n] !== close) {
      S.mine.closes[n] = close;
      dirty = true;
    }
  }
  if (dirty) saveMine();
}

// ------------------------------------------------------------------ ag
class HttpError extends Error {
  constructor(status, room, retryAfter) {
    super(`${status} ${room}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function getRoom(room, since) {
  const q = new URLSearchParams({ format: "json", limit: String(PAGE) });
  if (since !== null) q.set("since", String(since));
  const res = await fetch(`${BASE}/r/${room}?${q}`, { cache: "no-store" });
  if (!res.ok) throw new HttpError(res.status, room, Number(res.headers.get("retry-after")) || 0);
  return C.parseRoomJson(await res.text());
}

/**
 * Odanin yeni mesajlarini okur. Sunucu `since`'ten sonraki mesajlarin EN YENI 200'unu verir; arada kalanlar
 * bu okumayla alinamaz. Kacan mesaj sayisi `missed`'te tutulur ve defterde gosterilir. Donen: tam sayfa mi.
 */
async function pullRoom(room, onRecords) {
  const st = S.rooms[room] || (S.rooms[room] = { lastSeq: null, missed: 0, nextAt: 0 });
  const data = await getRoom(room, st.lastSeq);
  const msgs = (data.messages || []).filter((m) => st.lastSeq === null || m.seq > st.lastSeq);
  if (st.lastSeq !== null && msgs.length && msgs[0].seq > st.lastSeq + 1) st.missed += msgs[0].seq - st.lastSeq - 1;
  await onRecords(msgs);
  if (msgs.length) st.lastSeq = msgs[msgs.length - 1].seq;
  else if (st.lastSeq === null) st.lastSeq = Number.isInteger(data.last_seq) ? data.last_seq : 0;
  return msgs.length >= PAGE;
}

async function ingestReferee(key, room, recs) {
  for (const rec of recs) {
    if (rec.from !== REFEREE || !(await C.verifyRoomRecord(room, rec))) {
      S.conn.badReferee++;
      continue;
    }
    const m = C.refereeMessage(rec);
    if (m && m.t) S.ref[key].set(`${m.t}:${m.n ?? m._seq}`, m);
    S.refRaw[key].push({ room, ...rec });
    if (S.refRaw[key].length > 3) S.refRaw[key].shift();
  }
}

async function ingestMarket(room, recs) {
  for (const o of C.extractOffers(room, recs)) {
    const k = `${o.terms.maker}|${o.terms.id}`;
    if (S.offers.has(k)) continue;
    o.verified = await C.verifyOffer(o);
    S.offers.set(k, o);
  }
  for (const tr of C.extractTrades(room, recs)) {
    const list = S.tradeRecs.get(tr.terms.id);
    if (list && list.some((x) => x.room === tr.room && (x.seq === tr.seq || x.takerSig === tr.takerSig))) continue;
    if (!(await C.verifyTrade(tr))) continue;
    addTradeRecord(tr);
  }
}

/**
 * Hakemin akis mesajlarinda kaydi duyurulan odalar (rooms). Islemler bu odalarda da sayilir; bir teklifimizi
 * kabul eden taker trade'i oraya yazabilir. En cok EXTRA_MAX oda, 30 sn aralikla okunur; bulunanlar hatirlanir.
 */
function registeredRooms() {
  const known = new Set([...OFFER_ROOMS, ...Object.values(R)]);
  const found = new Set(lsGet("closecall.rooms", []));
  const before = found.size;
  for (const r of C.flowRooms(flowMsgs())) found.add(r);
  if (found.size !== before) lsSet("closecall.rooms", [...found].slice(0, 300));
  return [...found].filter((r) => /^[a-z0-9][a-z0-9_-]{0,47}$/.test(r) && !known.has(r));
}
const extraRooms = () => registeredRooms().slice(0, EXTRA_MAX);

function pollPlan() {
  return [
    [R.price, "ref", (r) => ingestReferee("price", R.price, r)],
    [R.flow, "ref", (r) => ingestReferee("flow", R.flow, r)],
    [R.positions, "ref", (r) => ingestReferee("positions", R.positions, r)],
    ...OFFER_ROOMS.map((room) => [room, "market", (r) => ingestMarket(room, r)]),
    ...extraRooms().map((room) => [room, "extra", (r) => ingestMarket(room, r)]),
  ];
}

let polling = false;
async function poll() {
  if (polling) return;
  const now = Date.now();
  if (now < S.conn.backoffUntil) return;
  polling = true;
  let changed = false;
  try {
    for (const [room, kind, ingest] of pollPlan()) {
      const st = S.rooms[room];
      if (st && st.nextAt > Date.now()) continue;
      const full = await pullRoom(room, ingest);
      S.rooms[room].nextAt = Date.now() + (kind === "ref" ? REF_MS : kind === "extra" ? EXTRA_MS : full ? FAST_MS : POLL_MS);
      changed = true;
    }
    if (changed) {
      prune();
      updateMine();
      S.conn.ok = true;
      S.conn.err = "";
      S.conn.directFail = false;
      S.conn.lastOk = Date.now();
    }
  } catch (e) {
    changed = true;
    S.conn.ok = false;
    if (e instanceof HttpError && e.status === 429) {
      const wait = Math.max(5, Math.min(120, e.retryAfter || 30));
      S.conn.backoffUntil = Date.now() + wait * 1000;
      S.conn.err = t("conn.429", wait);
    } else {
      S.conn.backoffUntil = Date.now() + 5000;
      const netFail = e instanceof TypeError && /fetch|network|load failed/i.test(e.message || "");
      S.conn.directFail = !LOCAL && netFail;
      S.conn.err = S.conn.directFail ? t("conn.directFailShort") : e && e.message ? e.message : String(e);
    }
  } finally {
    polling = false;
    if (changed) render();
  }
}

function prune() {
  const next = C.nextSweep();
  for (const [k, o] of S.offers) if (o.terms.until < next - 24) S.offers.delete(k);
  const keep = (map, n) => {
    if (map.size <= n) return;
    const keys = [...map.keys()];
    for (const k of keys.slice(0, map.size - n)) map.delete(k);
  };
  keep(S.ref.flow, 400);
  keep(S.ref.price, 3000);
  keep(S.ref.positions, 3000);
  keep(S.trades, 3000);
  keep(S.tradeRecs, 3000);
}

async function scanExport(room) {
  if (S.ui.scanning) return;
  S.ui.scanning = true;
  render();
  try {
    toast(t("scan.start", room));
    const res = await fetch(`${BASE}/r/${room}/export`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status}`);
    const recs = C.parseExportJsonl(await res.text());
    await ingestMarket(room, recs);
    updateMine();
    toast(t("scan.done", room, recs.length), "ok");
  } catch (e) {
    toast(t("scan.fail", e.message || e), "fail");
  } finally {
    S.ui.scanning = false;
    render();
  }
}

// ------------------------------------------------------------------ turetilmis veri
function priceMsgs() {
  return [...S.ref.price.values()].filter((m) => m.t === "price" && Number.isInteger(m.n)).sort((a, b) => a.n - b.n);
}
function flowMsgs() {
  return [...S.ref.flow.values()].filter((m) => m.t === "flow").sort((a, b) => (a.n ?? 0) - (b.n ?? 0)).slice(-200);
}
function posMsgs() {
  return [...S.ref.positions.values()].filter((m) => m.t === "positions" && Number.isInteger(m.n)).sort((a, b) => a.n - b.n);
}
function snapshot() {
  return C.refereeSnapshot({ priceMessages: priceMsgs(), flowMessages: flowMsgs(), nowMs: Date.now() });
}
function refAt(n) {
  const m = S.ref.price.get(`price:${n}`);
  const r = m && (typeof m.ref === "object" && m.ref ? m.ref.px : m.ref);
  if (typeof r === "string") return r;
  return S.mine && S.mine.closes[n] ? S.mine.closes[n] : null;
}

// ------------------------------------------------------------------ hakem sonuclari
// Canli akis mesaji: settled = ["id", ...] (cogu tur bos, sayisi omitted.settled'da), void = [["id","neden"], ...].
// Bir islemin sonucu, kaydinin zamanindan hesaplanan turun akis mesajindan okunur (C.tradeStatus):
// listede varsa kesin; yoksa ve void listesi tamsa "settled" CIKARIMDIR.
const DEFINITE = new Set(["settled", "settled_inferred", "void", "void_likely"]);

function tradeState(id, ts) {
  const st = C.tradeStatus({ id, ts, flowMessages: flowMsgs() });
  if (!DEFINITE.has(st.state) && S.mine && S.mine.outcomes[id] && DEFINITE.has(S.mine.outcomes[id].state)) return S.mine.outcomes[id];
  return st;
}

/** Benim islemim icin durum: ayni id'yi baska bir taker benden once yazdiysa ilk gelen sonuclanir, benimki void olur. */
function myTradeState(tr) {
  const st = tradeState(tr.terms.id, tr.ts);
  const rivals = (S.tradeRecs.get(tr.terms.id) || []).filter((x) => x.taker !== tr.taker && Date.parse(x.ts) < Date.parse(tr.ts));
  if (rivals.length && (st.state === "settled" || st.state === "settled_inferred")) return { ...st, state: "void_likely", reason: "settled" };
  return st;
}

/** Sonuc etiketi: [css sinifi, uzun metin, kisa metin] */
function stateLabel(st) {
  switch (st.state) {
    case "settled": return ["ok", t("oc.settled", st.n), "settled"];
    case "settled_inferred": return ["ok", t("oc.inferred", st.n), "≈settled"];
    case "void": return ["fail", t("oc.void", st.reason, st.n), st.reason || "void"];
    case "void_likely": return ["fail", t("oc.raceLost"), "≈void"];
    case "pending": return ["unk", t("oc.pending", st.n), "…"];
    default: return ["unk", t("oc.unknown", st.source || "", st.omitted), "?"];
  }
}

function myDid() {
  return S.id.did;
}

/**
 * Yerel defter, iki ayri bakiye:
 *  - direct: yalniz hakem listesinde dogrudan gorulen (settled) islemlerden hesaplanan bakiye
 *  - est:    cikarimlar dahil (void listesi tam oldugu icin settled sayilanlar da) tahmini bakiye
 * Ikisi de hakemin kesin hesap bakiyesi DEGILDIR: bu tarayicinin gormedigi islemler (baska cihaz, okunmayan oda,
 * kacirilan mesaj) ikisine de girmez. `gaps` saptanabilen eksiklikleri sayar. `low`: nakdi az olan (ihtiyatli) defter.
 */
function myLedger() {
  const did = myDid();
  const fills = [], pending = [], voided = [];
  if (did) {
    for (const tr of S.trades.values()) {
      const mine = tr.terms.maker === did ? tr.terms.side : tr.taker === did ? (tr.terms.side === "buy" ? "sell" : "buy") : null;
      if (!mine) continue;
      const st = myTradeState(tr);
      if (st.state === "settled" || st.state === "settled_inferred") {
        const close = refAt(st.n);
        fills.push({ n: st.n, side: mine, qty: tr.terms.qty, px: tr.terms.px, close: close || tr.terms.px, estimatedClose: !close,
          inferred: st.state === "settled_inferred", id: tr.terms.id });
      } else if (st.state === "void" || st.state === "void_likely") voided.push({ trade: tr, side: mine, st });
      else pending.push({ trade: tr, side: mine, st });
    }
  }
  fills.sort((a, b) => a.n - b.n);
  const direct = C.localLedger(fills.filter((x) => !x.inferred));
  const est = C.localLedger(fills);
  const low = dec(est.cash) < dec(direct.cash) ? est : direct;
  const missed = [...OFFER_ROOMS, ...extraRooms()].reduce((s, r) => s + (S.rooms[r]?.missed || 0), 0);
  const unreadRooms = Math.max(0, registeredRooms().length - EXTRA_MAX);
  const gaps = { missed, unreadRooms, open: pending.length, any: missed > 0 || unreadRooms > 0 || pending.length > 0 };
  return { direct, est, low, fills, pending, voided, gaps };
}

/** Hakemin listelerinde sonuclandigi gorulen id'ler (settled ya da "void: settled" = daha once sonuclandi). */
function settledIds() {
  const ids = new Set();
  for (const m of flowMsgs()) for (const e of C.flowEntries(m)) if (e.outcome === "settled" || e.reason === "settled") ids.add(e.id);
  return ids;
}

/**
 * Kayit durumu. Canli akista mints listesi hep kisaltilmis (tur basina binlerce kayit), DID orada gorunmez. Bu yuzden:
 *  - islemlerimden biri not_owner ile dustuyse: kayitsiz gorunuyor
 *  - islemlerimden biri settled (liste ya da cikarim): kayitli
 *  - bu tarayicidan gonderilen kayit 2xx aldi ve o turun akis mesaji okuma boslugu olmadan yayimlandi: kayitli (CIKARIM)
 */
// Resmi kontrol sirasi (close-call-game.md): shape -> not_owner -> taker -> settled -> expired -> locked -> limits -> funds.
// Hakem listesinde not_owner'dan SONRAKI bir nedenle void ya da settled gorulen islem, taraflarin o turda kayitli oldugunu gosterir.
const AFTER_OWNER = new Set(["taker", "settled", "expired", "locked", "limits", "funds"]);

/**
 * Kayit durumu, iki kademe:
 *  - level "kesin": islemim hakem listesinde settled ya da AFTER_OWNER nedenli void; ya da DID mints listesinde
 *  - level "cikarim": islemim ≈ settled (cikarim), ya da bu tarayicidan gonderilen kayit o turda okuma boslugu olmadan islendi
 *  - not_owner: islemim hakem listesinde not_owner ile dustu
 */
function registrationState() {
  const did = myDid();
  if (!did) return null;
  const L = myLedger();
  if (L.voided.some((v) => v.st.source === "list" && v.st.reason === "not_owner")) return { state: "not_owner" };
  const listedFill = L.fills.find((x) => !x.inferred);
  if (listedFill) return { state: "registered", level: "kesin", source: "listed", n: listedFill.n };
  const listedVoid = L.voided.find((v) => v.st.source === "list" && AFTER_OWNER.has(v.st.reason));
  if (listedVoid) return { state: "registered", level: "kesin", source: "listed", n: listedVoid.st.n };
  const f = C.findInFlow(flowMsgs(), { did });
  if (f.hits.length) return { state: "registered", level: "kesin", source: "mints", n: f.hits[0].n };
  const inferredFill = L.fills.find((x) => x.inferred);
  if (inferredFill) return { state: "registered", level: "cikarim", source: "inferredTrade", n: inferredFill.n };
  const sent = S.log.filter((e) => e.kind === "kayit" && e.did === did && e.status >= 200 && e.status < 300);
  for (const e of sent) {
    const n = C.sweepOfTime(Date.parse((e.posted && e.posted.ts) || e.time));
    const m = flowMsgs().find((x) => x.n === n);
    if (m && !(Array.isArray(m.missed) && m.missed.length)) return { state: "registered", level: "cikarim", source: "sent", n };
    if (!m) return { state: "pending", n };
  }
  return { state: "unknown", partial: f.partial, scanned: f.scanned };
}

/**
 * Bakiye kontrolunu iki defterde de calistirir; "fon" maddesi kotu olaninkini alir, ikisini de yazar.
 * Ikisinden gecmek ek guvence verir, hakemin kabul edecegi garantisi degildir.
 */
function preflightBoth(args, L) {
  const a = C.preflight({ ...args, ledger: { cash: L.direct.cash, lots: L.direct.lots } });
  if (L.direct.cash === L.est.cash && JSON.stringify(L.direct.lots) === JSON.stringify(L.est.lots)) return a;
  const b = C.preflight({ ...args, ledger: { cash: L.est.cash, lots: L.est.lots } });
  const fa = a.checks.find((c) => c.key === "fon"), fb = b.checks.find((c) => c.key === "fon");
  if (fa && fb) {
    const rank = { ok: 0, bilinmiyor: 1, uyari: 2, fail: 3 };
    fa.status = rank[fb.status] > rank[fa.status] ? fb.status : fa.status;
    fa.detail = `${t("bal.directShort")}: ${fa.detail} · ${t("bal.estShort")}: ${fb.detail}`;
    a.blocking = a.checks.some((c) => c.status === "fail");
  }
  return a;
}

/** Kontrol listesindeki "kayit" maddesini yukaridaki cikarimla gunceller; bekleyen islemleri de uyari olarak ekler. */
function enrichChecks(check, kind, L) {
  const r = registrationState();
  const c = check.checks.find((x) => x.key === "kayit");
  if (c && r) {
    if (r.state === "registered") {
      // cikarimla kayitli: islem gondermeyi engellemez ama "ok" da denmez
      c.status = kind === "kayit" ? "uyari" : r.level === "kesin" ? "ok" : "bilinmiyor";
      c.detail = t(`reg.${r.source}`, r.n) + (kind === "kayit" ? t("reg.dontResend") : "");
    } else if (r.state === "not_owner") {
      c.status = "uyari";
      c.detail = t("reg.notOwner");
    } else if (r.state === "pending") {
      c.detail = t("reg.pending", r.n);
    }
  }
  if (L && kind !== "kayit") {
    if (L.pending.length) check.checks.push({ key: "bekleyen", label: t("pend.label"), status: "uyari", detail: t("pend.detail", L.pending.length) });
    const g = L.gaps, parts = [];
    if (g.missed) parts.push(t("gap.missed", g.missed));
    if (g.unreadRooms) parts.push(t("gap.rooms", g.unreadRooms));
    if (g.open) parts.push(t("gap.open", g.open));
    check.checks.push({ key: "gecmis", label: t("gap.label"), status: parts.length ? "uyari" : "bilinmiyor",
      detail: parts.length ? t("gap.found", parts.join(", ")) : t("gap.none") });
  }
  check.blocking = check.checks.some((x) => x.status === "fail");
  return check;
}

// ------------------------------------------------------------------ imza
function nonceFor(did, room) {
  const store = lsGet("closecall.nonce", {});
  const k = `${did}|${room}`;
  const n = C.nextNonce(store[k]);
  store[k] = n;
  lsSet("closecall.nonce", store);
  return n;
}

function currentSigner() {
  if (S.id.mode === "key" && S.id.signer) return S.id.signer;
  if (S.id.mode === "external" && S.id.did) return { did: S.id.did, sign: (payload) => externalSign(payload) };
  return null;
}

function externalSign(payload) {
  return new Promise((resolve, reject) => {
    const sigIn = h("input", { class: "input", placeholder: t("ext.placeholder"), spellcheck: "false" });
    const err = h("div", { class: "small ask" });
    // Her imza icin ayri dosya adi: tarayici ayni adi "imza (1).txt" yapar ve komut eski dosyayi imzalardi.
    const fname = `imza-${Date.now()}.txt`;
    const cmd = `node cli\\closecall.mjs imzala --anahtar C:\\dev\\ANAHTAR.json --metin-dosya "$env:USERPROFILE\\Downloads\\${fname}"`;
    openDialog({
      title: t("ext.title"),
      body: [
        h("p", { class: "muted small" }, t("ext.intro")),
        h("div", { class: "section" }, h("h4", {}, t("dlg.toSign")), h("div", { class: "code" }, payload),
          h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => copy(payload) }, t("ext.copyText")),
            h("button", { class: "btn", type: "button", onclick: () => download(fname, payload, "text/plain") }, t("ext.download", fname)))),
        h("div", { class: "section" }, h("h4", {}, t("ext.ps")),
          h("p", { class: "small muted" }, t("ext.keyPath")), h("div", { class: "code" }, cmd),
          h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => copy(cmd) }, t("ext.copyCmd")))),
        h("div", { class: "section" }, h("h4", {}, t("ext.sig")), sigIn, err),
      ],
      actions: [
        { label: t("dlg.cancel"), onclick: () => { closeDialog(); reject(new Error(t("ext.cancelled"))); } },
        { label: t("ext.verify"), primary: true, onclick: async () => {
          const sig = sigIn.value.trim();
          if (await C.verifySignature(S.id.did, sig, payload)) { closeDialog(); resolve(sig); }
          else err.textContent = t("ext.bad");
        } },
      ],
      onCancel: () => reject(new Error(t("ext.cancelled"))),
    });
  });
}

async function postSigned(room, text, meta) {
  const signer = currentSigner();
  if (!signer) throw new Error(t("send.noSigner"));
  const signed = await C.signRoomMessage(signer, room, text, nonceFor(signer.did, room));
  const { url, init } = C.postRequest(signed, BASE, { json: true });
  let status = 0, body = "", posted = null;
  try {
    const res = await fetch(url, init);
    status = res.status;
    body = await res.text();
    try {
      const j = C.parseRoomJson(body);
      if (j && j.posted && Number.isInteger(j.posted.seq)) {
        posted = { seq: j.posted.seq, ts: j.posted.ts };
        body = `posted seq ${posted.seq} ${posted.ts}`;
      }
    } catch {
      /* hata yanitlari metindir */
    }
    body = body.slice(0, 500);
  } catch (e) {
    body = String(e && e.message ? e.message : e);
  }
  const entry = { time: new Date().toISOString(), room, did: signed.did, nonce: signed.nonce, text, sig: signed.sig, status, response: body, posted, ...meta };
  S.log.push(entry);
  saveLog();
  if (meta && meta.kind === "kabul" && status >= 200 && status < 300) {
    await ingestOwnLog();
    updateMine();
  }
  return entry;
}

// ------------------------------------------------------------------ pencere
let dialogCancel = null;
function openDialog({ title, body, actions = [], onCancel = null }) {
  const dlg = $("dlg");
  dialogCancel = onCancel;
  dlg.replaceChildren(
    h("div", { class: "dlg-head" }, h("span", { class: "dlg-title" }, title),
      h("button", { class: "close-x", type: "button", "aria-label": t("dlg.close"), onclick: () => { closeDialog(); if (onCancel) onCancel(); } }, "×")),
    h("div", { class: "dlg-body" }, body),
    h("div", { class: "dlg-foot" }, actions.map((a) => h("button", {
      class: `btn ${a.primary ? "primary" : ""} ${a.cls || ""}`, type: "button", disabled: a.disabled || false, onclick: a.onclick,
    }, a.label))),
  );
  if (!dlg.open) dlg.showModal();
}
function closeDialog() {
  dialogCancel = null;
  const dlg = $("dlg");
  if (dlg.open) dlg.close();
}

const ICON = { ok: "✓", fail: "×", uyari: "!", bilinmiyor: "?" };
function checksView(result) {
  return h("ul", { class: "checks" }, result.checks.map((c) =>
    h("li", { class: `check ${c.status}` }, h("span", { class: "ic" }, ICON[c.status] || "?"),
      h("span", {}, h("b", {}, `${c.label}: `), c.detail))));
}
function checksSummary(result) {
  const n = (s) => result.checks.filter((c) => c.status === s).length;
  const parts = [["ok", n("ok")], ["uyari", n("uyari")], ["bilinmiyor", n("bilinmiyor")], ["fail", n("fail")]].filter(([, k]) => k);
  return h("span", { class: "check-sum" }, parts.map(([s, k]) => h("span", { class: `check ${s}` }, h("span", { class: "ic" }, ICON[s]), String(k))));
}

async function confirmAndSend({ title, rows, check, previewText, run }) {
  const blocked = check && check.blocking;
  openDialog({
    title,
    body: [
      h("div", { class: "kv" }, rows.map(([k, v]) => [h("span", { class: "k" }, k), h("span", { class: "v" }, v)])),
      check ? h("div", { class: "section" }, h("h4", {}, t("checks.title")), checksView(check),
        h("div", { class: "note" }, t("dlg.sigNote"))) : null,
      previewText ? h("div", { class: "section" }, h("h4", {}, t("dlg.toSign")), h("div", { class: "code" }, previewText)) : null,
      blocked ? h("div", { class: "warnbox" }, t("dlg.blocked")) : null,
    ],
    actions: [
      { label: t("dlg.cancel"), onclick: closeDialog },
      { label: t("dlg.send"), primary: true, disabled: blocked, onclick: async (ev) => {
        ev.target.disabled = true;
        closeDialog();
        try {
          const entry = await run();
          if (entry.status >= 200 && entry.status < 300) toast(t("send.ok", entry.status), "ok");
          else toast(t("send.fail", entry.status, entry.response), "fail");
        } catch (e) {
          toast(e.message || String(e), "fail");
        }
        render();
      } },
    ],
  });
}

// ------------------------------------------------------------------ eylemler
function registerFlow() {
  const did = myDid();
  if (!did) return openIdentity();
  const check = enrichChecks(C.preflight({ kind: "kayit", myDid: did, referee: S.conn.ok ? snapshot() : null, lang: LANG }), "kayit", null);
  confirmAndSend({
    title: t("reg.title"),
    rows: [["DID", did], [t("row.room"), TRADE_ROOM], [t("row.note"), t("reg.note")]],
    check, previewText: C.ownerText(did),
    run: () => postSigned(TRADE_ROOM, C.ownerText(did), { kind: "kayit" }),
  });
}

function offerFlow() {
  const did = myDid();
  if (!did) return openIdentity();
  const f = readForm();
  if (f.error) return toast(f.error, "fail");
  let terms;
  try {
    terms = C.makeTerms({ id: C.newTradeId("cm"), maker: did, side: S.ui.side, qty: f.qty, px: f.px, taker: f.taker, until: f.until });
  } catch (e) {
    return toast(e.message, "fail");
  }
  const L = myLedger();
  const check = enrichChecks(preflightBoth({ kind: "teklif", terms, myDid: did, referee: S.conn.ok ? snapshot() : null,
    side: S.ui.side, closeWidth: S.settings.closeWidth, margin: S.settings.margin, lang: LANG }, L), "teklif", L);
  confirmAndSend({
    title: t("offer.title", sideTr(S.ui.side), terms.qty, terms.px),
    rows: [[t("row.side"), t(S.ui.side === "buy" ? "side.buy" : "side.sell")], [t("row.qty"), terms.qty], [t("row.price"), terms.px],
      [t("row.until"), `${terms.until} (≈ ${clock(C.sweepTimeMs(terms.until))})`], [t("row.taker"), terms.taker],
      [t("row.roomFormat"), `${S.settings.offerRoom} · ${S.settings.offerFormat}`], [t("row.cancel"), t("offer.noCancel")]],
    check, previewText: C.makerPayload(terms),
    run: async () => {
      const signer = currentSigner();
      const makerSig = await signer.sign(C.makerPayload(terms));
      return postSigned(S.settings.offerRoom, C.offerText(terms, makerSig, S.settings.offerFormat), { kind: "teklif", id: terms.id, terms });
    },
  });
}

function acceptFlow(offer) {
  const did = myDid();
  if (!did) return openIdentity();
  const ourSide = offer.terms.side === "buy" ? "sell" : "buy";
  const L = myLedger();
  const snap = S.conn.ok ? snapshot() : null;
  const check = preflightBoth({ kind: "kabul", terms: offer.terms, makerSigOk: !!offer.verified, myDid: did, referee: snap,
    side: ourSide, closeWidth: S.settings.closeWidth, margin: S.settings.margin, lang: LANG }, L);
  if (offer.terms.maker === did) check.checks.push({ key: "kendi", label: t("accept.ownLabel"), status: "fail", detail: t("accept.ownDetail") });
  enrichChecks(check, "kabul", L);
  const ref = snap && snap.ref ? snap.ref : offer.terms.px;
  const fr = C.feeRange({ side: ourSide, qty: offer.terms.qty, px: offer.terms.px, ref, width: S.settings.closeWidth });
  confirmAndSend({
    title: t("accept.title", sideTr(ourSide), offer.terms.qty, offer.terms.px),
    rows: [["Maker", offer.terms.maker], [t("row.makerSide"), sideTr(offer.terms.side)], [t("row.yourSide"), t(ourSide === "buy" ? "side.buy" : "side.sell")],
      [t("row.qtyPrice"), `${offer.terms.qty} @ ${offer.terms.px}`], [t("row.until"), String(offer.terms.until)],
      [t("row.fee"), t("accept.fee", group(fr.min), group(fr.max), fr.closes.join(" – "))],
      [t("row.tradeRoom"), TRADE_ROOM], [t("row.source"), `${offer.room} · ${offer.format}`]],
    check, previewText: C.takerPayload(offer.terms, did),
    run: async () => {
      const text = await C.acceptOffer(currentSigner(), offer);
      return postSigned(TRADE_ROOM, text, { kind: "kabul", id: offer.terms.id, terms: offer.terms });
    },
  });
}

// ------------------------------------------------------------------ kimlik
function openIdentity() {
  const didIn = h("input", { class: "input", placeholder: "did:key:z6Mk...", spellcheck: "false", value: S.id.did || "" });
  const keyIn = h("textarea", { class: "input", placeholder: t("idd.keyPh"), spellcheck: "false" });
  const fileIn = h("input", { type: "file", accept: ".json,application/json" });
  const err = h("div", { class: "small ask" });
  const useKey = async (text) => {
    try {
      const signer = await C.importSigner(text);
      keyIn.value = "";
      await adoptIdentity({ mode: "key", did: signer.did, signer });
      closeDialog();
      toast(t("idd.loaded", short(signer.did)), "ok");
      render();
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  };
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    if (f) await useKey(await f.text());
    fileIn.value = "";
  });
  const watch = async (mode) => {
    const d = didIn.value.trim();
    if (!C.isDid(d)) { err.textContent = t("idd.badDid"); return; }
    await adoptIdentity({ mode, did: d, signer: null });
    closeDialog();
    toast(mode === "watch" ? t("idd.watchOn") : t("idd.extOn"));
    render();
  };
  openDialog({
    title: t("idd.title"),
    body: [
      h("div", { class: "section" }, h("h4", {}, t("idd.s1")),
        h("p", { class: "small muted" }, t("idd.s1p")),
        fileIn),
      h("div", { class: "section" }, h("h4", {}, t("idd.s2")),
        h("p", { class: "small muted" }, t("idd.s2p")), keyIn,
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => useKey(keyIn.value) }, t("idd.load")))),
      h("div", { class: "section" }, h("h4", {}, t("idd.s3")), didIn,
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => watch("watch") }, t("idd.watch")),
          h("button", { class: "btn", type: "button", onclick: () => watch("external") }, t("idd.external")))),
      err,
      S.id.mode !== "none" ? h("div", { class: "section" }, h("button", { class: "btn ghost", type: "button", onclick: () => {
        S.id = { mode: "none", did: null, signer: null };
        S.mine = null;
        closeDialog();
        toast(t("idd.removed"));
        render();
      } }, t("idd.forget"))) : null,
    ],
    actions: [{ label: t("dlg.close"), onclick: closeDialog }],
  });
}

// ------------------------------------------------------------------ form
function readForm() {
  const px = S.form.px.trim(), qty = S.form.qty.trim(), until = Number(S.form.until);
  if (!C.AMOUNT_RE.test(px) || Number(px) <= 0) return { error: t("form.price") };
  if (!C.AMOUNT_RE.test(qty) || Number(qty) < 0.1) return { error: t("form.qty") };
  if (!Number.isInteger(until)) return { error: t("form.until") };
  const taker = S.form.taker.trim() || "any";
  if (taker !== "any" && !C.isDid(taker)) return { error: t("form.taker") };
  return { px: C.formatAmount(px), qty: C.formatAmount(qty), until, taker };
}

// ------------------------------------------------------------------ cizim
function renderStats() {
  const snap = snapshot();
  const next = C.nextSweep();
  const left = Math.max(0, C.sweepTimeMs(next) - Date.now());
  const mm = String(Math.floor(left / 60000)).padStart(2, "0"), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const pos = posMsgs().at(-1);
  const stat = (label, value, note, cls = "") => h("div", { class: "stat" }, h("span", { class: "stat-label" }, label),
    h("span", { class: `stat-value ${cls}` }, value), note ? h("span", { class: "stat-note" }, note) : null);
  mount("stats",
    stat(t("stat.ref"), snap.ref ?? "—", snap.refTime ? t("stat.refNote", ago(snap.refTime)) : t("stat.refWait"), "big"),
    stat(t("stat.band"), snap.limits ? `${snap.limits[0]} – ${snap.limits[1]}` : "—", t("stat.bandNote")),
    stat(t("stat.sweep"), snap.lastSweep ?? "—", snap.lag === null ? "" : snap.lag <= 1 ? t("stat.onTime") : t("stat.behind", snap.lag)),
    stat(t("stat.next"), `#${next}`, t("stat.left", `${mm}:${ss}`)),
    stat(t("stat.open"), pos ? group(pos.open, 0) : "—", pos ? t("stat.openNote", group(pos.longs, 0), group(pos.shorts, 0)) : ""),
  );
  const c = S.conn;
  const dotCls = c.ok === null ? "" : c.ok ? "ok" : "fail";
  $("conn").title = c.directFail ? t("conn.directFail") : "";
  mount("conn", h("span", { class: `dot ${dotCls}` }),
    c.ok === null ? t("conn.connecting") : c.ok ? `${LOCAL ? t("conn.local") : t("conn.direct")} · ${clockS(c.lastOk)}` : t("conn.error", c.directFail ? t("conn.directFailShort") : c.err));
  const idc = $("idChip");
  idc.replaceChildren(S.id.mode === "none" ? t("id.choose")
    : h("span", {}, h("span", { class: "muted" }, t(`id.mode.${S.id.mode}`) + " · "), h("span", { class: "mono" }, short(S.id.did))));
}

function renderBook() {
  const snap = snapshot();
  const next = C.nextSweep();
  const offers = [...S.offers.values()];
  const book = C.buildBook(offers, { nextSweep: next, ref: snap.ref, settledIds: settledIds(), takenIds: new Set(S.trades.keys()),
    viewer: myDid(), margin: S.settings.margin });
  const asks = book.asks.slice(0, 12).reverse(), bids = book.bids.slice(0, 12);
  const maxQ = Math.max(1, ...asks.map((l) => Number(l.qty)), ...bids.map((l) => Number(l.qty)));
  const canSign = S.id.mode === "key" || S.id.mode === "external";
  const row = (l, side) => {
    const key = `${side}:${l.px}`;
    const open = S.ui.openLevel === key;
    const bar = h("span", { class: "bar" });
    bar.style.width = `${Math.max(2, (Number(l.qty) / maxQ) * 100)}%`;
    const btn = h("button", { class: `lvl ${side}${open ? " open" : ""}`, type: "button", "aria-expanded": open ? "true" : "false",
      onclick: () => { S.ui.openLevel = open ? null : key; renderBook(); } },
      bar, h("span", { class: "px" }, l.px), h("span", {}, l.qty), h("span", {}, String(l.count), l.tight ? h("span", { class: "tight-mark", title: t("book.tightTitle") }, "⏱") : null));
    const list = open ? h("div", { class: "offer-list" }, l.offers.map(({ offer, tight }) => {
      const own = offer.terms.maker === myDid();
      return h("div", { class: "offer-item" },
        h("span", {}, h("span", { class: "mono" }, `${offer.terms.qty} @ ${offer.terms.px}`), " ",
          h("span", { class: "muted" }, t("book.makerLine", short(offer.terms.maker), offer.terms.until)), tight ? h("span", { class: "tight-mark" }, t("book.tight")) : null,
          own ? h("span", { class: "pill unk own" }, t("book.own")) : null,
          h("div", { class: "faint small" }, `${offer.room} · ${offer.format}`)),
        h("button", { class: `btn ${side === "ask" ? "buy" : "sell"}`, type: "button", disabled: !canSign || own,
          title: !canSign ? t("book.needId") : own ? t("book.ownTitle") : "", onclick: () => acceptFlow(offer) },
          side === "ask" ? t("book.buy") : t("book.sell")));
    })) : null;
    return [btn, list];
  };
  const kids = [];
  if (!asks.length && !bids.length) kids.push(h("div", { class: "book-empty" }, S.conn.ok ? t("book.empty") : S.conn.directFail ? t("conn.directFail") : t("book.loading")));
  kids.push(...asks.flatMap((l) => row(l, "ask")));
  kids.push(h("div", { class: "spread-row" }, h("span", { class: "spread-ref" }, snap.ref ?? "—"),
    h("span", { class: "small muted" }, book.spread ? t("book.refSpread", book.spread) : t("book.ref"))));
  kids.push(...bids.flatMap((l) => row(l, "bid")));
  mount("book", kids);
  const missed = OFFER_ROOMS.reduce((s, r) => s + (S.rooms[r]?.missed || 0), 0);
  const total = book.bids.reduce((s, l) => s + l.count, 0) + book.asks.reduce((s, l) => s + l.count, 0);
  mount("bookMeta", t("book.meta", total));
  const cnt = (label, n) => h("span", { class: "foot-count" }, label, " ", h("b", {}, String(n)));
  mount("bookFoot",
    h("div", { class: "foot-counts" }, cnt(t("cnt.taken"), book.counts.taken), cnt(t("cnt.settled"), book.counts.settled), cnt(t("cnt.band"), book.outOfBand.length),
      cnt(t("cnt.reserved"), book.reserved.length), cnt(t("cnt.expired"), book.counts.expired), cnt(t("cnt.unverified"), book.counts.unverified),
      missed ? h("span", { class: "foot-count warn" }, `${t("cnt.missed")} `, h("b", {}, String(missed))) : null),
    h("div", { class: "faint" }, t("book.footNote", OFFER_ROOMS.join(", "), C.OFFER_FORMATS.map((f) => f.t).join(", "))),
    h("div", { class: "row" }, h("button", { class: "btn ghost small", type: "button", disabled: S.ui.scanning, onclick: () => scanExport("close1") },
      S.ui.scanning ? t("book.scanning") : t("book.scan"))));
}

function renderChart() {
  const pts = priceMsgs().slice(-288);
  const box = $("chart");
  if (pts.length < 2) return mount("chart", h("div", { class: "empty" }, t("chart.wait")));
  const W = Math.max(260, box.clientWidth || 700), H = Math.max(200, box.clientHeight || 250) - 10, padL = 58, padR = 12, padT = 10, padB = 24;
  const refs = pts.map((m) => Number(typeof m.ref === "object" ? m.ref.px : m.ref));
  const lims = pts.map((m) => (Array.isArray(m.limits) ? m.limits.map(Number) : null));
  const mine = myLedger().fills;
  // Olcek referans cizgisine (ve kendi islemlerime) gore: ±%5 bant fiyat hareketinden cok genis oldugu icin
  // banda gore olceklenince cizgi duz gorunuyordu. Bant olcege sigmiyorsa kirpilir ve bir notla belirtilir.
  const vals = refs.concat(mine.map((f) => Number(f.px)));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, (lo + hi) / 2 * 0.0015);
  lo -= pad;
  hi += pad;
  const n0 = pts[0].n, n1 = pts.at(-1).n;
  const x = (n) => padL + ((n - n0) / Math.max(1, n1 - n0)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - padT - padB);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("chart.aria") });
  const defs = svg("defs");
  const clip = svg("clipPath", { id: "plotClip" });
  clip.append(svg("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB }));
  defs.append(clip);
  s.append(defs);
  for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) {
    s.append(svg("line", { class: "grid", x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const tx = svg("text", { class: "axis", x: 6, y: y(v) + 4 });
    tx.textContent = v.toFixed(2);
    s.append(tx);
  }
  const withLim = pts.map((m, i) => [m.n, lims[i]]).filter(([, l]) => l);
  if (withLim.length > 1) {
    const top = withLim.map(([n, l]) => `${x(n)},${y(l[1])}`), bot = withLim.slice().reverse().map(([n, l]) => `${x(n)},${y(l[0])}`);
    s.append(svg("polygon", { class: "band", points: top.concat(bot).join(" "), "clip-path": "url(#plotClip)" }));
    const last = withLim.at(-1)[1];
    if (last[0] < lo || last[1] > hi) {
      const note = svg("text", { class: "axis band-note", x: W - padR - 6, y: padT + 14, "text-anchor": "end" });
      note.textContent = t("chart.bandOut", last[0].toFixed(2), last[1].toFixed(2));
      s.append(note);
    }
  }
  s.append(svg("polyline", { class: "line", points: pts.map((m, i) => `${x(m.n)},${y(refs[i])}`).join(" ") }));
  s.append(svg("circle", { class: "last", cx: x(n1), cy: y(refs.at(-1)), r: 3.5 }));
  for (const f of mine) if (f.n >= n0) s.append(svg("circle", { class: f.side === "buy" ? "mine-buy" : "mine-sell", cx: x(f.n), cy: y(Number(f.px)), r: 4 }));
  for (const [n, anchor] of [[n0, "start"], [n1, "end"]]) {
    const tx = svg("text", { class: "axis", x: x(n), y: H - 6, "text-anchor": anchor });
    tx.textContent = `${clock(C.sweepTimeMs(n))} · #${n}`;
    s.append(tx);
  }
  mount("chart", s);
}

function renderRival() {
  const ps = posMsgs();
  const kids = [];
  if (!ps.length) kids.push(h("div", { class: "muted" }, t("rival.wait")));
  else {
    const last = ps.at(-1);
    const back = (k) => ps.filter((m) => m.n <= last.n - k).at(-1) || null;
    const h1 = back(12), d1 = back(288);
    const delta = (cur, old, d = 0) => {
      if (old === null || old === undefined) return h("span", { class: "faint" }, t("rival.noData"));
      const v = Number(cur) - Number(old);
      return h("span", { class: v > 0 ? "delta-up" : v < 0 ? "delta-down" : "muted" }, `${v > 0 ? "+" : ""}${group(v, d)}`);
    };
    const spark = (key) => {
      const vals = ps.slice(-288).map((m) => Number(m[key]));
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const s = svg("svg", { class: "spark", viewBox: "0 0 100 30", preserveAspectRatio: "none" });
      const d = vals.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, vals.length - 1)) * 100},${28 - ((v - mn) / Math.max(1e-9, mx - mn)) * 26}`).join(" ");
      s.append(svg("path", { d }));
      return s;
    };
    const card = (label, key, d) => h("div", { class: "rival-card" }, h("div", { class: "small muted" }, label),
      h("div", { class: "v" }, group(last[key], d)),
      h("div", { class: "small deltas" }, h("span", {}, `${t("rival.h1")} `, delta(last[key], h1 && h1[key], d)), h("span", {}, `${t("rival.h24")} `, delta(last[key], d1 && d1[key], d))),
      spark(key));
    kids.push(h("div", { class: "rival-grid" }, card(t("rival.open"), "open", 0), card(t("rival.longs"), "longs", 0), card(t("rival.shorts"), "shorts", 0)),
      h("div", { class: "note" }, t("rival.asOf", last.n)));
  }
  kids.push(renderTape());
  mount("rival", kids);
}

/** Odalarda gorulen son iki imzali islemler (Binance'teki "piyasa islemleri" gibi). Renk: kabul edenin yonu. */
/**
 * Tur esleme denetimi: odalarda gordugumuz islem kayitlarindan, hakemin listelerinde id'si gecenler icin
 * kayit zamanindan hesaplanan tur, id'nin listelendigi turlardan biri mi? Cikarimin dayandigi varsayimi canli veride sinar.
 */
function sweepCheck() {
  const listed = new Map();
  const fm = flowMsgs();
  for (const m of fm) for (const e of C.flowEntries(m)) (listed.get(e.id) || listed.set(e.id, new Set()).get(e.id)).add(m.n);
  const ns = fm.map((m) => m.n).filter(Number.isInteger);
  const lo = Math.min(...ns), hi = Math.max(...ns);
  let match = 0, total = 0;
  for (const [id, recs] of S.tradeRecs) {
    const set = listed.get(id);
    if (!set) continue;
    const calc = recs.map((r) => C.sweepOfTime(Date.parse(r.ts))).filter((n) => n >= lo && n <= hi);
    if (!calc.length) continue;
    total++;
    if (calc.some((n) => set.has(n))) match++;
  }
  return { match, total };
}

const byTsDesc = (a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0);

function renderTape() {
  const rows = [...S.trades.values()].sort(byTsDesc).slice(0, 40);
  const me = myDid();
  return h("div", { class: "tape" },
    h("div", { class: "tape-head" }, h("span", { class: "panel-title" }, t("tape.title")),
      h("span", { class: "small muted" }, t("tape.note"))),
    rows.length ? h("div", { class: "tape-rows" },
      h("div", { class: "tape-row tape-cols" }, h("span", {}, t("tape.time")), h("span", {}, t("col.price")), h("span", {}, t("col.qty")), h("span", {}, t("tape.referee"))),
      rows.map((tr) => {
        const takerSide = tr.terms.side === "buy" ? "sell" : "buy";
        const mine = me && (tr.terms.maker === me || tr.taker === me);
        const [cls, long, shortTxt] = stateLabel(mine ? myTradeState(tr) : tradeState(tr.terms.id, tr.ts));
        return h("div", { class: `tape-row${mine ? " mine" : ""}` },
          h("span", { class: "faint" }, tr.ts ? clockS(Date.parse(tr.ts)) : "—"),
          h("span", { class: takerSide === "buy" ? "bid" : "ask" }, amt(tr.terms.px)),
          h("span", {}, amt(tr.terms.qty)),
          h("span", { class: `st-${cls}`, title: long }, shortTxt));
      })) : h("div", { class: "empty small" }, t("tape.empty")));
}

function renderTicket() {
  const snap = snapshot();
  const next = C.nextSweep();
  if (!S.form.touchedPx && snap.ref) S.form.px = snap.ref;
  if (!S.form.touchedUntil) S.form.until = String(next + 6);
  const side = S.ui.side;
  const L = myLedger();
  const cash = L.low.cash;                 // maks miktar icin nakdi az olan defter
  const cw = S.settings.closeWidth;
  const f = readForm();
  const inp = (key, attrs = {}) => {
    const el = h("input", { class: "input", value: S.form[key], inputmode: "decimal", spellcheck: "false", ...attrs });
    el.addEventListener("input", () => {
      S.form[key] = el.value;
      if (key === "px") S.form.touchedPx = true;
      if (key === "until") S.form.touchedUntil = true;
      renderTicketSummary();
    });
    return el;
  };
  const setQtyFrac = (frac) => {
    const px = C.AMOUNT_RE.test(S.form.px) ? C.formatAmount(S.form.px) : null;
    if (!px) return toast(t("ticket.priceFirst"), "fail");
    let q = null;
    try {
      q = C.maxQty({ cash, px, side, ref: snap.ref || px, closeWidth: cw, fraction: frac });
    } catch (e) {
      return toast(e.message || String(e), "fail");
    }
    S.form.qty = q || "";
    if (!q) toast(t("ticket.noFit"), "fail");
    renderTicket();
  };
  const canSign = S.id.mode === "key" || S.id.mode === "external";
  const reg = registrationState();
  mount("ticketMeta", !L.fills.length ? t("ticket.cash", group(L.direct.cash)) + t("ticket.assumed")
    : L.direct.cash === L.est.cash ? t("ticket.cash", group(L.direct.cash))
      : t("ticket.cash2", group(L.direct.cash), group(L.est.cash)));
  mount("ticket",
    h("div", { class: "seg" },
      h("button", { type: "button", class: side === "buy" ? "on-buy" : "", onclick: () => { S.ui.side = "buy"; renderTicket(); } }, t("ticket.long")),
      h("button", { type: "button", class: side === "sell" ? "on-sell" : "", onclick: () => { S.ui.side = "sell"; renderTicket(); } }, t("ticket.short"))),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.price")),
      h("button", { class: "chip", type: "button", onclick: () => { S.form.touchedPx = false; renderTicket(); } }, t("ticket.toRef"))), inp("px")),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.qty")), h("span", { class: "faint" }, t("ticket.min", C.CONTEST.minQty))), inp("qty"),
      h("div", { class: "chips" }, [[LANG === "tr" ? "%25" : "25%", "0.25"], [LANG === "tr" ? "%50" : "50%", "0.5"], [LANG === "tr" ? "%75" : "75%", "0.75"], [t("ticket.max"), "1"]].map(([lbl, fr]) =>
        h("button", { class: "chip", type: "button", onclick: () => setQtyFrac(fr) }, lbl)))),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.scenario")), h("span", { class: "faint" }, t("ticket.scenarioNote"))),
      h("div", { class: "chips" }, ["0.01", "0.02", "0.03", "0.05"].map((w) => h("button", {
        class: `chip${cw === w ? " on" : ""}`, type: "button", "aria-pressed": cw === w ? "true" : "false", onclick: () => { S.settings.closeWidth = w; saveSettings(); renderTicket(); },
      }, LANG === "tr" ? `%${Number(w) * 100}` : `${Number(w) * 100}%`)))),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.until")), h("span", { class: "faint", id: "untilClock" }, "")), inp("until", { inputmode: "numeric" }),
      h("div", { class: "chips" }, [3, 6, 12, 72].map((k) =>
        h("button", { class: "chip", type: "button", onclick: () => { S.form.until = String(next + k); S.form.touchedUntil = true; renderTicket(); } }, t("ticket.plus")[k])))),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.taker")), h("span", { class: "faint" }, t("ticket.takerNote"))), inp("taker")),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("ticket.room"))),
      (() => {
        const sel = h("select", { class: "input" },
          h("option", { value: "close1-offers|close-call.offer.v1" }, t("ticket.roomQuiet")),
          h("option", { value: "close1|offer" }, t("ticket.roomBusy")));
        sel.value = `${S.settings.offerRoom}|${S.settings.offerFormat}`;
        sel.addEventListener("change", () => { [S.settings.offerRoom, S.settings.offerFormat] = sel.value.split("|"); saveSettings(); });
        return sel;
      })()),
    h("div", { id: "ticketSummary" }),
    h("button", { class: `btn block ${side === "buy" ? "buy" : "sell"}`, type: "button", disabled: !canSign || !!f.error, onclick: offerFlow },
      canSign ? t("ticket.send", sideTr(side)) : t("ticket.needId")),
    !canSign ? h("div", { class: "note" }, t("ticket.needIdNote")) : null,
    h("div", { class: "section reg" },
      reg ? h("div", { class: "small" }, t("ticket.reg"),
        reg.state === "registered" ? h("span", { class: reg.level === "kesin" ? "bid" : "warnc" }, t(`reg.${reg.source}`, reg.n))
          : reg.state === "not_owner" ? h("span", { class: "ask" }, t("reg.notOwner"))
            : reg.state === "pending" ? h("span", { class: "muted" }, t("reg.pending", reg.n))
              : h("span", { class: "muted" }, t("ticket.regUnknown"))) : null,
      h("button", { class: "btn block ghost", type: "button", disabled: !canSign, onclick: registerFlow }, t("ticket.register"))),
  );
  renderTicketSummary();
}

function renderTicketSummary() {
  const el = $("ticketSummary");
  if (!el) return;
  const uc = $("untilClock");
  const until = Number(S.form.until);
  if (uc) uc.textContent = Number.isInteger(until) ? `≈ ${clock(C.sweepTimeMs(until))}` : "";
  const f = readForm();
  const snap = snapshot();
  if (f.error) return el.replaceChildren(h("div", { class: "note" }, f.error));
  const side = S.ui.side, cw = S.settings.closeWidth;
  const ref = snap.ref || f.px;
  const L = myLedger();
  const fr = C.feeRange({ side, qty: f.qty, px: f.px, ref, width: cw });
  const worst = C.worstClose({ side, ref, closeWidth: cw });
  const need = C.fundsNeeded({ cash: L.low.cash, lots: L.low.lots, side, qty: f.qty, px: f.px, close: worst });
  const scen = ["0.95", "0.98", "1.00", "1.02", "1.05"].map((k) => fmt(dec(ref) * dec(k) / 1_000_000n, 2));
  const one = C.localLedger([{ side, qty: f.qty, px: f.px, close: f.px }]);
  const terms = { id: "onizleme", maker: myDid() || C.CONTEST.refereeDid, px: f.px, qty: f.qty, side, taker: f.taker, until: f.until };
  const check = enrichChecks(preflightBoth({ kind: "teklif", terms, myDid: myDid(), referee: S.conn.ok ? snap : null,
    side, closeWidth: cw, margin: S.settings.margin, lang: LANG }, L), myDid() ? "teklif" : "onizleme", L);
  const det = h("details", { class: "checks-box", open: S.ui.checksOpen || check.blocking },
    h("summary", {}, h("span", {}, t("checks.title")), checksSummary(check)), checksView(check));
  det.addEventListener("toggle", () => { S.ui.checksOpen = det.open; });
  el.replaceChildren(
    h("div", { class: "summary" },
      h("div", { class: "sum-row" }, h("span", { class: "muted" }, t("sum.collateral")), h("span", { class: "v" }, `${group(Number(f.qty) * Number(f.px))} POLF`)),
      h("div", { class: "sum-row" }, h("span", { class: "muted" }, t("sum.fee", fr.closes[0], fr.closes[1])), h("span", { class: "v" }, `${group(fr.min)} – ${group(fr.max)}`)),
      h("div", { class: "sum-row" }, h("span", { class: "muted" }, t("sum.need", worst)), h("span", { class: `v ${need.ok ? "" : "ask"}` }, `${group(need.need)} / ${group(need.cash)}`))),
    h("table", { class: "scen" },
      h("thead", {}, h("tr", {}, h("th", {}, "Final S"), ...scen.map((s) => h("th", {}, s)))),
      h("tbody", {}, h("tr", {}, h("td", {}, t("sum.score")), ...scen.map((s) => {
        const v = Number(one.scoreAt(s));
        return h("td", { class: v >= 0 ? "bid" : "ask" }, `${v >= 0 ? "+" : ""}${group(v, 0)}`);
      })))),
    h("div", { class: "note" }, t("sum.note")),
    det,
  );
}

function statusOf(entry) {
  const ok = entry.status >= 200 && entry.status < 300;
  if (!ok) return ["fail", t("st.notSent")];
  const ts = (entry.posted && entry.posted.ts) || entry.time;
  if (entry.kind === "kayit") {
    const r = entry.did === myDid() ? registrationState() : null;
    if (r && r.state === "registered" && r.level === "kesin") return ["ok", t(`reg.${r.source}`, r.n)];
    if (r && r.state === "not_owner") return ["fail", t("reg.notOwner")];
    const n = C.sweepOfTime(Date.parse(ts));
    const m = flowMsgs().find((x) => x.n === n);
    if (!m) return ["unk", t("reg.pending", n)];
    if (Array.isArray(m.missed) && m.missed.length) return ["warn", t("oc.unknown", "missed")];
    return ["ok", t("reg.sent", n)];
  }
  if (entry.kind === "kabul") {
    const rec = (S.tradeRecs.get(entry.id) || []).find((x) => x.taker === entry.did);
    const [cls, long] = stateLabel(rec ? myTradeState(rec) : tradeState(entry.id, ts));
    return [cls, long];
  }
  const tr = S.trades.get(entry.id);
  if (tr) {
    const [cls, long] = stateLabel(myTradeState(tr));
    return [cls, long];
  }
  return ["unk", t("st.noCounter")];
}

function renderTabs() {
  const tabs = [["islemler", t("tab.mine")], ["defter", t("tab.ledger")], ["trades", t("tab.trades")], ["hakkinda", t("tab.about")]];
  mount("tabbar", tabs.map(([k, lbl]) => h("button", { type: "button", class: S.ui.tab === k ? "on" : "", onclick: () => { S.ui.tab = k; renderTabs(); } }, lbl)));
  let body;
  if (S.ui.tab === "islemler") {
    const rows = S.log.slice().reverse().slice(0, 100);
    body = h("div", {},
      h("div", { class: "panel-body row" },
        h("button", { class: "btn", type: "button", disabled: !S.log.length, onclick: () => download("closecall-kanit.jsonl", S.log.map((e) => JSON.stringify(e)).join("\n") + "\n", "application/x-ndjson") }, t("mine.evidence")),
        h("span", { class: "small muted" }, t("mine.evidenceNote"))),
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, t("mine.cols").map((c) => h("th", {}, c)))),
        h("tbody", {}, rows.map((e) => {
          const [cls, txt] = statusOf(e);
          // kabulde bizim yonumuz maker'in tersidir
          const ourSide = e.terms ? (e.kind === "kabul" ? (e.terms.side === "buy" ? "sell" : "buy") : e.terms.side) : null;
          const det = e.terms ? `${sideTr(ourSide)} ${e.terms.qty} @ ${e.terms.px} · ${e.id}` : e.kind === "kayit" ? t("mine.owner") : "";
          return h("tr", {}, h("td", { class: "mono" }, new Date(e.time).toLocaleString(LOC())), h("td", {}, t(`kind.${e.kind}`) || e.kind),
            h("td", {}, e.room), h("td", { class: "mono" }, det), h("td", {}, h("span", { class: `pill ${e.status >= 200 && e.status < 300 ? "ok" : "fail"}` }, String(e.status || "—"))),
            h("td", {}, h("span", { class: `pill ${cls}` }, txt)));
        })))) : h("div", { class: "empty" }, t("mine.none")));
  } else if (S.ui.tab === "defter") {
    const L = myLedger();
    const snap = snapshot();
    const ref = snap.ref || "225.00";
    const scen = ["0.95", "0.98", "1.00", "1.02", "1.05"].map((k) => fmt(dec(ref) * dec(k) / 1_000_000n, 2));
    const nDirect = L.fills.filter((x) => !x.inferred).length;
    const row = (label, a, b) => h("tr", {}, h("td", {}, label), h("td", { class: "num" }, a), h("td", { class: "num" }, b));
    const scoreRow = (Lx) => scen.map((s) => {
      const v = Number(Lx.scoreAt(s));
      return h("td", { class: v >= 0 ? "bid" : "ask" }, `${v >= 0 ? "+" : ""}${group(v, 0)}`);
    });
    const g = L.gaps, parts = [];
    if (g.missed) parts.push(t("gap.missed", g.missed));
    if (g.unreadRooms) parts.push(t("gap.rooms", g.unreadRooms));
    if (g.open) parts.push(t("gap.open", g.open));
    body = h("div", { class: "panel-body" },
      !myDid() ? h("div", { class: "muted" }, t("led.noId")) : h("div", {},
        h("div", { class: "table-wrap" }, h("table", { class: "table ledger" },
          h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", { class: "num" }, t("bal.direct")), h("th", { class: "num" }, t("bal.est")))),
          h("tbody", {},
            row(t("led.cash"), `${group(L.direct.cash)} POLF`, `${group(L.est.cash)} POLF`),
            row(t("led.position"), L.direct.position, L.est.position),
            row(t("led.fees"), group(L.direct.fees), group(L.est.fees)),
            row(t("led.settledCount"), String(nDirect), String(L.fills.length))))),
        h("div", { class: "small muted ledger-counts" }, t("led.counts", L.pending.length, L.voided.length)),
        h("table", { class: "scen" }, h("thead", {}, h("tr", {}, h("th", {}, "Final S"), ...scen.map((s) => h("th", {}, s)))),
          h("tbody", {},
            h("tr", {}, h("td", {}, t("bal.directShort")), ...scoreRow(L.direct)),
            h("tr", {}, h("td", {}, t("bal.estShort")), ...scoreRow(L.est)))),
        h("div", { class: parts.length ? "warnbox" : "note" }, parts.length ? t("gap.found", parts.join(", ")) : t("gap.none")),
        h("div", { class: "note" }, t("led.note")),
        L.fills.some((x) => x.estimatedClose) ? h("div", { class: "warnbox" }, t("led.estClose")) : null));
  } else if (S.ui.tab === "trades") {
    const rows = [...S.trades.values()].sort(byTsDesc).slice(0, 60);
    body = rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, t("trades.cols").map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((tr) => {
        const [cls, long] = stateLabel(tradeState(tr.terms.id, tr.ts));
        return h("tr", {}, h("td", { class: "mono" }, tr.terms.id), h("td", { class: "mono" }, short(tr.terms.maker)), h("td", { class: "mono" }, short(tr.taker)),
          h("td", {}, sideTr(tr.terms.side)), h("td", { class: "num" }, amt(tr.terms.qty)), h("td", { class: "num" }, amt(tr.terms.px)), h("td", {}, tr.room),
          h("td", {}, h("span", { class: `pill ${cls}` }, long)));
      })))) : h("div", { class: "empty" }, t("trades.none"));
  } else {
    const rawCount = S.refRaw.price.length + S.refRaw.flow.length + S.refRaw.positions.length;
    body = h("div", { class: "panel-body small about" },
      h("p", {}, t("about.p1", VERSION)),
      h("p", {}, t("about.referee"), h("span", { class: "mono" }, REFEREE), TEST ? h("b", { class: "ask" }, t("about.test")) : null),
      h("p", {}, t("about.conn", LOCAL)),
      h("p", {}, t("about.poll", S.conn.badReferee)),
      h("p", {}, t("about.formats", C.OFFER_FORMATS.map((f) => f.t).join(", "), OFFER_ROOMS.join(", "))),
      h("p", {}, t("about.states")),
      h("p", {}, t("about.extra", extraRooms())),
      (() => { const c = sweepCheck(); return h("p", {}, t("about.sweepCheck", c.match, c.total)); })(),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", disabled: !rawCount, onclick: () => download(`hakem-mesajlari-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
          JSON.stringify({ indirilme: new Date().toISOString(), hakem: REFEREE, ...S.refRaw }, null, 1)) }, t("about.raw")),
        h("span", { class: "muted" }, t("about.rawNote"))));
  }
  mount("tabBody", body);
}

function render() {
  renderStats();
  renderBook();
  renderChart();
  renderRival();
  const ae = document.activeElement;
  const typing = ae && $("ticket").contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "SELECT");
  if (!typing) renderTicket();
  else renderTicketSummary();
  renderTabs();
  $("footVer").textContent = t("foot.version", VERSION) + (TEST ? t("foot.test") : "");
}

// ------------------------------------------------------------------ basla
$("idChip").addEventListener("click", openIdentity);
for (const b of document.querySelectorAll("#langSwitch button")) b.addEventListener("click", () => setLang(b.dataset.lang));
applyStatic();
$("dlg").addEventListener("cancel", () => { const f = dialogCancel; dialogCancel = null; if (f) f(); });
window.addEventListener("resize", () => renderChart());
render();
poll();
setInterval(poll, 1000);          // her saniye bakar; her oda kendi araliginda okunur (POLL_PLAN)
setInterval(renderStats, 1000);
