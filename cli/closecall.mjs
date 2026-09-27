#!/usr/bin/env node
// Close Call komut satiri (Windows PowerShell 5.1 dahil). Komut satirina JSON yazilmaz; JSON gereken
// yerde dosya verilir, boylece PowerShell tirnak sorunu olmaz.
//
// Guvenlik ve ag davranisi:
//  - Ozel anahtar yalniz --anahtar ile verilen yerel dosyadan okunur; hicbir yere yazilmaz, gonderilmez.
//  - `did`, `imzala`, `dogrula`, `defter`, `ucret`, `maks`, `fold` komutlari AGA HIC CIKMAZ.
//  - `durum`, `kayit`, `teklif`, `kabul` hakem odalarini YALNIZ OKUR (kontrol listesi icin); --cevrimdisi ile okumaz.
//  - Bir mesaji GONDERMEK yalniz --gonder ile olur. Varsayilan kuru calismadir.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as C from "../src/core.mjs";
import { replay } from "../src/fold.mjs";

const VERSION = "0.3.5";
const NONCE_FILE = "closecall-nonce.json";
const LOG_FILE = "kayitlar.jsonl";

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`beklenmeyen arguman: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd, opts };
}

const has = (opts, k) => opts[k] !== undefined && opts[k] !== true;

function need(opts, key, hint) {
  if (!has(opts, key)) throw new Error(`--${key} gerekli${hint ? ` (${hint})` : ""}`);
  return String(opts[key]);
}

function readText(path) {
  const buf = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
}

async function signerFrom(opts) {
  const path = need(opts, "anahtar", "ozel anahtar JSON dosyasi, ornek C:\\dev\\anahtar.json");
  return C.importSigner(readFileSync(path, "utf8"));
}

function nonceFor(did, room, opts) {
  const store = existsSync(NONCE_FILE) ? JSON.parse(readFileSync(NONCE_FILE, "utf8")) : {};
  const k = `${did}|${room}`;
  let last = store[k];
  if (has(opts, "nonce-min")) {
    const m = BigInt(String(opts["nonce-min"]));
    if (!last || m > BigInt(last)) last = m.toString();
  }
  const n = C.nextNonce(last);
  store[k] = n;
  writeFileSync(NONCE_FILE, JSON.stringify(store, null, 2));
  return n;
}

function log(entry) {
  appendFileSync(LOG_FILE, JSON.stringify({ zaman: new Date().toISOString(), surum: VERSION, ...entry }) + "\n");
}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Hakem fiyat ve akis odalarini okur (yalniz okuma), imzalarini dogrular, anlik durumu dondurur. */
async function readReferee(opts) {
  if (opts.cevrimdisi) return { snapshot: null, note: "cevrimdisi: hakem odalari okunmadi" };
  const base = C.CONTEST.service, R = C.CONTEST.refereeRooms;
  try {
    const out = {};
    let bad = 0;
    for (const [key, room, limit] of [["price", R.price, 6], ["flow", R.flow, 200]]) {
      const data = C.parseRoomJson(await fetchText(`${base}/r/${room}?format=json&limit=${limit}`));
      const msgs = [];
      for (const rec of data.messages || []) {
        if (await C.verifyRefereeRecord(room, rec)) {
          const m = C.refereeMessage(rec);
          if (m) msgs.push(m);
        } else bad++;
      }
      out[key] = msgs;
    }
    const snapshot = C.refereeSnapshot({ priceMessages: out.price, flowMessages: out.flow });
    return { snapshot, note: bad ? `${bad} kayit hakem imzasini tasimadigi icin yok sayildi` : "" };
  } catch (e) {
    return { snapshot: null, note: `hakem odalari okunamadi: ${e && e.message ? e.message : e}` };
  }
}

/** Bu klasorun gonderim kaydinda (kayitlar.jsonl) bir islem kimliginin basariyla gonderildigi zaman. */
function sentTimeOf(id) {
  if (!existsSync(LOG_FILE)) return null;
  let found = null;
  for (const line of readFileSync(LOG_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const ok = typeof e.durum === "number" && e.durum >= 200 && e.durum < 300;
      if (ok && typeof e.metin === "string" && e.metin.includes(`"id":"${id}"`) && e.metin.includes('"t":"trade"')) found = e.zaman;
    } catch { /* bozuk satir */ }
  }
  return found;
}

const TAG = { ok: "[ TAMAM ]", fail: "[ HATA  ]", uyari: "[ UYARI ]", bilinmiyor: "[   ?   ]" };

// Cekirdegin kontrol metinleri Turkce karakterli; PowerShell 5.1 konsolunda bozulmasin diye ASCII'ye cevrilir.
const TR_ASCII = { "ç": "c", "Ç": "C", "ğ": "g", "Ğ": "G", "ı": "i", "İ": "I", "ö": "o", "Ö": "O", "ş": "s", "Ş": "S", "ü": "u", "Ü": "U" };
const ascii = (s) => String(s).replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => TR_ASCII[ch]);

function printChecks(result, note) {
  console.log("\nKontrol listesi (imzanin gecerli olmasi islemin gerceklesecegi anlamina gelmez):");
  for (const c of result.checks) console.log(`  ${TAG[c.status]} ${ascii(c.label)}: ${ascii(c.detail)}`);
  if (note) console.log(`  not: ${note}`);
}

function ledgerFrom(opts) {
  // Basit yerel defter: --nakit verilirse acik pozisyon olmadigi varsayilir.
  return has(opts, "nakit") ? { cash: C.formatAmount(String(opts.nakit)), lots: [] } : null;
}

async function sendOrShow(signed, opts, komut, blocking) {
  const link = C.sayUrl(signed);
  console.log(`\nOda   : ${signed.room}\nDID   : ${signed.did}\nNonce : ${signed.nonce}\nMetin : ${signed.text}`);
  if (blocking) {
    console.log("\nGONDERILMEDI: kontrol listesinde HATA var.");
    log({ komut, oda: signed.room, did: signed.did, nonce: signed.nonce, metin: signed.text, durum: "engellendi" });
    process.exitCode = 2;
    return;
  }
  if (!opts.gonder) {
    console.log("\nKURU CALISMA: hicbir sey gonderilmedi.");
    console.log("Gondermek icin ayni komutu --gonder ile calistir. (Tarayicida acilabilecek imzali link:)");
    console.log(link);
    log({ komut, oda: signed.room, did: signed.did, nonce: signed.nonce, metin: signed.text, imza: signed.sig, durum: "kuru" });
    return;
  }
  const { url, init } = C.postRequest(signed);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let status = "hata", body = "";
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    status = res.status;
    body = (await res.text()).slice(0, 600);
  } catch (e) {
    body = String(e && e.message || e);
  } finally {
    clearTimeout(timer);
  }
  console.log(`\nSunucu yaniti: ${status}\n${body}`);
  console.log("Not: sunucunun mesaji almasi hakemin kabul ettigi anlamina gelmez; sonucu sonraki turlarda 'durum' ile kontrol et.");
  log({ komut, oda: signed.room, did: signed.did, nonce: signed.nonce, metin: signed.text, imza: signed.sig, durum: status, yanit: body });
}

const HELP = `Close Call komut satiri (closecall-core ${VERSION})

AGA CIKMAYANLAR
  did      --anahtar <dosya>                           DID ve parmak izini goster
  imzala   --anahtar <dosya> (--metin-dosya <dosya> | --metin <metin>)   harici imza yardimcisi
  dogrula  --export <close1.jsonl[.gz]> [--oda close1]  oda kaydindaki imzalari dogrula
  defter   --export <dosya> [--oda close1] --sonraki-tur <n> --ref <fiyat>
  ucret    --yon long|short --miktar <q> --fiyat <p> --ref <fiyat> [--genislik 0.01]
  maks     --nakit <polf> --fiyat <p> --yon long|short [--ref <fiyat>] [--kapanis-payi 0.02] [--oran 1]
  fold     --olaylar <sezon.jsonl> [--config contest.json]

HAKEMI OKUYANLAR (yalniz okuma; --cevrimdisi ile okumaz). Gondermek yalniz --gonder ile.
  durum    [--did <did>] [--id <islem-id> [--zaman <ISO>]]   --id: bu klasorden gonderilen islemin hakem sonucu
  kayit    --anahtar <dosya> [--oda close1] [--gonder]
  teklif   --anahtar <dosya> --yon long|short --miktar <q> --fiyat <p> --son-tur <n>
           [--karsi any|<did>] [--bicim offer|close-call.offer.v1] [--oda close1] [--id <id>]
           [--nakit <polf>] [--kapanis-payi 0.02] [--gonder]
  kabul    --anahtar <dosya> --teklif-dosya <dosya> [--oda close1] [--nakit <polf>] [--kapanis-payi 0.02] [--kendinle] [--gonder]
           --kendinle: kendi teklifini kabul et (kural 12: iki tarafin ucreti odenir, pozisyon degismez)

Ortak: --nonce-min <n> (odada daha buyuk bir nonce kullanildiysa), --cevrimdisi`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const room = has(opts, "oda") ? String(opts.oda) : C.CONTEST.tradingRoom;
  const closeWidth = has(opts, "kapanis-payi") ? String(opts["kapanis-payi"]) : "0.02";
  switch (cmd) {
    case "did": {
      const s = await signerFrom(opts);
      console.log(`DID        : ${s.did}\nParmak izi : ${await C.fingerprint(s.did)}`);
      break;
    }
    case "durum": {
      const { snapshot: r, note } = await readReferee(opts);
      const now = Date.now();
      console.log(`Saat (UTC)            : ${new Date(now).toISOString()}`);
      console.log(`Saate gore son tur    : ${C.lastScheduledSweep(now)}  | simdi gonderilen mesaj en erken: ${C.nextSweep(now)}. tur`);
      if (!r) {
        console.log(`Hakem                 : okunamadi (${note})`);
        break;
      }
      console.log(`Hakemin son turu      : ${r.lastSweep ?? "?"}  | gecikme: ${r.lag ?? "?"} tur`);
      console.log(`Referans              : ${r.ref ?? "?"} (islem zamani ${r.refTime ?? "?"})  | bant: ${r.limits ? r.limits.join(" - ") : "?"}`);
      console.log(`Okunan akis mesaji    : ${r.flowMessages.length}${C.flowIsPartial(r.flowMessages) ? " (kisaltilmis/eksik alanlar var)" : ""}`);
      if (has(opts, "did")) {
        const f = C.findInFlow(r.flowMessages, { did: String(opts.did) });
        console.log(`DID akista            : ${f.hits.length ? "goruluyor" : "gorulmedi"}${!f.hits.length && f.partial ? " (liste kisaltilmis; ret kaniti degil)" : ""}`);
      }
      if (has(opts, "id")) {
        const id = String(opts.id);
        const ts = has(opts, "zaman") ? String(opts.zaman) : sentTimeOf(id);
        const st = C.tradeStatus({ id, ts: ts || "", flowMessages: r.flowMessages });
        const text = {
          settled: `settled (tur ${st.n}, hakem listesinde)`,
          settled_inferred: `~ settled (CIKARIM: tur ${st.n} void listesi tam ve id orada yok)`,
          void: `void - ${st.reason} (tur ${st.n}, hakem listesinde)`,
          pending: `tur ${st.n} bekleniyor (hakem o turu henuz yayimlamadi)`,
        }[st.state] || `bilinmiyor (${{ truncated: `tur ${st.n} void listesi kisaltilmis`, missed: `tur ${st.n} hakem okuma boslugu`, window: `tur ${st.n} okunan pencerenin disinda`, no_time: "gonderim zamani yok: --zaman <ISO> ver" }[st.source] || st.source})`;
        console.log(`Islem ${id} : ${text}`);
      }
      if (note) console.log(`not: ${note}`);
      break;
    }
    case "kayit": {
      const s = await signerFrom(opts);
      const { snapshot, note } = await readReferee(opts);
      const pf = C.preflight({ kind: "kayit", myDid: s.did, referee: snapshot });
      printChecks(pf, note);
      await sendOrShow(await C.signRoomMessage(s, room, C.ownerText(s.did), nonceFor(s.did, room, opts)), opts, "kayit", pf.blocking);
      break;
    }
    case "teklif": {
      const s = await signerFrom(opts);
      const yon = need(opts, "yon", "long ya da short");
      if (yon !== "long" && yon !== "short") throw new Error("--yon long ya da short olmali");
      const side = yon === "long" ? "buy" : "sell";
      const terms = C.makeTerms({
        id: has(opts, "id") ? String(opts.id) : C.newTradeId(),
        maker: s.did, side, qty: C.formatAmount(need(opts, "miktar")), px: C.formatAmount(need(opts, "fiyat")),
        taker: has(opts, "karsi") ? String(opts.karsi) : "any",
        until: Number(need(opts, "son-tur", "teklifin gecerli oldugu son sweep numarasi; 'durum' en erken turu gosterir")),
      });
      const { snapshot, note } = await readReferee(opts);
      const pf = C.preflight({ kind: "teklif", terms, myDid: s.did, referee: snapshot, ledger: ledgerFrom(opts), side, closeWidth });
      printChecks(pf, note);
      const makerSig = await s.sign(C.makerPayload(terms));
      const text = C.offerText(terms, makerSig, has(opts, "bicim") ? String(opts.bicim) : "offer");
      if (!pf.blocking) {
        const file = `teklif-${terms.id}.json`;
        writeFileSync(file, text);
        console.log(`\nImzali teklif ${file} dosyasina yazildi. Yayimlanmis imzali teklifin protokolde iptali yok; kisa son-tur sec.`);
      }
      await sendOrShow(await C.signRoomMessage(s, room, text, nonceFor(s.did, room, opts)), opts, "teklif", pf.blocking);
      break;
    }
    case "kabul": {
      const s = await signerFrom(opts);
      const raw = readText(need(opts, "teklif-dosya")).trim();
      const [offer] = C.extractOffers(room, [{ seq: 0, ts: "", from: "", text: raw }]);
      if (!offer) throw new Error("Dosyada desteklenen bicimde bir teklif yok.");
      const ourSide = offer.terms.side === "buy" ? "sell" : "buy";
      console.log(`Teklif: maker ${offer.terms.side === "buy" ? "LONG" : "SHORT"} ${offer.terms.qty} @ ${offer.terms.px}, son tur ${offer.terms.until}, maker ${C.shortDid(offer.terms.maker)}`);
      console.log(`Senin tarafin: ${ourSide === "buy" ? "LONG (alis)" : "SHORT (satis)"}`);
      const makerSigOk = await C.verifyOffer(offer);
      const { snapshot, note } = await readReferee(opts);
      const pf = C.preflight({ kind: "kabul", terms: offer.terms, makerSigOk, myDid: s.did, referee: snapshot,
        ledger: ledgerFrom(opts), side: ourSide, closeWidth });
      printChecks(pf, note);
      if (!makerSigOk) {
        console.log("\nGONDERILMEDI: maker imzasi gecersiz.");
        process.exitCode = 2;
        break;
      }
      const self = offer.terms.maker === s.did;
      if (self && opts.kendinle !== true) {
        console.log("\nGONDERILMEDI: bu senin kendi teklifin. Bilerek kendinle islem yapmak istiyorsan --kendinle ekle.");
        process.exitCode = 2;
        break;
      }
      if (self) console.log("\nKendinle islem (kural 12): iki tarafin ucreti senden duser (toplam ~%2), pozisyonun degismez. Hakem yalniz ucretleri karsilayip karsilayamadigina bakar.");
      const text = await C.acceptOffer(s, offer, { allowSelf: self });
      await sendOrShow(await C.signRoomMessage(s, room, text, nonceFor(s.did, room, opts)), opts, "kabul", pf.blocking);
      break;
    }
    case "imzala": {
      const s = await signerFrom(opts);
      const msg = has(opts, "metin-dosya") ? readFileSync(String(opts["metin-dosya"]), "utf8").replace(/^﻿/, "").replace(/\r?\n$/, "") : need(opts, "metin");
      console.log(await s.sign(msg));
      break;
    }
    case "dogrula": {
      const recs = C.parseExportJsonl(readText(need(opts, "export")));
      let okRoom = 0;
      for (const r of recs) if (await C.verifyRoomRecord(room, r)) okRoom++;
      const offers = C.extractOffers(room, recs), trades = C.extractTrades(room, recs);
      let okO = 0, okT = 0;
      for (const o of offers) if (await C.verifyOffer(o)) okO++;
      for (const t of trades) if (await C.verifyTrade(t)) okT++;
      console.log(`Kayit: ${recs.length} | oda imzasi gecerli: ${okRoom}`);
      console.log(`Teklif: ${offers.length} | maker imzasi gecerli: ${okO}`);
      console.log(`Islem : ${trades.length} | iki imza gecerli: ${okT}`);
      break;
    }
    case "defter": {
      const recs = C.parseExportJsonl(readText(need(opts, "export")));
      const offers = C.extractOffers(room, recs);
      for (const o of offers) o.verified = await C.verifyOffer(o);
      const takenIds = new Set();
      for (const t of C.extractTrades(room, recs)) if (await C.verifyTrade(t)) takenIds.add(t.terms.id);
      const book = C.buildBook(offers, { nextSweep: Number(need(opts, "sonraki-tur", "kaydin alindigi andaki en erken tur")),
        ref: need(opts, "ref"), takenIds });
      console.log(`Bant: ${book.band.join(" - ")} | en iyi alis ${book.bestBid ?? "-"} | en iyi satis ${book.bestAsk ?? "-"}`);
      for (const l of [...book.asks].reverse()) console.log(`  SATIS ${l.px}  ${l.qty}  (${l.count}${l.tight ? `, ${l.tight} sinirda` : ""})`);
      console.log("  ------");
      for (const l of book.bids) console.log(`  ALIS  ${l.px}  ${l.qty}  (${l.count}${l.tight ? `, ${l.tight} sinirda` : ""})`);
      console.log(`Karsi imzali (hakem sonucu bekleniyor) ${book.counts.taken}, bant disi ${book.outOfBand.length}, ozel ${book.reserved.length}, suresi gecmis ${book.counts.expired}, dogrulanmamis ${book.counts.unverified}, tekrar ${book.counts.duplicates}`);
      break;
    }
    case "ucret": {
      const yon = need(opts, "yon");
      const r = C.feeRange({ side: yon === "long" ? "buy" : "sell", qty: C.formatAmount(need(opts, "miktar")),
        px: C.formatAmount(need(opts, "fiyat")), ref: need(opts, "ref"), width: has(opts, "genislik") ? String(opts.genislik) : "0.01" });
      console.log(`Tur kapanisi ${r.closes[0]} - ${r.closes[1]} arasinda olursa ucretin ${r.min} - ${r.max} POLF`);
      break;
    }
    case "maks": {
      const yon = need(opts, "yon");
      const side = yon === "long" ? "buy" : "sell";
      const px = C.formatAmount(need(opts, "fiyat"));
      const ref = has(opts, "ref") ? String(opts.ref) : px;
      const q = C.maxQty({ cash: need(opts, "nakit"), px, side, ref, closeWidth, fraction: has(opts, "oran") ? String(opts.oran) : "1" });
      const worst = C.worstClose({ side, ref, closeWidth });
      console.log(q ? `Temel ucret degil, kapanis ${worst} senaryosuna gore en buyuk miktar: ${q}` : "Bu senaryoda en az 0,10 bile sigmiyor.");
      break;
    }
    case "fold": {
      const lines = readText(need(opts, "olaylar")).split("\n");
      let cfg = null;
      if (has(opts, "config")) {
        const c = JSON.parse(readFileSync(String(opts.config), "utf8"));
        cfg = Object.fromEntries(["mint", "min_qty", "limit_window", "fee_rate", "fee_rule", "lock_sweep", "prize_places"]
          .filter((k) => k in c).map((k) => [k, c[k]]));
      }
      console.log(JSON.stringify(replay(lines, cfg), null, 2));
      break;
    }
    case "surum":
      console.log(VERSION);
      break;
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`Hata: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
