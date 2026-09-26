#!/usr/bin/env node
// YALNIZ TEST: technocore.chat'in arayuzun kullandigi kismini taklit eden sahte sunucu.
//  - GET  /r/<oda>?format=json&limit&since   (en yeni `limit` <= 200 mesaj, since'ten sonra; gercek store.read_messages gibi)
//  - GET  /r/<oda>/export                     (JSONL)
//  - POST /r/<oda>  {did, sig, nonce, text}   (imza ve artan nonce kontrolu; gercek app.room_post gibi, nonce METIN)
//  - GET  /__mock/info, /__mock/posted        (test icin: hakem DID'i ve POST ile gelen kayitlar)
//  - POST /__mock/sweep                       (test icin: sahte hakem bir tur yayimlar, gelen islemleri sonuclar)
// Hakem mesajlari canli bicimde (26 Eylul, tur 269-271 kayitlarindan): price { age_s, applied, file, for, global,
// limits, n, ref{px,tid,time} }, flow { file, mints, missed, n, omitted{mints,settled,void}, rooms, settled[], unlisted,
// void[[id,neden]] }. Canlidaki gibi yeni islemlerin settled'i listelenmez (yalniz omitted sayisi), void listesi tamdir.
// Kullanim: node tools/ui-test/mock-technocore.mjs [port]
import http from "node:http";
import * as C from "../../src/core.mjs";

const PORT = Number(process.argv[2] || 5299);
const seedHex = (i) => Array.from({ length: 32 }, (_, k) => ((i * 37 + k * 11 + 5) & 255).toString(16).padStart(2, "0")).join("");

const referee = await C.importSigner(seedHex(250));
const makers = [];
for (let i = 1; i <= 6; i++) makers.push(await C.importSigner(seedHex(i)));
const outsider = await C.importSigner(seedHex(40));

const rooms = new Map();            // oda -> { seq, recs: [], nonces: Map(did -> BigInt) }
const posted = [];                  // POST ile gelenler (test dogrulamasi icin)
let hidePostedTrades = false;       // test: POST ile gelen trade mesajlarini okumalardan gizle (kacirilan mesaj benzetimi)
const hiddenSeqs = new Set();
const room = (name) => rooms.get(name) || rooms.set(name, { seq: 1000, recs: [], nonces: new Map() }).get(name);
let clockNonce = BigInt(Date.now()) * 1000n;

function append(name, did, text, sig, nonce, tsMs = Date.now()) {
  const r = room(name);
  r.seq += 1;
  const rec = { seq: r.seq, ts: new Date(tsMs).toISOString().replace(/(\.\d{3})Z$/, "$1000Z"), from: did, text, nonce, sig };
  r.recs.push(rec);
  r.nonces.set(did, BigInt(nonce));
  return rec;
}

async function say(signer, name, textObj, tsMs = Date.now()) {
  const text = typeof textObj === "string" ? textObj : JSON.stringify(textObj);
  clockNonce += 1n;
  const signed = await C.signRoomMessage(signer, name, text, clockNonce.toString());
  return append(name, signer.did, signed.text, signed.sig, signed.nonce, tsMs);
}

const cents = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const R = C.CONTEST.refereeRooms;

// ------------------------------------------------------------------ gecmis
const now = Date.now();
const last = C.lastScheduledSweep(now);
let refCents = 22434;
let lastN = last - 150;
const openInt = { open: 380000, longs: 9800, shorts: 10100 };
const byN = new Map();   // tur -> { settledListed: [], settledHidden: 0, void: [[id, neden]], mints: 0 }
const slot = (n) => byN.get(n) || byN.set(n, { settledListed: [], settledHidden: 0, void: [], mints: 0 }).get(n);
let prevRef = null;

// Hakem n. turun mesajlarini kapanistan hemen sonra yazar; kayit zamani da oyle olsun (yalniz gecmis turlar).
async function publishSweep(n) {
  const old = refCents;
  refCents += Math.round((Math.sin(n / 9) + Math.cos(n / 23)) * 18 + ((n * 7919) % 13) - 6);
  const lo = Math.round(refCents * 0.95), hi = Math.round(refCents * 1.05);
  const file = C.hexEncode(new TextEncoder().encode(String(n))).padEnd(64, "0").slice(0, 64);
  const at = Math.min(Date.now(), C.sweepTimeMs(n) + 25000);
  await say(referee, R.price, { age_s: 40, applied: prevRef ?? cents(old), file, for: n + 1, global: cents(refCents - 3),
    limits: [cents(lo), cents(hi)], n, ref: { px: cents(refCents), tid: 900000 + n, time: new Date(C.sweepTimeMs(n) - 4000).toISOString() }, t: "price" }, at);
  prevRef = cents(refCents);
  const o = slot(n);
  byN.delete(n);
  await say(referee, R.flow, { file, mints: [], missed: [], n, omitted: { mints: o.mints + 3000, settled: o.settledHidden + 1500 },
    rooms: n === last - 3 ? ["close1-offers", "mock-extra"] : [], settled: o.settledListed, t: "flow", unlisted: [], void: o.void }, at);
  openInt.open += ((n * 31) % 900) - 300;
  openInt.longs += (n % 5) - 1;
  openInt.shorts += (n % 7) - 2;
  await say(referee, R.positions, { file, longs: openInt.longs, n, open: cents(openInt.open * 100), shorts: openInt.shorts, t: "positions", top: [] }, at);
  lastN = n;
}

for (let n = last - 150; n <= last - 1; n++) await publishSweep(n);

// Kayitlar ve teklifler (gecen turun penceresinde)
const inLast = C.sweepTimeMs(last) - 120000;
for (const m of makers) {
  await say(m, "close1", C.ownerText(m.did), inLast);
  slot(last).mints++;
}
const next = C.nextSweep(now);
async function offer(maker, roomName, format, side, qty, px, until, taker = "any", id = null) {
  const terms = C.makeTerms({ id: id || C.newTradeId("mk"), maker: maker.did, side, qty, px, taker, until });
  const sig = await maker.sign(C.makerPayload(terms));
  await say(maker, roomName, C.offerText(terms, sig, format), inLast);
  return { terms, makerSig: sig, room: roomName, format };
}
const ref = refCents;
const V1 = "close-call.offer.v1";
await offer(makers[0], "close1-offers", V1, "buy", "1.50", cents(ref - 12), next + 30);
await offer(makers[1], "close1-offers", V1, "buy", "0.80", cents(ref - 25), next + 30);
await offer(makers[2], "close1", "offer", "buy", "2.10", cents(ref - 40), next + 60);
await offer(makers[3], "close1-offers", V1, "sell", "1.20", cents(ref + 10), next + 30);
await offer(makers[4], "close1-offers", V1, "sell", "0.50", cents(ref + 10), next + 30);   // ayni seviye
await offer(makers[5], "close1", "offer", "sell", "3.00", cents(ref + 35), next);         // sinirda (until == next)
await offer(makers[0], "close1-offers", V1, "sell", "0.40", cents(ref + 60), next + 30);
// "224.5" gibi tek ondalikli fiyat: "224.50" ile ayni seviyede birlesmeli
const oneDec = `${Math.floor((ref + 60) / 100)}.${String((ref + 60) % 100).padStart(2, "0")[0]}`;
if (Number(oneDec) * 100 === ref + 60) await offer(makers[1], "close1-offers", V1, "sell", "0.25", oneDec, next + 30);
await offer(makers[2], "close1-offers", V1, "sell", "1.00", cents(Math.round(ref * 1.2)), next + 30);  // bant disi
await offer(makers[3], "close1-offers", V1, "buy", "1.00", cents(ref - 5), last - 10);                 // suresi gecmis
await offer(makers[4], "close1-offers", V1, "buy", "1.00", cents(ref - 7), next + 30, outsider.did);   // baskasina ayrilmis
// Hakemin kayitli dedigi ek odada bir teklif: arayuz bu odayi da okumali
await offer(makers[3], "mock-extra", V1, "buy", "0.33", cents(ref - 20), next + 30);
// Kabul edilirse hakemin void listesinde "funds" ile gorunecek teklif (kaydin kesinlesmesi testi); miktari benzersiz
await offer(makers[4], "close1-offers", V1, "sell", "0.11", cents(ref + 17), next + 30, "any", "voidfunds-1");
// Karsi imzali (alinmis) teklif + hakemce settled
const taken = await offer(makers[5], "close1-offers", V1, "buy", "0.70", cents(ref - 3), next + 30);
const takerSig = await makers[0].sign(C.takerPayload(taken.terms, makers[0].did));
await say(makers[0], "close1", C.tradeText(taken.terms, makers[0].did, taken.makerSig, takerSig), inLast + 1000);
slot(last).settledListed.push(taken.terms.id);           // listelenen settled yolu
slot(last).void.push(["baska-bir-id", "funds"]);
await publishSweep(last);
// Imzasi bozuk teklif: dogrulanmamali ve defterde gorunmemeli
{
  const terms = C.makeTerms({ id: "bozuk-imza", maker: makers[1].did, side: "sell", qty: "9.99", px: cents(ref + 1), until: next + 30 });
  const good = await makers[1].sign(C.makerPayload(terms));
  const bad = good.slice(0, 10) + (good[10] === "A" ? "B" : "A") + good.slice(11);
  await say(makers[1], "close1-offers", C.offerText(terms, bad, V1), inLast);
}

// ------------------------------------------------------------------ http
function json(res, status, obj) {
  const body = JSON.stringify(obj, (k, v) => v).replace(/"nonce":"(\d+)"/g, '"nonce":$1');   // orjson gibi: nonce sayi
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body + "\n");
}
function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function onPost(name, req, res, url) {
  let p;
  try {
    p = JSON.parse(await readBody(req));
  } catch {
    return text(res, 400, "400 body must be JSON");
  }
  for (const k of ["did", "sig", "nonce", "text"]) if (typeof p[k] !== "string") return text(res, 400, `400 ${k} must be a string`);
  if (!/^[0-9]{1,19}$/.test(p.nonce)) return text(res, 400, "400 nonce");
  if (!(await C.verifySignature(p.did, p.sig, C.roomPayload(name, p.nonce, p.text)))) return text(res, 401, "401 signature does not verify");
  const lastNonce = room(name).nonces.get(p.did);
  if (lastNonce !== undefined && BigInt(p.nonce) <= lastNonce) return text(res, 409, `409 nonce must exceed ${lastNonce}`);
  const rec = append(name, p.did, p.text, p.sig, p.nonce);
  posted.push({ room: name, ...rec });
  if (url.searchParams.get("format") === "json") return json(res, 200, { room: name, count: 0, messages: [], posted: rec });
  return text(res, 200, `posted seq ${rec.seq}\n`);
}

// Test icin: su anki turu "erken kapatir". POST ile gelenler kayit zamanlarinin turuna yazilir; canlidaki gibi
// yeni islemlerin settled'i listelenmez (yalniz sayi), void listesi tamdir.
async function sweep() {
  const upto = C.sweepOfTime(Date.now());
  for (const p of posted.filter((x) => !x.swept)) {
    p.swept = true;
    const n = C.sweepOfTime(Date.parse(p.ts));
    if (n <= lastN) continue;                     // o tur zaten yayimlandi: canlida da gec kalan mesaj sayilmaz
    let j = null;
    try { j = JSON.parse(p.text); } catch { /* sohbet */ }
    if (!j) continue;
    if (j.t === "owner") slot(n).mints++;
    if (j.t === "trade") {
      const ok = await C.verifyTrade({ terms: j.terms, taker: j.taker, makerSig: j.maker_sig, takerSig: j.taker_sig });
      if (ok && j.terms.id.startsWith("voidfunds")) slot(n).void.push([j.terms.id, "funds"]);
      else if (ok) slot(n).settledHidden++;
      else slot(n).void.push([j.terms.id, "signature"]);
    }
  }
  for (let n = lastN + 1; n <= upto; n++) await publishSweep(n);
  return { n: lastN };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__mock/info") return json(res, 200, { referee: referee.did, makers: makers.map((m) => m.did), outsider: outsider.did, lastN });
    if (url.pathname === "/__mock/posted") return json(res, 200, posted);
    if (url.pathname === "/__mock/sweep" && req.method === "POST") return json(res, 200, await sweep());
    if (url.pathname === "/__mock/hide-posted-trades" && req.method === "POST") {
      hidePostedTrades = true;
      for (const p of posted) if (p.text.includes('"t":"trade"')) hiddenSeqs.add(`${p.room}|${p.seq}`);
      return json(res, 200, { hidden: hiddenSeqs.size });
    }
    const m = url.pathname.match(/^\/r\/([a-z0-9][a-z0-9_-]{0,47})(\/export)?$/);
    if (!m) return text(res, 404, "404");
    const name = m[1];
    if (req.method === "POST" && !m[2]) return await onPost(name, req, res, url);
    const r0 = room(name);
    const r = hidePostedTrades ? { ...r0, recs: r0.recs.filter((x) => !hiddenSeqs.has(`${name}|${x.seq}`)) } : r0;
    if (m[2]) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      return res.end(r.recs.map((x) => JSON.stringify(x).replace(/"nonce":"(\d+)"/, '"nonce":$1')).join("\n") + "\n");
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null ? null : Number(sinceRaw);
    let out = r.recs.filter((x) => since === null || x.seq > since);
    out = out.slice(-limit);
    const head = r.recs.length ? r.recs.at(-1).seq : 0;
    return json(res, 200, { room: name, count: out.length, first_seq: out[0]?.seq ?? null,
      last_seq: out.length ? out.at(-1).seq : Math.min(since ?? 0, head), generation: 1, messages: out });
  } catch (e) {
    text(res, 500, String(e && e.stack ? e.stack : e));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock technocore http://127.0.0.1:${PORT}  referee ${referee.did}`));
