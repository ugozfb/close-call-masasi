// Cekirdek testleri: gercek close1 / hakem imzalari, Python (PyNaCl) ile capraz anahtar/imza,
// kanonik metinler, uctan uca teklif -> kabul -> fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../src/core.mjs";
import { Fold } from "../src/fold.mjs";

const V = JSON.parse(readFileSync(new URL("./vectors/core.json", import.meta.url), "utf8"));

test("anahtar: tohum, JWK, 64 bayt ve DID araci dosyasi ayni DID'i verir; imzalar PyNaCl ile birebir", async () => {
  for (const k of V.keys) {
    const inputs = [
      k.seed_hex, k.seed_b64u, k.secret64_hex, k.jwk,
      JSON.stringify({ warning: "Do not share this file.", did: k.did, privateKeyJwk: k.jwk }),
    ];
    for (const input of inputs) {
      const s = await C.importSigner(input);
      assert.equal(s.did, k.did);
      assert.equal(Object.keys(s).sort().join(","), "did,sign", "imzalayici anahtari disari vermemeli");
    }
    const s = await C.importSigner(k.seed_hex);
    for (const { message, sig } of k.signatures) {
      assert.equal(await s.sign(message), sig, "Ed25519 deterministik: imza PyNaCl ile ayni olmali");
      assert.equal(await C.verifySignature(k.did, sig, message), true);
      assert.equal(await C.verifySignature(k.did, sig, message + " "), false);
    }
  }
});

test("anahtar: yanlis DID ya da yanlis x iceren dosya reddedilir", async () => {
  const [a, b] = V.keys;
  await assert.rejects(C.importSigner({ did: b.did, privateKeyJwk: a.jwk }), /DID/);
  await assert.rejects(C.importSigner({ kty: "OKP", crv: "Ed25519", d: a.jwk.d, x: b.jwk.x }), /acik anahtar/);
  await assert.rejects(C.importSigner("merhaba"), /okunamadi/);
});

test("gercek close1 teklifleri: kanonik metin Python ile ayni, maker imzalari gecerli", async () => {
  for (const v of V.offers) {
    const [o] = C.extractOffers("close1", [v.record]);
    assert.ok(o, `teklif cikarilamadi: ${v.record.seq}`);
    assert.equal(C.canonicalTerms(o.terms), v.canonical);
    assert.equal(await C.verifyOffer(o), true, `imza: ${o.terms.id}`);
    const bozuk = { ...o, terms: { ...o.terms, px: o.terms.px === "1.00" ? "2.00" : "1.00" } };
    assert.equal(await C.verifyOffer(bozuk), false);
  }
});

test("gercek close1 islemleri: maker ve taker imzalari gecerli", async () => {
  for (const v of V.trades) {
    const [tr] = C.extractTrades("close1", [v.record]);
    assert.ok(tr);
    assert.equal(C.canonicalTerms(tr.terms), v.canonical);
    assert.equal(await C.verifyTrade(tr), true, `islem: ${tr.terms.id}`);
    // baska bir DID taker gibi gosterilirse dogrulanmamali (kendi kendine islemler dahil)
    assert.equal(await C.verifyTrade({ ...tr, taker: V.keys[0].did }), false);
  }
});

test("oda imzasi: kayit mesajlari ve 2^53'u asan nonce'lar metin olarak korunur", async () => {
  for (const rec of V.owners) assert.equal(await C.verifyRoomRecord("close1", rec), true);
  for (const rec of V.owners_big_nonce) {
    assert.equal(typeof rec.nonce, "string");
    assert.ok(BigInt(rec.nonce) > 2n ** 53n);
    assert.equal(await C.verifyRoomRecord("close1", rec), true);
    const kayip = { ...rec, nonce: String(Number(rec.nonce)) };  // sayi olarak okunursa bozulur
    assert.equal(await C.verifyRoomRecord("close1", kayip), false);
  }
  const line = `{"seq":1,"ts":"x","from":"${V.owners_big_nonce[0].from}","text":"a","nonce":${V.owners_big_nonce[0].nonce},"sig":"s"}`;
  assert.equal(C.parseExportJsonl(line)[0].nonce, V.owners_big_nonce[0].nonce);
  assert.equal(C.parseRoomJson(`{"messages":[${line}]}`).messages[0].nonce, V.owners_big_nonce[0].nonce);
});

test("hakem kayitlari: imza ve hakem DID'i dogrulanir", async () => {
  for (const { room, record } of V.referee) {
    assert.equal(await C.verifyRefereeRecord(room, record), true, `${room} ${record.seq}`);
    assert.equal(await C.verifyRefereeRecord(room, { ...record, from: V.keys[0].did }), false);
    const m = C.refereeMessage(record);
    assert.ok(m.t === "positions" || m.t === "pnl");
  }
});

test("uctan uca: teklif -> imza -> kabul -> trade metni -> dogrulama -> resmi fold'un JS kopyasinda settled", async () => {
  const maker = await C.importSigner(V.keys[0].seed_hex);
  const taker = await C.importSigner(V.keys[1].seed_hex);
  const terms = C.makeTerms({ id: C.newTradeId(), maker: maker.did, side: "buy", qty: "2.50", px: "225.10", until: 40 });
  const makerSig = await maker.sign(C.makerPayload(terms));
  const offerMsg = C.offerText(terms, makerSig, "offer");
  const [offer] = C.extractOffers("close1", [{ seq: 1, ts: "t", from: maker.did, text: offerMsg }]);
  assert.equal(await C.verifyOffer(offer), true);
  await assert.rejects(C.acceptOffer(maker, offer), /Kendi teklifini/);
  const tradeMsg = await C.acceptOffer(taker, offer);
  const [trade] = C.extractTrades("close1", [{ seq: 2, ts: "t", from: taker.did, text: tradeMsg }]);
  assert.equal(await C.verifyTrade(trade), true);

  const signed = await C.signRoomMessage(taker, "close1", tradeMsg, C.nextNonce());
  assert.equal(await C.verifySignature(taker.did, signed.sig, C.roomPayload("close1", signed.nonce, tradeMsg)), true);
  const req = C.postRequest(signed);
  assert.equal(typeof JSON.parse(req.init.body).nonce, "string", "sunucu nonce'u metin ister");
  await C.attachRoomSignature(signed);                     // harici imza yolu ayni mesaji kabul eder
  await assert.rejects(C.attachRoomSignature({ ...signed, text: tradeMsg + "x" }), /dogrulamiyor/);

  const fold = new Fold({});
  fold.seed("225.00");
  const out = fold.sweep(12, "225.00", "225.05", [maker.did, taker.did],
    [{ ...trade.terms, countersigner: trade.taker }]);
  assert.equal(out.trades[0].outcome, "settled");
});

test("mesaj bicimleri ve tel metni kurallari", () => {
  const did = V.keys[0].did;
  assert.equal(C.ownerText(did), `{"t":"owner","season":"close-1","key":"${did}"}`);
  assert.throws(() => C.assertWireText("a\nb"), /ASCII/);
  assert.throws(() => C.assertWireText(" x"), /ASCII/);
  assert.throws(() => C.assertWireText("ğ"), /ASCII/);
  assert.throws(() => C.makeTerms({ id: "x", maker: did, side: "buy", qty: "0.05", px: "1.00", until: 3 }), /qty/);
  assert.throws(() => C.makeTerms({ id: "x", maker: did, side: "buy", qty: "1.234", px: "1.00", until: 3 }), /qty/);
  const a = C.nextNonce(), b = C.nextNonce(a);
  assert.ok(BigInt(b) > BigInt(a));
  assert.equal(C.nextNonce("9999999999999999990"), "9999999999999999991");
});

test("defter: gercek teklifler, bant, sure ve siralama", async () => {
  const offers = [];
  for (const v of V.offers) {
    const [o] = C.extractOffers("close1", [v.record]);
    o.verified = await C.verifyOffer(o);
    offers.push(o);
  }
  const sweep = 30;
  const book = C.buildBook(offers, { nextSweep: sweep, ref: "225.03" });
  assert.deepEqual(book.band, ["213.78", "236.28"]);
  const live = offers.filter((o) => o.terms.until >= sweep);
  const uniq = new Set(live.map((o) => `${o.terms.maker}|${o.terms.id}`));
  const shown = [...book.bids, ...book.asks].reduce((acc, l) => acc + l.count, 0);
  assert.equal(shown + book.outOfBand.length + book.reserved.length + book.taken.length, uniq.size);
  // odada karsi imzali trade'i gorulen teklifler acik defterden ayrilir
  const takenIds = new Set();
  for (const v of V.trades) { const [t] = C.extractTrades("close1", [v.record]); if (await C.verifyTrade(t)) takenIds.add(t.terms.id); }
  const book2 = C.buildBook(offers, { nextSweep: sweep, ref: "225.03", takenIds });
  assert.ok(book2.counts.taken > 0);
  for (const l of [...book2.bids, ...book2.asks]) for (const e of l.offers) assert.ok(!takenIds.has(e.offer.terms.id));
  for (let i = 1; i < book.bids.length; i++) assert.ok(Number(book.bids[i - 1].px) > Number(book.bids[i].px));
  for (let i = 1; i < book.asks.length; i++) assert.ok(Number(book.asks[i - 1].px) < Number(book.asks[i].px));
  assert.ok(book.counts.expired > 0);
});

test("ucret ve yerel defter: elle hesaplanan ornekler ve 100->110->100 = +1512 (resmi fold ile ayni)", () => {
  assert.equal(C.feeFor({ side: "buy", qty: "10", px: "198.00", close: "200.00" }).fee, "20.000000");
  assert.equal(C.feeFor({ side: "buy", qty: "10", px: "200.00", close: "200.00" }).fee, "20.000000");
  assert.equal(C.feeFor({ side: "sell", qty: "10", px: "204.00", close: "200.00" }).fee, "40.000000");
  const r = C.feeRange({ side: "buy", qty: "10", px: "200.00", ref: "200.00", width: "0.02" });
  assert.deepEqual(r.closes, ["196.00", "204.00"]);
  assert.equal(r.min, "20.000000");
  assert.equal(r.max, "40.000000");
  const L = C.localLedger([
    { side: "buy", qty: "90", px: "100.00", close: "100.00" },
    { side: "sell", qty: "90", px: "110.00", close: "110.00" },
    { side: "sell", qty: "90", px: "110.00", close: "110.00" },
  ]);
  assert.equal(L.scoreAt("100.00"), "1512.000000");
});

test("maks miktar kapanis senaryosuna gore: 200 -> 210 ornegi", () => {
  // Eski davranis: %98 ve yalniz %1 ucretle 48,51 adet; kapanis 210 olunca ucret 485,10 ve toplam 10.187,10 > 10.000
  const eski = C.fundsNeeded({ cash: "10000", side: "buy", qty: "48.51", px: "200.00", close: "210.00" });
  assert.equal(eski.need, "10187.100000");
  assert.equal(eski.ok, false);
  // Yeni: kapanis %5 yukari senaryosu (210) icin miktar; o kapanista bakiyeye sigar
  const q = C.maxQty({ cash: "10000", px: "200.00", side: "buy", ref: "200.00", closeWidth: "0.05", fraction: "0.98" });
  assert.equal(q, "46.66");
  assert.equal(C.fundsNeeded({ cash: "10000", side: "buy", qty: q, px: "200.00", close: "210.00" }).ok, true);
  // Satista kapanis dusunce fark kesilir; senaryo simetrik
  const qs = C.maxQty({ cash: "10000", px: "200.00", side: "sell", ref: "200.00", closeWidth: "0.05" });
  assert.equal(C.fundsNeeded({ cash: "10000", side: "sell", qty: qs, px: "200.00", close: "190.00" }).ok, true);
  assert.equal(C.fundsNeeded({ cash: "10000", side: "sell", qty: (Number(qs) + 0.01).toFixed(2), px: "200.00", close: "190.00" }).ok, false);
  // %1'lik dar senaryoda temel ucret belirleyici: 10000 / (225.03 * 1.01) = 43.99
  assert.equal(C.maxQty({ cash: "10000", px: "225.03", side: "buy", ref: "225.03", closeWidth: "0.01" }), "43.99");
  // kurus yuvarlamasi ihtiyatli yonde
  assert.equal(C.worstClose({ side: "buy", ref: "225.03", closeWidth: "0.015" }), "228.41");
  assert.equal(C.worstClose({ side: "sell", ref: "225.03", closeWidth: "0.015" }), "221.65");
  // kapatan islem teminat istemez: long 10 varken 10 satis yalniz ucret ister
  assert.equal(C.fundsNeeded({ cash: "5", lots: [["10", "200.00"]], side: "sell", qty: "10", px: "200.00", close: "200.00" }).ok, false);
  assert.equal(C.fundsNeeded({ cash: "20", lots: [["10", "200.00"]], side: "sell", qty: "10", px: "200.00", close: "200.00" }).ok, true);
});

test("defter: ayni sayisal fiyat tek seviye; imzali metin degismez", async () => {
  const mk = await C.importSigner(V.keys[2].seed_hex);
  const offers = [];
  for (const [i, px] of [[1, "225"], [2, "225.00"], [3, "225.10"]]) {
    const terms = C.makeTerms({ id: `g${i}`, maker: mk.did, side: "buy", qty: "1.00", px, until: 100 });
    const text = C.offerText(terms, await mk.sign(C.makerPayload(terms)));
    const [o] = C.extractOffers("close1", [{ seq: i, ts: "", from: mk.did, text }]);
    o.verified = await C.verifyOffer(o);
    assert.equal(o.verified, true);
    offers.push(o);
  }
  const book = C.buildBook(offers, { nextSweep: 50, ref: "225.00" });
  assert.equal(book.bids.length, 2);
  assert.equal(book.bids[1].px, "225.00");
  assert.equal(book.bids[1].count, 2);
  assert.deepEqual(book.bids[1].offers.map((e) => e.offer.terms.px).sort(), ["225", "225.00"]);
});

test("son tur: until < sonraki tur suresi gecmis; until == sonraki tur sinirda", async () => {
  const mk = await C.importSigner(V.keys[3].seed_hex);
  const offers = [];
  for (const until of [49, 50, 51]) {
    const terms = C.makeTerms({ id: `u${until}`, maker: mk.did, side: "sell", qty: "1.00", px: "225.00", until });
    const [o] = C.extractOffers("close1", [{ seq: until, ts: "", from: mk.did, text: C.offerText(terms, await mk.sign(C.makerPayload(terms))) }]);
    o.verified = true;
    offers.push(o);
  }
  const book = C.buildBook(offers, { nextSweep: 50, ref: "225.00" });
  assert.equal(book.counts.expired, 1);
  assert.equal(book.asks[0].count, 2);
  assert.equal(book.asks[0].tight, 1);
  // saat: 25 Eylul 12:07 UTC -> son planli tur 1, yeni mesaj en erken 2. turda
  const t = Date.UTC(2026, 8, 25, 12, 7, 0);
  assert.equal(C.lastScheduledSweep(t), 1);
  assert.equal(C.nextSweep(t), 2);
  assert.equal(C.nextSweep(Date.UTC(2026, 9, 4, 9, 0, 0)), 2557);  // kilitten sonra
});

test("gonderim oncesi kontrol listesi", () => {
  const did = V.keys[0].did;
  const now = Date.UTC(2026, 8, 26, 12, 0, 1);     // son planli tur 288, en erken 289
  const terms = C.makeTerms({ id: "p1", maker: V.keys[1].did, side: "buy", qty: "40.00", px: "225.00", until: 289 });
  const flow = [{ t: "flow", n: 287, mints: [V.keys[1].did], omitted: { mints: 0 }, missed: [] }];
  const referee = C.refereeSnapshot({ priceMessages: [{ t: "price", n: 287, ref: { px: "225.00", time: "x" }, limits: ["213.75", "236.25"] }],
    flowMessages: flow, nowMs: now });
  const st = (r, k) => r.checks.find((c) => c.key === k).status;
  let r = C.preflight({ kind: "kabul", terms, makerSigOk: true, myDid: did, nowMs: now, referee,
    ledger: { cash: "10000", lots: [] }, side: "sell" });
  assert.equal(st(r, "sure"), "uyari");               // until == en erken tur
  assert.equal(st(r, "bant"), "ok");
  assert.equal(st(r, "kayit"), "bilinmiyor");   // bizim DID akista yok
  assert.equal(st(r, "maker"), "ok");
  assert.equal(st(r, "fon"), "ok");
  assert.equal(r.blocking, false);
  // bant disi ve suresi gecmis teklif engellenir
  const far = C.makeTerms({ ...terms, id: "p2", px: "240.00", until: 288 });
  r = C.preflight({ kind: "kabul", terms: far, makerSigOk: true, myDid: did, nowMs: now, referee });
  assert.equal(st(r, "sure"), "fail");
  assert.equal(st(r, "bant"), "fail");
  assert.equal(r.blocking, true);
  // hakemin daha once settled dedigi id engellenir
  const flow2 = [{ t: "flow", n: 287, trades: [{ id: "p1", outcome: "settled" }] }];
  r = C.preflight({ kind: "kabul", terms, makerSigOk: true, myDid: did, nowMs: now,
    referee: C.refereeSnapshot({ priceMessages: [{ t: "price", n: 287, ref: { px: "225.00" } }], flowMessages: flow2, nowMs: now }) });
  assert.equal(st(r, "id"), "fail");
  // kisaltilmis akista gorulmemek "bilinmiyor"dur, ret degil
  const flow3 = [{ t: "flow", n: 287, mints: [], omitted: { mints: 1200 } }];
  r = C.preflight({ kind: "kayit", myDid: did, nowMs: now, referee: C.refereeSnapshot({ flowMessages: flow3, nowMs: now }) });
  assert.equal(st(r, "kayit"), "bilinmiyor");
  // hakem okunamadiysa her sey "bilinmiyor", engel yok
  r = C.preflight({ kind: "kabul", terms, makerSigOk: true, myDid: did, nowMs: now, referee: null, side: "sell" });
  assert.equal(r.blocking, false);
  assert.ok(r.checks.filter((c) => c.status === "bilinmiyor").length >= 4);
  // bakiye: en iyi kapanista bile sigmayan islem engellenir
  r = C.preflight({ kind: "teklif", terms: C.makeTerms({ ...terms, id: "p3", qty: "50.00" }), myDid: did, nowMs: now, referee,
    ledger: { cash: "10000", lots: [] }, side: "buy" });
  assert.equal(st(r, "fon"), "fail");
  // kilitten sonra her sey engellenir
  r = C.preflight({ kind: "kayit", myDid: did, nowMs: Date.UTC(2026, 9, 4, 9, 1, 0), referee: null });
  assert.equal(st(r, "kilit"), "fail");
});

test("nonce milisaniye: imzala.js ile ayni birim", () => {
  assert.equal(C.nextNonce(undefined, 1790000000123), "1790000000123");
  assert.equal(C.nextNonce("1790000000123", 1790000000123), "1790000000124");
  assert.equal(C.nextNonce("1790344981760552", 1790000000123), "1790344981760553");  // odada daha buyuk nonce varsa onu gecer
});

test("kontrol listesi iki dilde: ayni durumlar, farkli metin", () => {
  const did = V.keys[0].did;
  const now = Date.UTC(2026, 8, 26, 12, 0, 1);
  const terms = C.makeTerms({ id: "p9", maker: V.keys[1].did, side: "buy", qty: "40.00", px: "225.00", until: 300 });
  const referee = C.refereeSnapshot({ priceMessages: [{ t: "price", n: 287, ref: { px: "225.00" }, limits: ["213.75", "236.25"] }],
    flowMessages: [{ t: "flow", n: 287, mints: [V.keys[1].did] }], nowMs: now });
  const args = { kind: "kabul", terms, makerSigOk: true, myDid: did, nowMs: now, referee, ledger: { cash: "10000", lots: [] }, side: "sell" };
  const tr = C.preflight(args), en = C.preflight({ ...args, lang: "en" });
  assert.deepEqual(tr.checks.map((c) => [c.key, c.status]), en.checks.map((c) => [c.key, c.status]));
  assert.equal(tr.checks.find((c) => c.key === "bant").label, "Fiyat bandı");
  assert.equal(en.checks.find((c) => c.key === "bant").label, "Price band");
  assert.ok(en.checks.every((c) => !/[çğıöşüÇĞİÖŞÜ]/.test(c.label + c.detail)));
});

test("canli hakem mesajlari (tur 269-271): imza, akis bicimi, tur esleme ve islem durumu", async () => {
  const L = JSON.parse(readFileSync(new URL("./vectors/referee-live-269-271.json", import.meta.url), "utf8"));
  for (const key of ["price", "flow", "positions"]) {
    for (const rec of L[key]) assert.ok(await C.verifyRefereeRecord(rec.room, rec), `${key} ${rec.seq} imzasi`);
  }
  const flow = L.flow.map((r) => C.refereeMessage(r));
  const price = L.price.map((r) => C.refereeMessage(r));
  // Hakem n. turun mesajlarini kapanistan hemen sonra yayimliyor: kayit zamani n. tura, ondan onceki an n'ye dusmeli
  for (const m of price) {
    const close = C.sweepTimeMs(m.n);
    assert.equal(C.sweepOfTime(close), m.n);
    assert.equal(C.sweepOfTime(close + 1), m.n + 1);
    assert.equal(C.sweepOfTime(Date.parse(m._ts)), m.n + 1);   // yayim, kapanistan sonra: sonraki turun penceresinde
    assert.equal(m.for, m.n + 1);                                // limits bir sonraki tur icin
  }
  assert.equal(price[1].applied, price[0].ref.px);               // applied = onceki turun referansi
  const e269 = C.flowEntries(flow[0]);
  assert.equal(e269.filter((e) => e.outcome === "settled").length, 8);
  assert.ok(e269.some((e) => e.id === "hxf8558ef0ab5b21" && e.outcome === "void" && e.reason === "funds"));
  assert.ok(C.flowListComplete(flow[0], "void"));
  assert.ok(!C.flowListComplete(flow[1], "void"));
  assert.deepEqual(C.flowRooms(flow), ["close1-offers", "bae-c1"]);
  const ts269 = new Date(C.sweepTimeMs(269) - 60000).toISOString();
  const ts270 = new Date(C.sweepTimeMs(270) - 60000).toISOString();
  const st = (id, ts) => C.tradeStatus({ id, ts, flowMessages: flow });
  assert.equal(st("dqjj0f0rr4xmd", ts269).state, "settled");
  assert.deepEqual([st("hxf8558ef0ab5b21", ts269).state, st("hxf8558ef0ab5b21", ts269).reason], ["void", "funds"]);
  assert.equal(st("benim-islemim", ts269).state, "settled_inferred");      // void listesi tam, id yok
  assert.equal(st("benim-islemim", ts270).state, "unknown");               // void listesi kisaltilmis
  assert.equal(st("benim-islemim", new Date(C.sweepTimeMs(272) - 60000).toISOString()).state, "pending");
  // "void: settled" gorulen id tekrar kabul edilmemeli
  const terms = C.makeTerms({ id: "hx9b286dcaaa5525", maker: V.keys[1].did, side: "buy", qty: "1.00", px: "224.50", until: 400 });
  const snap = C.refereeSnapshot({ priceMessages: price, flowMessages: flow, nowMs: C.sweepTimeMs(271) + 30000 });
  const r = C.preflight({ kind: "kabul", terms, makerSigOk: true, myDid: V.keys[0].did, nowMs: C.sweepTimeMs(271) + 30000, referee: snap });
  assert.equal(r.checks.find((c) => c.key === "id").status, "fail");
  assert.equal(snap.ref, "224.48");
  assert.deepEqual(snap.limits, ["213.26", "235.70"]);
});
