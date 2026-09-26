// Close Call ortak cekirdegi: Node (>=20) ve modern tarayicilarda ayni kod, bagimliliksiz.
// Ed25519 imza ve dogrulama Web Crypto ile yapilir; ozel anahtar disari cikarilamaz (non-extractable)
// bir anahtar olarak yalniz bellekte tutulur ve hicbir yere gonderilmez.
//
// Protokol kaynagi: flop-labs/technocore-close-call-challenge @ 66c1da3 (close-call-game.md),
// technocore.chat imza kurali (src/didkey.py, src/app.py: POST govdesinde nonce METIN olmalidir).

import { dec, fmt, mul, Account, amount } from "./fold.mjs";

export const CONTEST = Object.freeze({
  id: "close-1",
  service: "https://technocore.chat",
  tradingRoom: "close1",
  lockSweep: 2556,
  mint: "10000",
  minQty: "0.1",
  limitWindow: "0.05",
  feeRate: "0.01",
  prizePlaces: 3,
  openingUtcMs: Date.UTC(2026, 8, 25, 12, 0, 0),    // 25 Eylul 12:00 UTC; n. sweep = acilis + 5n dk
  sweepMs: 300_000,
  finalPriceUtcMs: Date.UTC(2026, 9, 4, 10, 0, 0),  // 4 Ekim 10:00 UTC
  // Canli hakem odalarini imzalayan anahtar. FLOP Labs'in sonnet-2 LAUNCH.md'sinde yayimladigi hakem
  // DID'i ile ayni; close-1 icin imzali bir launch kaydi bu surumde bulunamadi (README'ye bakin).
  refereeDid: "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte",
  manifestSha256: "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa",
  refereeRooms: Object.freeze({
    price: "d-close1-price", flow: "d-close1-flow", positions: "d-close1-positions",
    pnl: "d-close1-pnl", state: "d-close1-state",
  }),
});

// Okunan teklif bicimleri (aciktan listelenir; baskalari yok sayilir).
export const OFFER_FORMATS = Object.freeze([
  Object.freeze({ t: "offer", note: "close1 odasinda gozlenen topluluk bicimi" }),
  Object.freeze({ t: "close-call.offer.v1", note: "UfukNode Close Call Desk bicimi" }),
]);
export const OFFER_ROOMS = Object.freeze(["close1", "close1-offers"]);

const subtle = globalThis.crypto && globalThis.crypto.subtle;
function needCrypto() {
  if (!subtle) throw new Error("Bu ortamda Web Crypto yok. Node 20+ ya da guncel bir tarayici gerekir.");
}

// ------------------------------------------------------------------ kodlama
const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);

export function b64uEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text) {
  const s = String(text).trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("gecersiz base64");
  const pad = s.length % 4 === 0 ? s : s + "=".repeat(4 - (s.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexDecode(text) {
  const s = String(text).trim();
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("gecersiz hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const hexEncode = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function b58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new Error(`gecersiz base58 karakteri: ${ch}`);
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ did:key
export const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

export function didFromPublicKey(pub) {
  if (!(pub instanceof Uint8Array) || pub.length !== 32) throw new Error("Ed25519 acik anahtari 32 bayt olmali");
  return "did:key:z" + b58Encode(concat(new Uint8Array([0xed, 0x01]), pub));
}

export function publicKeyFromDid(did) {
  if (typeof did !== "string" || !DID_RE.test(did)) throw new Error("Gecersiz did:key (Ed25519, z6Mk... bekleniyor)");
  const raw = b58Decode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("Yalniz ed25519-pub did:key kabul edilir");
  return raw.slice(2);
}

export function isDid(value) {
  try {
    publicKeyFromDid(value);
    return true;
  } catch {
    return false;
  }
}

export async function fingerprint(did) {
  needCrypto();
  const h = new Uint8Array(await subtle.digest("SHA-256", utf8(did)));
  return hexEncode(h).slice(0, 16);
}

export const shortDid = (did) => (typeof did === "string" && did.length > 20 ? `${did.slice(8, 12)}…${did.slice(-4)}` : String(did));

// ------------------------------------------------------------------ anahtar
const PKCS8_ED25519 = hexDecode("302e020100300506032b657004220420");

function seedFromString(text) {
  const s = String(text).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { seed: hexDecode(s) };
  if (/^[0-9a-fA-F]{128}$/.test(s)) {
    const b = hexDecode(s);
    return { seed: b.slice(0, 32), expectPub: b.slice(32) };
  }
  let b = null;
  try {
    b = b64uDecode(s);
  } catch {
    b = null;
  }
  if (b && b.length === 32) return { seed: b };
  if (b && b.length === 64) return { seed: b.slice(0, 32), expectPub: b.slice(32) };
  throw new Error("Anahtar metni okunamadi: 32 baytlik tohum (hex/base64) ya da 64 baytlik gizli anahtar bekleniyor.");
}

function extractKeyMaterial(input) {
  let v = input;
  if (v instanceof Uint8Array) {
    if (v.length === 32) return { seed: v.slice() };
    if (v.length === 64) return { seed: v.slice(0, 32), expectPub: v.slice(32) };
    throw new Error("Anahtar baytlari 32 ya da 64 uzunlukta olmali.");
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("{")) return seedFromString(t);
    try {
      v = JSON.parse(t);
    } catch {
      throw new Error("Anahtar JSON'u okunamadi.");
    }
  }
  if (v && typeof v === "object") {
    const expectDid = typeof v.did === "string" ? v.did : undefined;
    const jwk = v.privateKeyJwk || v.privateKeyJWK || v.jwk || (v.kty ? v : null);
    if (jwk) {
      if (jwk.kty !== "OKP" || (jwk.crv && jwk.crv !== "Ed25519") || typeof jwk.d !== "string") {
        throw new Error("JWK bir Ed25519 ozel anahtari degil (kty OKP, crv Ed25519, d gerekli).");
      }
      const seed = b64uDecode(jwk.d);
      if (seed.length !== 32) throw new Error("JWK 'd' alani 32 bayt olmali.");
      return { seed, expectDid, expectPub: typeof jwk.x === "string" ? b64uDecode(jwk.x) : undefined };
    }
    for (const f of ["seed", "privateKey", "secretKey", "secret", "private_key", "sk"]) {
      if (typeof v[f] === "string") return { ...seedFromString(v[f]), expectDid };
    }
  }
  throw new Error("Anahtar okunamadi. Desteklenen: DID aracinin JSON dosyasi, Ed25519 JWK, 32 baytlik tohum (hex/base64), 64 baytlik gizli anahtar.");
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Ozel anahtardan imzalayici uretir. Donen nesnede yalniz `did` ve `sign(metin)` vardir; anahtar
 * Web Crypto icinde disari cikarilamaz olarak tutulur. Dosyadaki `did` ya da JWK `x` alani anahtarla
 * uyusmazsa hata verir (yanlis dosyayla imza atmamak icin).
 */
export async function importSigner(input) {
  needCrypto();
  const material = extractKeyMaterial(input);
  const pkcs8 = concat(PKCS8_ED25519, material.seed);
  const extractable = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await subtle.exportKey("jwk", extractable);
  pkcs8.fill(0);
  material.seed.fill(0);
  const pub = b64uDecode(jwk.x);
  if (material.expectPub && !sameBytes(material.expectPub, pub)) {
    throw new Error("Anahtardaki acik anahtar kismi, ozel anahtardan turetilenle uyusmuyor.");
  }
  const did = didFromPublicKey(pub);
  if (material.expectDid && material.expectDid !== did) {
    throw new Error("Dosyadaki DID, ozel anahtardan turetilen DID ile uyusmuyor.");
  }
  const key = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x },
    { name: "Ed25519" }, false, ["sign"]);
  jwk.d = undefined;
  return Object.freeze({
    did,
    async sign(message) {
      const sig = await subtle.sign("Ed25519", key, utf8(message));
      return b64uEncode(new Uint8Array(sig));
    },
  });
}

const verifyKeys = new Map();

export async function verifySignature(did, sig, message) {
  needCrypto();
  if (typeof sig !== "string" || !SIG_RE.test(sig)) return false;
  let key = verifyKeys.get(did);
  if (!key) {
    let pub;
    try {
      pub = publicKeyFromDid(did);
    } catch {
      return false;
    }
    key = await subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    if (verifyKeys.size > 5000) verifyKeys.clear();
    verifyKeys.set(did, key);
  }
  try {
    return await subtle.verify("Ed25519", key, b64uDecode(sig), utf8(message));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ islem kosullari (terms)
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const AMOUNT_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;
export const TERM_KEYS = Object.freeze(["id", "maker", "px", "qty", "side", "taker", "until"]);

/** Kurallara gore terms dogrulamasi. Hata metni ya da null doner. */
export function termsError(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return "terms bir nesne olmali";
  const keys = Object.keys(t).sort();
  if (keys.length !== TERM_KEYS.length || keys.some((k, i) => k !== TERM_KEYS[i])) {
    return `terms tam olarak su alanlari icermeli: ${TERM_KEYS.join(", ")}`;
  }
  if (typeof t.id !== "string" || !ID_RE.test(t.id)) return "id: 1-64 harf, rakam, - ya da _";
  if (!isDid(t.maker)) return "maker gecerli bir did:key olmali";
  if (t.side !== "buy" && t.side !== "sell") return "side 'buy' ya da 'sell' olmali";
  const qty = amount(t.qty);
  if (qty === null) return "qty en fazla iki ondalikli pozitif metin olmali";
  if (qty.v < dec(CONTEST.minQty)) return `qty en az ${CONTEST.minQty} olmali`;
  if (amount(t.px) === null) return "px en fazla iki ondalikli pozitif metin olmali";
  if (!(t.taker === "any" || isDid(t.taker))) return "taker 'any' ya da gecerli bir did:key olmali";
  if (!(typeof t.until === "number" && Number.isInteger(t.until) && t.until >= 1)) return "until pozitif bir sweep numarasi olmali";
  return null;
}

export function makeTerms({ id, maker, side, qty, px, taker = "any", until }) {
  const t = { id: String(id), maker, px: String(px), qty: String(qty), side, taker, until: Number(until) };
  const err = termsError(t);
  if (err) throw new Error(err);
  return sortedTerms(t);
}

export function sortedTerms(t) {
  const out = {};
  for (const k of TERM_KEYS) out[k] = t[k];
  return out;
}

/** Python json.dumps(terms, sort_keys=True, separators=(",", ":")) ile birebir (ASCII alanlar). */
export function canonicalTerms(t) {
  return "{" + TERM_KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(t[k])}`).join(",") + "}";
}

export const makerPayload = (t) => `${CONTEST.id}|terms|${canonicalTerms(t)}`;
export const takerPayload = (t, takerDid) => `${CONTEST.id}|accept|${canonicalTerms(t)}|${takerDid}`;

export function newTradeId(prefix = "uz") {
  const rnd = new Uint8Array(6);
  globalThis.crypto.getRandomValues(rnd);
  const id = `${prefix}-${Date.now().toString(36)}-${[...rnd].map((b) => b.toString(36)).join("")}`.slice(0, 64);
  if (!ID_RE.test(id)) throw new Error("uretilen id gecersiz");
  return id;
}

export function formatAmount(value, places = 2) {
  // sayi ya da metin -> "225.10" (asagi yuvarlar; miktarda bakiye asimini onlemek icin)
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) throw new Error("pozitif sayi bekleniyor");
  const f = 10 ** places;
  return (Math.floor(n * f + 1e-9) / f).toFixed(places);
}

// ------------------------------------------------------------------ mesajlar
export function ownerText(did) {
  if (!isDid(did)) throw new Error("gecersiz DID");
  return JSON.stringify({ t: "owner", season: CONTEST.id, key: did });
}

export function roomText(room) {
  if (typeof room !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(room)) throw new Error("gecersiz oda adi");
  return JSON.stringify({ t: "room", season: CONTEST.id, room });
}

export function offerText(terms, makerSig, format = "offer") {
  if (!OFFER_FORMATS.some((f) => f.t === format)) throw new Error(`desteklenmeyen teklif bicimi: ${format}`);
  const err = termsError(terms);
  if (err) throw new Error(err);
  if (!SIG_RE.test(makerSig)) throw new Error("maker imzasi 86 karakter base64url olmali");
  return JSON.stringify({ t: format, season: CONTEST.id, terms: sortedTerms(terms), maker_sig: makerSig });
}

export function tradeText(terms, takerDid, makerSig, takerSig) {
  const err = termsError(terms);
  if (err) throw new Error(err);
  if (!isDid(takerDid)) throw new Error("taker DID gecersiz");
  if (terms.taker !== "any" && terms.taker !== takerDid) throw new Error("teklif baska bir DID'e ayrilmis");
  if (!SIG_RE.test(makerSig) || !SIG_RE.test(takerSig)) throw new Error("imza bicimi gecersiz");
  return JSON.stringify({ t: "trade", season: CONTEST.id, terms: sortedTerms(terms), taker: takerDid,
    maker_sig: makerSig, taker_sig: takerSig });
}

/** Sunucunun tek satir supurmesi (clean_text) metni degistirmesin diye: yalniz yazdirilabilir ASCII. */
export function assertWireText(text) {
  if (typeof text !== "string" || !text.length) throw new Error("bos metin");
  if (text.length > 4096) throw new Error("metin 4096 karakteri asiyor");
  if (!/^[\x21-\x7e][\x20-\x7e]*[\x21-\x7e]$|^[\x21-\x7e]$/.test(text)) {
    throw new Error("metin yalniz yazdirilabilir ASCII olmali, basta/sonda bosluk olmamali");
  }
  return text;
}

export const roomPayload = (room, nonce, text) => `${room}|${nonce}|${text}`;

/**
 * Oda+anahtar basina artan nonce, MILISANIYE saatiyle (imzala.js ile ayni birim): max(simdi_ms, onceki+1).
 * Sunucu, anahtarin o odada tuttugu son nonce'tan buyugunu ister. Bir odada daha buyuk birimli
 * (mikro/nano saniye) bir nonce kullanildiysa `last` o degerle verilmelidir; aksi halde reddedilir.
 */
export function nextNonce(last, nowMs = Date.now()) {
  const now = BigInt(Math.floor(nowMs));
  const prev = last ? BigInt(last) : 0n;
  const n = now > prev ? now : prev + 1n;
  if (n.toString().length > 19) throw new Error("nonce 19 haneyi asti");
  return n.toString();
}

export async function signRoomMessage(signer, room, text, nonce) {
  assertWireText(text);
  const n = String(nonce);
  if (!/^[0-9]{1,19}$/.test(n)) throw new Error("nonce 1-19 hane olmali");
  const sig = await signer.sign(roomPayload(room, n, text));
  return { room, did: signer.did, sig, nonce: n, text };
}

/** Harici imza: imzayi disarida atilmis bir mesaji dogrulayip gonderime hazirlar. */
export async function attachRoomSignature({ room, did, nonce, text, sig }) {
  assertWireText(text);
  if (!(await verifySignature(did, sig, roomPayload(room, nonce, text)))) {
    throw new Error("Yapistirilan imza bu mesaji bu DID ile dogrulamiyor.");
  }
  return { room, did, sig, nonce: String(nonce), text };
}

/**
 * technocore.chat POST istegi. Sunucu nonce'u METIN olarak ister (app.py _field).
 * json: true ise ?format=json eklenir; basarili yanit JSON olur ve `posted` alaninda kaydin seq ve ts'si gelir
 * (app.py room_post -> respond). Komut satiri varsayilan (metin) yaniti kullanir.
 */
export function postRequest(signed, service = CONTEST.service, { json = false } = {}) {
  return {
    url: `${service}/r/${encodeURIComponent(signed.room)}${json ? "?format=json" : ""}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: signed.did, sig: signed.sig, nonce: signed.nonce, text: signed.text }),
    },
  };
}

export function sayUrl(signed, service = CONTEST.service) {
  return `${service}/r/${encodeURIComponent(signed.room)}/say-signed/${signed.did}/${signed.sig}/${signed.nonce}/${encodeURIComponent(signed.text)}`;
}

// ------------------------------------------------------------------ oda verisini okuma
const NONCE_AS_TEXT = /"nonce":\s*(\d+)/g;

/** ?format=json yaniti; 2^53'u asan nonce'lar bozulmasin diye metin olarak korunur. */
export function parseRoomJson(text) {
  return JSON.parse(String(text).replace(NONCE_AS_TEXT, '"nonce":"$1"'));
}

/** /export JSONL: her satir bir kayit; nonce metin olarak korunur. */
export function parseExportJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line.replace(NONCE_AS_TEXT, '"nonce":"$1"')));
    } catch {
      /* yarim satir: atla */
    }
  }
  return out;
}

export async function verifyRoomRecord(room, rec) {
  if (!rec || typeof rec.from !== "string" || !isDid(rec.from)) return false;
  return verifySignature(rec.from, rec.sig, roomPayload(room, rec.nonce, rec.text));
}

function parseText(rec) {
  try {
    const j = JSON.parse(rec.text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** Desteklenen bicimlerdeki teklifleri cikarir (imza henuz dogrulanmamis). */
export function extractOffers(room, records) {
  const out = [];
  for (const rec of records) {
    const j = parseText(rec);
    if (!j || j.season !== CONTEST.id || !OFFER_FORMATS.some((f) => f.t === j.t)) continue;
    if (termsError(j.terms) || typeof j.maker_sig !== "string") continue;
    out.push({ room, seq: rec.seq, ts: rec.ts, from: rec.from, format: j.t,
               terms: sortedTerms(j.terms), makerSig: j.maker_sig, record: rec });
  }
  return out;
}

export function extractTrades(room, records) {
  const out = [];
  for (const rec of records) {
    const j = parseText(rec);
    if (!j || j.t !== "trade" || j.season !== CONTEST.id || termsError(j.terms)) continue;
    out.push({ room, seq: rec.seq, ts: rec.ts, from: rec.from, terms: sortedTerms(j.terms), taker: j.taker,
               makerSig: j.maker_sig, takerSig: j.taker_sig, record: rec });
  }
  return out;
}

export const verifyOffer = (o) => verifySignature(o.terms.maker, o.makerSig, makerPayload(o.terms));

export async function verifyTrade(tr) {
  if (!isDid(tr.taker)) return false;
  if (tr.terms.taker !== "any" && tr.terms.taker !== tr.taker) return false;
  const [a, b] = await Promise.all([
    verifySignature(tr.terms.maker, tr.makerSig, makerPayload(tr.terms)),
    verifySignature(tr.taker, tr.takerSig, takerPayload(tr.terms, tr.taker)),
  ]);
  return a && b;
}

/** Karsi imza: bir teklifi kabul eden taker'in imzasini ve gonderilecek trade metnini uretir. */
export async function acceptOffer(signer, offer) {
  if (!(await verifyOffer(offer))) throw new Error("Teklifin maker imzasi dogrulanmadi.");
  if (offer.terms.maker === signer.did) throw new Error("Kendi teklifini ayni DID ile kabul edemezsin.");
  if (offer.terms.taker !== "any" && offer.terms.taker !== signer.did) throw new Error("Bu teklif baska bir DID'e ayrilmis.");
  const takerSig = await signer.sign(takerPayload(offer.terms, signer.did));
  return tradeText(offer.terms, signer.did, offer.makerSig, takerSig);
}

// ------------------------------------------------------------------ teklif defteri
/**
 * Emir defteri: dogrulanmis teklifleri toplar. Yalniz desteklenen oda/bicimlerden gelenleri gorur;
 * gorulmeyen likidite var ya da yok sayilmaz.
 * Sure: `nextSweep`, SIMDI gonderilen bir mesajin islenebilecegi en erken sweep'tir (nextSweep()).
 * until < nextSweep olan teklif artik kabul edilemez (suresi gecmis). until < nextSweep + margin olan
 * teklif defterde kalir ama `tight` isaretlenir: hakem gecikirse ya da sinira yakin gonderilirse yetismeyebilir.
 * Fiyat seviyeleri SAYISAL degere gore birlesir ("225" ile "225.00" ayni seviye); imzali teklif metnine dokunulmaz.
 * @param offers extractOffers ciktisi, `verified` alani eklenmis
 * @param opts { nextSweep, ref: referans fiyat metni, settledIds: hakemin settled dedigi id'ler,
 *               takenIds: odalarda karsi imzali trade'i gorulen id'ler, viewer: DID, margin: sweep payi (1) }
 */
export function buildBook(offers, { nextSweep, ref, settledIds = new Set(), takenIds = new Set(), viewer = null, margin = 1 } = {}) {
  const seen = new Map();
  let duplicates = 0, unverified = 0, expired = 0, settled = 0, tight = 0;
  const taken = [];
  for (const o of [...offers].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (!o.verified) { unverified++; continue; }
    const k = `${o.terms.maker}|${o.terms.id}`;
    if (seen.has(k)) { duplicates++; continue; }
    seen.set(k, o);
  }
  const refV = ref ? dec(ref) : null;
  const band = refV === null ? null : [refV - mul(dec(CONTEST.limitWindow), refV), refV + mul(dec(CONTEST.limitWindow), refV)];
  const bids = new Map(), asks = new Map(), outOfBand = [], reserved = [];
  for (const o of seen.values()) {
    if (settledIds.has(o.terms.id)) { settled++; continue; }
    if (nextSweep != null && o.terms.until < nextSweep) { expired++; continue; }
    if (takenIds.has(o.terms.id)) { taken.push(o); continue; }
    const px = dec(o.terms.px);
    if (band && (px < band[0] || px > band[1])) { outOfBand.push(o); continue; }
    if (o.terms.taker !== "any" && o.terms.taker !== viewer) { reserved.push(o); continue; }
    const isTight = nextSweep != null && o.terms.until < nextSweep + margin;
    if (isTight) tight++;
    const side = o.terms.side === "buy" ? bids : asks;
    const key = px.toString();
    const lvl = side.get(key) || { pxValue: px, px: fmt(px, 2), qty: 0n, count: 0, tight: 0, offers: [] };
    lvl.qty += dec(o.terms.qty);
    lvl.count += 1;
    if (isTight) lvl.tight += 1;
    lvl.offers.push({ offer: o, tight: isTight });
    side.set(key, lvl);
  }
  const fin = (m, desc) => [...m.values()]
    .sort((a, b) => (desc ? (b.pxValue > a.pxValue ? 1 : -1) : (a.pxValue > b.pxValue ? 1 : -1)))
    .map(({ pxValue, ...l }) => ({ ...l, qty: fmt(l.qty, 2) }));
  const bidList = fin(bids, true), askList = fin(asks, false);
  const bestBid = bidList[0]?.px ?? null, bestAsk = askList[0]?.px ?? null;
  return {
    bids: bidList, asks: askList, bestBid, bestAsk,
    spread: bestBid && bestAsk ? fmt(dec(bestAsk) - dec(bestBid), 2) : null,
    band: band ? [fmt(band[0], 2), fmt(band[1], 2)] : null,
    outOfBand, reserved, taken,
    counts: { duplicates, unverified, expired, settled, taken: taken.length, tight },
  };
}

// ------------------------------------------------------------------ hakem odalari
export async function verifyRefereeRecord(room, rec) {
  return rec && rec.from === CONTEST.refereeDid && (await verifyRoomRecord(room, rec));
}

/** Hakem mesajini ayristirir; bilinmeyen alanlar oldugu gibi kalir (omitted, missed dahil). */
export function refereeMessage(rec) {
  const j = parseText(rec);
  return j && typeof j.t === "string" ? { ...j, _seq: rec.seq, _ts: rec.ts } : null;
}

export function latestOfType(messages, t) {
  let best = null;
  for (const m of messages) if (m && m.t === t && (best === null || (m.n ?? 0) >= (best.n ?? 0))) best = m;
  return best;
}

/**
 * Iki ayri tur kavrami:
 *  - lastScheduledSweep(simdi): kapanis saati en son GECMIS sweep (hakem henuz islememis olabilir).
 *  - nextSweep(simdi): SIMDI damgalanan bir mesajin islenebilecegi en erken sweep = lastScheduledSweep + 1.
 * Hakemin en son yayimladigi tur (refereeSnapshot().lastSweep) bunlardan geride olabilir (gecikme).
 * n. sweep'in kapanisi: acilis + 5n dakika (12:05 UTC = 1. sweep).
 */
export function lastScheduledSweep(nowMs = Date.now()) {
  return Math.floor((nowMs - CONTEST.openingUtcMs) / CONTEST.sweepMs);
}

export function nextSweep(nowMs = Date.now()) {
  return lastScheduledSweep(nowMs) + 1;
}

export function sweepTimeMs(n) {
  return CONTEST.openingUtcMs + n * CONTEST.sweepMs;
}

/** Hakem fiyat ve akis mesajlarindan anlik durum (mesajlar once imzasi dogrulanmis olmali). */
export function refereeSnapshot({ priceMessages = [], flowMessages = [], nowMs = Date.now() } = {}) {
  const price = latestOfType(priceMessages, "price");
  const ref = price ? (typeof price.ref === "object" && price.ref ? price.ref.px : price.ref) : null;
  const lastSweep = price && Number.isInteger(price.n) ? price.n : null;
  const scheduled = lastScheduledSweep(nowMs);
  return {
    lastSweep, scheduledSweep: scheduled, nextSweep: scheduled + 1,
    lag: lastSweep === null ? null : scheduled - lastSweep,
    ref: typeof ref === "string" && amount(ref) ? ref : null,
    refTime: price && price.ref && typeof price.ref === "object" ? price.ref.time ?? null : null,
    limits: price && Array.isArray(price.limits) ? price.limits : null,
    flowMessages,
  };
}

function deepFind(node, pred, out = [], depth = 0) {
  if (depth > 8 || node === null || typeof node !== "object") return out;
  if (!Array.isArray(node) && pred(node)) out.push(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) deepFind(v, pred, out, depth + 1);
  return out;
}

function deepHasString(node, s, depth = 0) {
  if (typeof node === "string") return node === s;
  if (depth > 8 || node === null || typeof node !== "object") return false;
  for (const v of Array.isArray(node) ? node : Object.values(node)) if (deepHasString(v, s, depth + 1)) return true;
  return false;
}

/**
 * Akis mesajlari kisaltilmis ya da eksik mi? (omitted: listelenmeyen oge sayilari; missed: hakemin okuyamadigi aralik)
 * Canli bicim (26 Eylul, tur 269-271): omitted = { mints: 3423, settled: 1730, void: 10 } gibi sayilar.
 */
export function flowIsPartial(flowMessages) {
  return flowMessages.some((m) => {
    const om = m.omitted;
    const omittedSome = om && (typeof om === "number" ? om > 0 : typeof om === "object" && Object.values(om).some((v) => Number(v) > 0 || (Array.isArray(v) && v.length)));
    const missedSome = Array.isArray(m.missed) && m.missed.length > 0;
    return Boolean(omittedSome || missedSome);
  });
}

/**
 * Bir akis mesajindaki islem sonuclari. Canli bicim:
 *   settled: ["id", ...]              (cogu tur bos; sayi omitted.settled'da)
 *   void:    [["id", "neden"], ...]   (neden: funds, limits, expired, not_owner, settled = ayni id daha once sonuclandi)
 * Donen: [{ id, outcome: "settled"|"void", reason }]. Bilinmeyen alanlar yok sayilir.
 */
export function flowEntries(m) {
  const out = [];
  if (!m || typeof m !== "object") return out;
  if (Array.isArray(m.settled)) for (const id of m.settled) if (typeof id === "string") out.push({ id, outcome: "settled", reason: "" });
  if (Array.isArray(m.void)) {
    for (const v of m.void) {
      if (Array.isArray(v) && typeof v[0] === "string") out.push({ id: v[0], outcome: "void", reason: typeof v[1] === "string" ? v[1] : "" });
      else if (typeof v === "string") out.push({ id: v, outcome: "void", reason: "" });
    }
  }
  return out;
}

const omittedCount = (m, key) => {
  const om = m && m.omitted;
  if (!om) return 0;
  if (typeof om === "number") return om;
  return Number(om[key]) || 0;
};

/** Bu akis mesajinda bir liste (settled/void/mints) tam mi: hic oge atlanmamis ve hakem okuma boslugu yok. */
export function flowListComplete(m, key) {
  return omittedCount(m, key) === 0 && !(Array.isArray(m && m.missed) && m.missed.length > 0);
}

/**
 * Oda mesaji zamanindan (ts) isleyecegi tur: n. tur acilis + 5n dakikada kapanir; (kapanis(n-1), kapanis(n)]
 * araliginda damgalanan mesaj n. turda islenir.
 */
export function sweepOfTime(ms) {
  return Math.max(1, Math.ceil((ms - CONTEST.openingUtcMs) / CONTEST.sweepMs));
}

/**
 * Bir islemin hakem sonucu. Hakem akis mesajinda settled listesini genelde bos yayimliyor (sayisi omitted'da),
 * void listesi ise cogunlukla tam. Bu yuzden:
 *  - id, islendigi turun settled listesinde: "settled" (kaynak: liste)
 *  - id, o turun void listesinde: "void" + neden (kaynak: liste)
 *  - listelerde yok, o turun void listesi tam ve okuma boslugu yok: "settled_inferred" (CIKARIM)
 *  - listelerde yok, void listesi kisaltilmis: "unknown"
 *  - o turun akis mesaji henuz yok: "pending"; okunan pencerenin disinda: "unknown"
 * source: list | inferred | truncated (omitted: atlanan void sayisi) | missed | unpublished | window | no_time
 * @param p { id, ts: oda kaydinin zamani (ISO), flowMessages: dogrulanmis akis mesajlari }
 */
export function tradeStatus({ id, ts, flowMessages }) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return { state: "unknown", n: null, reason: "", source: "no_time" };
  const n = sweepOfTime(t);
  const m = flowMessages.find((x) => x && x.n === n);
  if (!m) {
    const latest = flowMessages.reduce((a, x) => (Number.isInteger(x.n) && x.n > a ? x.n : a), -1);
    return { state: latest < n ? "pending" : "unknown", n, reason: "", source: latest < n ? "unpublished" : "window" };
  }
  const hits = flowEntries(m).filter((e) => e.id === id);
  if (hits.some((e) => e.outcome === "settled")) return { state: "settled", n, reason: "", source: "list" };
  const v = hits.find((e) => e.outcome === "void");
  if (v) return { state: "void", n, reason: v.reason, source: "list" };
  if (flowListComplete(m, "void")) return { state: "settled_inferred", n, reason: "", source: "inferred" };
  const missed = Array.isArray(m.missed) && m.missed.length > 0;
  return { state: "unknown", n, reason: "", source: missed ? "missed" : "truncated", omitted: omittedCount(m, "void") };
}

/** Akis mesajlarinda bir islem kimligini ya da DID'i arar. Id aramasi settled/void listelerine, DID aramasi tum metne bakar. */
export function findInFlow(flowMessages, { id = null, did = null } = {}) {
  const hits = [];
  for (const m of flowMessages) {
    if (id !== null) {
      for (const e of flowEntries(m)) if (e.id === id) hits.push({ n: m.n, kind: "id", outcome: e.outcome, reason: e.reason });
      // Bilinmeyen bicimler icin geri donus: { id, outcome|status } nesneleri
      for (const obj of deepFind(m, (o) => o.id === id)) hits.push({ n: m.n, kind: "id", outcome: obj.outcome || obj.status || "", reason: obj.reason || "" });
    }
    if (did !== null && deepHasString(m, did)) hits.push({ n: m.n, kind: "did" });
  }
  return { hits, partial: flowIsPartial(flowMessages), scanned: flowMessages.length };
}

/** Akis mesajlarinda kaydi duyurulan odalar (rooms). Islemler bu odalarda da sayilir. */
export function flowRooms(flowMessages) {
  const out = new Set();
  for (const m of flowMessages) if (Array.isArray(m.rooms)) for (const r of m.rooms) if (typeof r === "string") out.add(r);
  return [...out];
}

// ------------------------------------------------------------------ ucret ve senaryo
/** Bizim tarafin ucreti: side "buy"/"sell" (BIZIM yonumuz), qty/px/close metin. */
export function feeFor({ side, qty, px, close }) {
  const q = dec(qty), p = dec(px), c = dec(close);
  const base = mul(mul(dec(CONTEST.feeRate), q), p);
  const gap = side === "buy" ? mul(c - p, q) : mul(p - c, q);
  const fee = base > gap ? base : gap;
  return { fee: fmt(fee, 6), clawback: gap > base };
}

/**
 * Tur kapanisi bilinmedigi icin ucret bir araliktir. Kapanis ref*(1-w)..ref*(1+w) arasinda
 * varsayilarak en dusuk ve en yuksek ucret (ucret kapanisa gore dogrusal-parcalidir, uclar yeter).
 */
export function feeRange({ side, qty, px, ref, width = "0.01" }) {
  const r = dec(ref), w = dec(width);
  const lo = fmt(r - mul(w, r), 2), hi = fmt(r + mul(w, r), 2);
  const a = feeFor({ side, qty, px, close: lo }), b = feeFor({ side, qty, px, close: hi });
  const fa = dec(a.fee), fb = dec(b.fee);
  return { min: fmt(fa < fb ? fa : fb, 6), max: fmt(fa > fb ? fa : fb, 6), closes: [lo, hi] };
}

/** Kendi islemlerimizden yerel defter (resmi fold'un hesap mantigiyla). Tahminidir; hakem esastir. */
export function localLedger(fills) {
  // fills: [{ side: "buy"|"sell" (bizim yonumuz), qty, px, close }] siraya gore
  const acc = new Account("me", dec(CONTEST.mint));
  for (const f of fills) {
    const { fee } = feeFor(f);
    acc.apply(f.side === "buy" ? 1 : -1, dec(f.qty), dec(f.px), dec(fee));
  }
  return {
    cash: fmt(acc.cash, 6), position: fmt(acc.position, 2), fees: fmt(acc.fees, 6),
    lots: acc.lots.map(([q, p]) => [fmt(q, 2), fmt(p, 2)]),
    scoreAt: (s) => fmt(acc.valueAt(dec(s)) - dec(CONTEST.mint), 6),
  };
}

/**
 * Bir kapanis senaryosunda en kotu kapanis: alista ref*(1+w) (kurusa YUKARI), satista ref*(1-w) (kurusa ASAGI).
 * Kurusa yuvarlama ihtiyatli yondedir ve sonraki hesaplarin kesin kalmasini saglar.
 */
export function worstClose({ side, ref, closeWidth = "0.02" }) {
  const r = dec(ref), w = dec(closeWidth);
  const CENT = 10_000n, U = 1_000_000n;
  const moveUp = (w * r + U - 1n) / U;                 // |w*r|, mikro birime yukari
  if (side === "buy") {
    const v = r + moveUp;
    return fmt(((v + CENT - 1n) / CENT) * CENT, 2);
  }
  const v = r - moveUp;
  return fmt((v / CENT) * CENT, 2);
}

/**
 * Bu islem, verilen kapanista bakiyeye sigar mi? Resmi fold'un fon kontrolu: acilan kontrat * fiyat + ucret
 * <= nakit (kapatilan kontrat teminat istemez). Donen: { need, cash, ok }.
 */
export function fundsNeeded({ cash, lots = [], side, qty, px, close }) {
  const acc = new Account("x", dec(cash));
  acc.lots = lots.map(([q, p]) => [dec(q), dec(p)]);
  const s = side === "buy" ? 1 : -1;
  const { fee } = feeFor({ side, qty, px, close });
  const need = mul(acc.opening(s, dec(qty)), dec(px)) + dec(fee);
  return { need: fmt(need, 6), cash: fmt(acc.cash, 6), ok: acc.cash >= need };
}

/**
 * Sifir pozisyondan acilis icin en buyuk miktar, SECILEN KAPANIS SENARYOSUNA gore.
 * Tur kapanisi bilinmedigi icin ucret %1'i asabilir (alista kapanis yukselirse, satista duserse fark
 * kesilir). Kapanisin ref'ten en fazla `closeWidth` saptigi varsayilir; sonuc yalniz o senaryoda bakiyeye
 * sigar. `fraction` ek pay birakmak icindir. Dayatma degil, oneri.
 */
export function maxQty({ cash, px, side = "buy", ref = px, closeWidth = "0.02", fraction = "1" }) {
  const c = dec(cash), p = dec(px), f = dec(fraction);
  const worst = dec(worstClose({ side, ref, closeWidth }));
  const gapUnit = side === "buy" ? worst - p : p - worst;
  const baseUnit = mul(dec(CONTEST.feeRate), p);
  const unit = p + (gapUnit > baseUnit ? gapUnit : baseUnit);   // kontrat basina teminat + en kotu ucret
  const avail = (f * c) / 1_000_000n;                            // asagi yuvarlanir
  const qCents = (avail * 100n) / unit;                           // 0,01 adim, asagi
  if (qCents < 10n) return null;                                  // en az 0,10
  const q = fmt(qCents * 10_000n, 2);
  const check = fundsNeeded({ cash, side, qty: q, px, close: fmt(worst, 2) });
  if (!check.ok) throw new Error("maxQty ic tutarsizlik");         // yapisi geregi olmamali
  return q;
}

// ------------------------------------------------------------------ gonderim oncesi kontrol
// Kontrol metinleri iki dilde. Mantik tek yerde; yalniz metin dile gore secilir.
const PF_TEXT = {
  tr: {
    L: { kilit: "Kilit", hakem: "Hakem gecikmesi", imza: "Maker imzası", sure: "Son geçerli tur", bant: "Fiyat bandı",
         kayit: "Kaydım", id: "Teklif daha önce sonuçlandı mı", maker: "Karşı tarafın kaydı", fon: "Bakiye" },
    lockOk: (n, l) => `şimdi gönderilen mesaj en erken ${n}. turda işlenir (kilit ${l})`,
    lockFail: "kilit geçti; yeni işlem sayılmaz",
    lagUnknown: "hakem turu okunamadı",
    lag: (a, b) => `hakemin son turu ${a}, saate göre ${b}`,
    noReferee: "hakem odaları okunmadı (çevrimdışı ya da erişim hatası)",
    sigOk: "geçerli", sigBad: "geçersiz",
    untilFail: (u, n) => `until ${u} < en erken işlenebilecek tur ${n}`,
    untilWarn: (u, n) => `until ${u}: yalnız ${n}. tura yetişirse geçerli; hakem gecikirse düşebilir`,
    untilOk: (u, n) => `until ${u}, en erken tur ${n}`,
    bandLag: " (hakem gecikmeli; işlemin tabi olacağı referans farklı olabilir)",
    band: (px, ref, lo, hi, note) => `${px}, referans ${ref} için bant ${lo}-${hi}${note}`,
    bandUnknown: "hakem referansı okunamadı",
    flowUnknown: "hakem akışı okunmadı",
    regSeen: (n) => `DID son ${n} akış mesajında görülüyor; zaten kayıtlı olabilirsin, tekrar göndermek gereksiz`,
    regNotSeen: (n, p) => `son ${n} akış mesajında görülmedi${p ? " (liste kısaltılmış/eksik; kanıt sayılmaz)" : ""}`,
    didSeen: "DID akışta görülüyor",
    didNotSeen: (p) => `akışta görülmedi${p ? " (liste kısaltılmış/eksik)" : ""}; kayıtsızsan işlem not_owner ile düşer`,
    idSettled: (id, n) => `id ${id} ${n}. turda settled; aynı id bir kez sonuçlanır`,
    idNotSeen: (n, p) => `son ${n} akış mesajında settled görülmedi${p ? " (liste kısaltılmış/eksik)" : ""}`,
    makerSeen: "maker akışta görülüyor", makerNotSeen: "maker akışta görülmedi (kısaltma olabilir)",
    noLedger: "yerel defter yok; hakemin bakiyesi okunamıyor",
    fundsFail: (px, need, cash) => `kapanış ${px} olsa bile gereken ${need} > nakit ${cash}`,
    fundsWarn: (w, need, cash) => `kapanış ${w} olursa gereken ${need} > nakit ${cash} (void: funds)`,
    fundsOk: (w, need) => `kapanış ${w} değerine kadar sığar (gereken ${need})`,
  },
  en: {
    L: { kilit: "Lock", hakem: "Referee lag", imza: "Maker signature", sure: "Valid until", bant: "Price band",
         kayit: "My registration", id: "Already settled?", maker: "Counterparty registration", fon: "Balance" },
    lockOk: (n, l) => `a message sent now is processed at sweep ${n} at the earliest (lock ${l})`,
    lockFail: "lock has passed; new trades do not count",
    lagUnknown: "referee sweep could not be read",
    lag: (a, b) => `referee's last sweep ${a}, by the clock ${b}`,
    noReferee: "referee rooms not read (offline or access error)",
    sigOk: "valid", sigBad: "invalid",
    untilFail: (u, n) => `until ${u} < earliest processable sweep ${n}`,
    untilWarn: (u, n) => `until ${u}: valid only if it makes sweep ${n}; may drop if the referee lags`,
    untilOk: (u, n) => `until ${u}, earliest sweep ${n}`,
    bandLag: " (referee lagging; the reference this trade faces may differ)",
    band: (px, ref, lo, hi, note) => `${px}, band for reference ${ref} is ${lo}-${hi}${note}`,
    bandUnknown: "referee reference could not be read",
    flowUnknown: "referee flow not read",
    regSeen: (n) => `DID seen in the last ${n} flow messages; you may already be registered, no need to resend`,
    regNotSeen: (n, p) => `not seen in the last ${n} flow messages${p ? " (list truncated/incomplete; not evidence)" : ""}`,
    didSeen: "DID seen in flow",
    didNotSeen: (p) => `not seen in flow${p ? " (list truncated/incomplete)" : ""}; if unregistered the trade fails with not_owner`,
    idSettled: (id, n) => `id ${id} settled at sweep ${n}; an id settles only once`,
    idNotSeen: (n, p) => `not seen settled in the last ${n} flow messages${p ? " (list truncated/incomplete)" : ""}`,
    makerSeen: "maker seen in flow", makerNotSeen: "maker not seen in flow (may be truncated)",
    noLedger: "no local ledger; the referee's balance cannot be read",
    fundsFail: (px, need, cash) => `even at close ${px} needs ${need} > cash ${cash}`,
    fundsWarn: (w, need, cash) => `if the close is ${w} needs ${need} > cash ${cash} (void: funds)`,
    fundsOk: (w, need) => `fits up to a close of ${w} (needs ${need})`,
  },
};

/**
 * Canli gonderim oncesi kontrol listesi. Her madde: { key, label, status: "ok"|"fail"|"uyari"|"bilinmiyor", detail }.
 * Metinler `lang` ile secilir ("tr" varsayilan, "en"); Turkce metinler Turkce karakterlidir, komut satiri
 * bunlari ASCII'ye cevirerek yazar (PowerShell 5.1 konsolu).
 * "fail" varsa gonderilmemeli. Imzanin gecerli olmasi islemin gerceklesebilir oldugu anlamina gelmez;
 * dogrulanamayan her sey "bilinmiyor" olarak acikca yazilir.
 * @param p { kind: "kayit"|"teklif"|"kabul", terms?, makerSigOk?, myDid, nowMs, referee: refereeSnapshot()|null,
 *            ledger?: { cash, lots }, side? (bizim yonumuz), closeWidth?, margin?, lang? }
 */
export function preflight({ kind, terms = null, makerSigOk = null, myDid = null, nowMs = Date.now(), referee = null,
                            ledger = null, side = null, closeWidth = "0.02", margin = 1, lang = "tr" }) {
  const T = PF_TEXT[lang] || PF_TEXT.tr;
  const out = [];
  const add = (key, status, detail) => out.push({ key, label: T.L[key], status, detail });
  const next = nextSweep(nowMs);

  add("kilit", next <= CONTEST.lockSweep ? "ok" : "fail", next <= CONTEST.lockSweep ? T.lockOk(next, CONTEST.lockSweep) : T.lockFail);

  if (referee) {
    add("hakem", referee.lag !== null && referee.lag <= 1 ? "ok" : "uyari",
      referee.lag === null ? T.lagUnknown : T.lag(referee.lastSweep, referee.scheduledSweep));
  } else {
    add("hakem", "bilinmiyor", T.noReferee);
  }

  if (kind === "teklif" || kind === "kabul") {
    if (makerSigOk !== null) add("imza", makerSigOk ? "ok" : "fail", makerSigOk ? T.sigOk : T.sigBad);
    if (terms.until < next) add("sure", "fail", T.untilFail(terms.until, next));
    else if (terms.until < next + margin) add("sure", "uyari", T.untilWarn(terms.until, next));
    else add("sure", "ok", T.untilOk(terms.until, next));

    if (referee && referee.ref) {
      const r = dec(referee.ref), px = dec(terms.px), w = mul(dec(CONTEST.limitWindow), r);
      const inBand = (px > r ? px - r : r - px) <= w;
      const note = referee.lag !== null && referee.lag > 1 ? T.bandLag : "";
      add("bant", inBand ? (note ? "uyari" : "ok") : "fail", T.band(terms.px, referee.ref, fmt(r - w, 2), fmt(r + w, 2), note));
    } else {
      add("bant", "bilinmiyor", T.bandUnknown);
    }
  }

  const flow = referee ? referee.flowMessages : [];
  if (myDid) {
    if (!referee) add("kayit", "bilinmiyor", T.flowUnknown);
    else {
      const f = findInFlow(flow, { did: myDid });
      const seen = f.hits.some((h) => h.kind === "did");
      if (kind === "kayit") add("kayit", seen ? "uyari" : "bilinmiyor", seen ? T.regSeen(f.scanned) : T.regNotSeen(f.scanned, f.partial));
      else add("kayit", seen ? "ok" : "bilinmiyor", seen ? T.didSeen : T.didNotSeen(f.partial));
    }
  }

  if (kind === "kabul" && terms) {
    if (!referee) add("id", "bilinmiyor", T.flowUnknown);
    else {
      const f = findInFlow(flow, { id: terms.id });
      // "void: settled" de ayni id'nin daha once sonuclandigini gosterir.
      const settled = f.hits.find((h) => h.kind === "id" && (h.outcome === "settled" || (h.outcome === "void" && h.reason === "settled")));
      if (settled) add("id", "fail", T.idSettled(terms.id, settled.n));
      else add("id", f.partial ? "bilinmiyor" : "ok", T.idNotSeen(f.scanned, f.partial));
      const makerSeen = findInFlow(flow, { did: terms.maker }).hits.length > 0;
      add("maker", makerSeen ? "ok" : "bilinmiyor", makerSeen ? T.makerSeen : T.makerNotSeen);
    }
  }

  if ((kind === "teklif" || kind === "kabul") && terms && side) {
    if (!ledger) add("fon", "bilinmiyor", T.noLedger);
    else {
      const ref = referee && referee.ref ? referee.ref : terms.px;
      const worst = worstClose({ side, ref, closeWidth });
      const t6 = (v) => String(v).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");   // 277.752000 -> 277.752
      const best = fundsNeeded({ ...ledger, side, qty: terms.qty, px: terms.px, close: terms.px });
      const bad = fundsNeeded({ ...ledger, side, qty: terms.qty, px: terms.px, close: worst });
      if (!best.ok) add("fon", "fail", T.fundsFail(terms.px, t6(best.need), t6(best.cash)));
      else if (!bad.ok) add("fon", "uyari", T.fundsWarn(worst, t6(bad.need), t6(bad.cash)));
      else add("fon", "ok", T.fundsOk(worst, t6(bad.need)));
    }
  }
  return { checks: out, blocking: out.some((c) => c.status === "fail") };
}
