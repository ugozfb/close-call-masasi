// Close Call fold: resmi close_call_fold.py'nin (flop-labs/technocore-close-call-challenge @ 66c1da3)
// satir satir JavaScript karsiligi. Tutarlar kesin ondalik: BigInt, 10^-6 birim. Yuvarlama yok;
// bir bolme kesin degilse hata firlatir (sessiz yuvarlama olmasin diye).
//
// Hesabin kaynagi resmi Python programidir. Bu dosya ondan bagimsiz degildir; test/fold.test.mjs
// resmi ornek sezonu ve rastgele sezonlari Python'un urettigi ciktilarla karsilastirir.

const SCALE = 1_000_000n;                 // 1 birim = 0.000001
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const TRADE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TWO_PLACES_RE = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;

// ------------------------------------------------------------------ kesin ondalik
export function dec(text) {
  // "225.10" -> 225100000n ; en fazla 6 ondalik
  const s = String(text).trim();
  const m = /^(-)?([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(s);
  if (!m) throw new Error(`dec: gecersiz ondalik ${JSON.stringify(text)}`);
  const frac = (m[3] || "").padEnd(6, "0");
  const v = BigInt(m[2]) * SCALE + BigInt(frac);
  return m[1] ? -v : v;
}

export function mul(a, b) {
  const p = a * b;
  if (p % SCALE !== 0n) throw new Error("mul: kesin olmayan sonuc (6 ondaligi asiyor)");
  return p / SCALE;
}

export function fmt(v, places = 6) {
  // v: 10^-6 birim. places'e yarim-cift (half-even) yuvarlar; Python Decimal.quantize ile ayni.
  const neg = v < 0n;
  let a = neg ? -v : v;
  const drop = 6 - places;
  if (drop > 0) {
    const d = 10n ** BigInt(drop);
    let q = a / d;
    const r = a % d;
    const half = d / 2n;
    if (r > half || (r === half && q % 2n === 1n)) q += 1n;
    a = q;
  }
  const base = 10n ** BigInt(places);
  const ip = a / base;
  const fp = a % base;
  const s = places > 0 ? `${ip}.${fp.toString().padStart(places, "0")}` : `${ip}`;
  return neg && a !== 0n ? `-${s}` : s;
}

export function toNumber(v) {
  return Number(v) / 1e6;
}

function normAmountText(text) {
  // Python str(Decimal(text)) davranisi: bastaki sifirlar atilir, ondalik hanesi korunur.
  const [ip, fp] = text.split(".");
  const i = ip.replace(/^0+(?=\d)/, "");
  return fp === undefined ? i : `${i}.${fp}`;
}

export function amount(text) {
  // Resmi amount(): en fazla iki ondalikli, sifirdan buyuk metin. Degilse null.
  if (typeof text !== "string" || !TWO_PLACES_RE.test(text)) return null;
  const v = dec(text);
  return v > 0n ? { v, text: normAmountText(text) } : null;
}

const DEFAULTS = {
  mint: "10000", min_qty: "0.1", limit_window: "0.05", fee_rate: "0.01",
  fee_rule: "clawback", lock_sweep: 2556, prize_places: 3,
};

// ------------------------------------------------------------------ hesap
export class Account {
  constructor(key, cash) {
    this.key = key;
    this.cash = cash;                     // BigInt birim
    this.lots = [];                       // [[qty, px]] FIFO; hepsi long (qty>0) ya da hepsi short
    this.fees = 0n;
  }

  get position() {
    return this.lots.reduce((s, [q]) => s + q, 0n);
  }

  opening(side, qty) {
    // Bu islemin kapatmak yerine actigi kontrat sayisi; side +1 alis, -1 satis.
    const held = this.position;
    const other = -BigInt(side) * held;
    const closing = qty < (other > 0n ? other : 0n) ? qty : (other > 0n ? other : 0n);
    return qty - closing;
  }

  apply(side, qty, px, fee) {
    const s = BigInt(side);
    this.cash -= fee;
    this.fees += fee;
    let left = qty;
    while (left > 0n && this.lots.length && this.lots[0][0] * s < 0n) {
      const [lotQty, lotPx] = this.lots[0];
      const absLot = lotQty < 0n ? -lotQty : lotQty;
      const size = left < absLot ? left : absLot;
      // long lot satilinca satis fiyati doner; short lot geri alininca teminat + lehine fark doner
      this.cash += s < 0n ? mul(size, px) : mul(size, 2n * lotPx - px);
      left -= size;
      if (size === absLot) this.lots.shift();
      else this.lots[0][0] = lotQty + s * size;
    }
    if (left > 0n) {
      this.cash -= mul(left, px);          // acilan her kontrat, long ya da short, fiyati kadar baglar
      this.lots.push([s * left, px]);
    }
  }

  valueAt(sv) {
    let v = this.cash;
    for (const [q, p] of this.lots) v += q > 0n ? mul(q, sv) : mul(-q, 2n * p - sv);
    return v;
  }
}

// ------------------------------------------------------------------ fold
export class Fold {
  constructor(config = {}) {
    const cfg = { ...DEFAULTS, ...config };
    this.mint = dec(cfg.mint);
    this.minQty = dec(cfg.min_qty);
    this.window = dec(cfg.limit_window);
    this.feeRate = dec(cfg.fee_rate);
    if (cfg.fee_rule !== "clawback") throw new Error("config: fee_rule must be 'clawback'");
    this.lock = Number(cfg.lock_sweep);
    this.places = Number(cfg.prize_places);
    this.accounts = new Map();
    this.settled = new Set();
    this.sweepN = 0;
    this.globalPx = null;                  // {num, den} VWAP oranı ya da tek deger
    this.finalPx = null;
    this.fees = 0n;
  }

  sideFees(side, qty, px, close) {
    // (maker ucreti, taker ucreti), maker `side` yonundeyken
    const base = mul(mul(this.feeRate, qty), px);
    const gap = mul(close - px, qty);       // > 0: alici kapanistan ucuza aldi
    const buyer = base > gap ? base : gap;
    const seller = base > -gap ? base : -gap;
    return side > 0 ? [buyer, seller] : [seller, buyer];
  }

  seed(px) {
    const a = amount(px);
    if (a === null || this.globalPx !== null) throw new Error("seed: expected one opening price with at most two decimals");
    this.globalPx = { num: a.v, den: SCALE };
  }

  check(trade, n, ref, close) {
    if (trade === null || typeof trade !== "object" || Array.isArray(trade)) return "shape";
    const maker = trade.maker, taker = trade.taker, signer = trade.countersigner;
    const qty = amount(trade.qty), px = amount(trade.px), until = trade.until;
    if (typeof trade.id !== "string" || !TRADE_ID_RE.test(trade.id)
        || !(trade.side === "buy" || trade.side === "sell") || qty === null || px === null
        || !(typeof until === "number" && Number.isInteger(until))
        || typeof maker !== "string" || typeof signer !== "string"
        || !(taker === "any" || typeof taker === "string")) return "shape";
    if (qty.v < this.minQty) return "shape";
    if (!this.accounts.has(maker) || !this.accounts.has(signer)) return "not_owner";
    if (taker !== "any" && taker !== signer) return "taker";
    if (this.settled.has(trade.id)) return "settled";
    if (n > until) return "expired";
    if (n > this.lock) return "locked";
    const dist = px.v - ref > 0n ? px.v - ref : ref - px.v;
    if (dist > mul(this.window, ref)) return "limits";
    const side = trade.side === "buy" ? 1 : -1;
    const [mkFee, tkFee] = this.sideFees(side, qty.v, px.v, close);
    const mk = this.accounts.get(maker), tk = this.accounts.get(signer);
    if (mk === tk) {
      if (mk.cash < mkFee + tkFee) return "funds";
    } else if (mk.cash < mul(mk.opening(side, qty.v), px.v) + mkFee
               || tk.cash < mul(tk.opening(-side, qty.v), px.v) + tkFee) {
      return "funds";
    }
    return null;
  }

  sweep(n, ref, close, owners = [], trades = []) {
    const reference = amount(ref), closing = amount(close);
    if (this.globalPx === null || reference === null || closing === null
        || !(typeof n === "number" && Number.isInteger(n)) || n <= this.sweepN) {
      throw new Error(`sweep ${n}: needs a seed, a reference and a closing price, and an increasing sweep number`);
    }
    this.sweepN = n;
    const minted = [];
    for (const key of owners) {
      if (typeof key === "string" && DID_RE.test(key) && !this.accounts.has(key) && n <= this.lock) {
        this.accounts.set(key, new Account(key, this.mint));
        minted.push(key);
      }
    }
    const outcomes = [];
    let volume = 0n, notional = 0n;
    for (const trade of trades) {
      const reason = this.check(trade, n, reference.v, closing.v);
      const tid = trade && typeof trade === "object" && !Array.isArray(trade) ? (trade.id ?? null) : null;
      if (reason) {
        outcomes.push({ id: tid, outcome: "void", reason });
        continue;
      }
      const qty = dec(trade.qty), px = dec(trade.px);
      const side = trade.side === "buy" ? 1 : -1;
      const [mkFee, tkFee] = this.sideFees(side, qty, px, closing.v);
      const mk = this.accounts.get(trade.maker), tk = this.accounts.get(trade.countersigner);
      if (mk === tk) {
        mk.cash -= mkFee + tkFee;
        mk.fees += mkFee + tkFee;
      } else {
        mk.apply(side, qty, px, mkFee);
        tk.apply(-side, qty, px, tkFee);
      }
      this.fees += mkFee + tkFee;
      this.settled.add(trade.id);
      volume += qty;
      notional += mul(qty, px);
      outcomes.push({ id: tid, outcome: "settled", maker_fee: fmt(mkFee), taker_fee: fmt(tkFee) });
    }
    if (volume) this.globalPx = { num: notional, den: volume };
    return { sweep: n, reference: reference.text, close: closing.text, minted, trades: outcomes,
             global_price: this.globalPriceText() };
  }

  globalPriceText() {
    // VWAP = notional / volume, iki ondaliga yarim-cift (Python quantize(CENT)).
    const { num, den } = this.globalPx;
    const scaled = num * 100n;               // sonuc 1/100 biriminde
    let q = scaled / den;
    const r = scaled % den;
    const twice = 2n * r;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
    const ip = q / 100n, fp = q % 100n;
    return `${ip}.${fp.toString().padStart(2, "0")}`;
  }

  final(px) {
    const s = amount(px);
    if (s === null || this.finalPx !== null) throw new Error("final: expected one closing price with at most two decimals");
    this.finalPx = s.v;
    const scores = new Map();
    for (const [k, a] of this.accounts) scores.set(k, a.valueAt(s.v) - this.mint);
    const order = [...scores.keys()].sort((a, b) => {
      const d = scores.get(b) - scores.get(a);
      if (d !== 0n) return d > 0n ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const winners = new Map();
    let place = 0;
    while (place < Math.min(this.places, order.length)) {   // esit skorlular kapsadiklari yerleri paylasir
      const target = scores.get(order[place]);
      const tied = order.filter((k) => scores.get(k) === target);
      const spanned = [];
      for (let p = place + 1; p <= Math.min(place + tied.length, this.places); p++) spanned.push(p);
      for (const k of tied) winners.set(k, [spanned, tied.length]);
      place += tied.length;
    }
    let total = 0n;
    for (const v of scores.values()) total += v;
    const standings = order.map((k) => {
      const w = winners.get(k) || [[], 0];
      const a = this.accounts.get(k);
      return { key: k, score: fmt(scores.get(k), 6), position: fmt(a.position, 6), fees: fmt(a.fees, 6),
               places: w[0], sharing: w[1] };
    });
    return { S: s.text, owners: order.length, fees: fmt(this.fees, 6), zero_sum: fmt(total + this.fees, 6),
             standings };
  }
}

export function replay(lines, config = null) {
  const fold = new Fold(config || {});
  const sweeps = [];
  let result = null;
  let number = 0;
  for (const line of lines) {
    number += 1;
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const kind = event.t;
    if (kind === "seed") fold.seed(event.px);
    else if (kind === "sweep") sweeps.push(fold.sweep(event.n, event.ref, event.close, event.owners || [], event.trades || []));
    else if (kind === "final") result = fold.final(event.px);
    else throw new Error(`line ${number}: unknown event ${JSON.stringify(kind)}`);
  }
  return { sweeps, final: result };
}
