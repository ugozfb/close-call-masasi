// Fold'un JS kopyasi, resmi Python fold'unun ciktilariyla sayisal olarak birebir karsilastirilir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replay, dec } from "../src/fold.mjs";

const here = new URL("./vectors/", import.meta.url);
const read = (name) => readFileSync(new URL(name, here), "utf8");

// Python Decimal str() ussu ciktiya gore degisir ("20.0000" / "20.00"); sayisal esitlik karsilastirilir.
function sameNumber(a, b, where) {
  assert.equal(dec(a), dec(b), `${where}: ${a} != ${b}`);
}

function compare(actual, expected, label) {
  assert.equal(actual.sweeps.length, expected.sweeps.length, `${label}: sweep sayisi`);
  expected.sweeps.forEach((es, i) => {
    const as = actual.sweeps[i];
    const w = `${label} sweep ${es.sweep}`;
    assert.equal(as.sweep, es.sweep, w);
    assert.equal(as.reference, es.reference, `${w} reference`);
    assert.equal(as.close, es.close, `${w} close`);
    assert.deepEqual(as.minted, es.minted, `${w} minted`);
    assert.equal(as.global_price, es.global_price, `${w} global_price`);
    assert.equal(as.trades.length, es.trades.length, `${w} islem sayisi`);
    es.trades.forEach((et, j) => {
      const at = as.trades[j];
      assert.equal(at.id, et.id, `${w} islem ${j} id`);
      assert.equal(at.outcome, et.outcome, `${w} islem ${et.id} sonuc`);
      if (et.outcome === "void") assert.equal(at.reason, et.reason, `${w} islem ${et.id} neden`);
      else {
        sameNumber(at.maker_fee, et.maker_fee, `${w} ${et.id} maker_fee`);
        sameNumber(at.taker_fee, et.taker_fee, `${w} ${et.id} taker_fee`);
      }
    });
  });
  const ef = expected.final, af = actual.final;
  if (ef === null) {
    assert.equal(af, null);
    return;
  }
  assert.equal(af.S, ef.S, `${label} S`);
  assert.equal(af.owners, ef.owners, `${label} owners`);
  sameNumber(af.fees, ef.fees, `${label} fees`);
  sameNumber(af.zero_sum, ef.zero_sum, `${label} zero_sum`);
  assert.equal(af.standings.length, ef.standings.length);
  ef.standings.forEach((es, i) => {
    const as = af.standings[i];
    const w = `${label} sira ${i + 1}`;
    assert.equal(as.key, es.key, `${w} anahtar`);
    sameNumber(as.score, es.score, `${w} skor`);
    sameNumber(as.position, es.position, `${w} pozisyon`);
    sameNumber(as.fees, es.fees, `${w} ucret`);
    assert.deepEqual(as.places, es.places, `${w} places`);
    assert.equal(as.sharing, es.sharing, `${w} sharing`);
  });
}

test("resmi ornek sezon: examples/sample-season.expected.json ile birebir", () => {
  const contest = JSON.parse(read("contest.json"));
  const keys = ["mint", "min_qty", "limit_window", "fee_rate", "fee_rule", "lock_sweep", "prize_places"];
  const cfg = Object.fromEntries(keys.filter((k) => k in contest).map((k) => [k, contest[k]]));
  const lines = read("sample-season.jsonl").split("\n");
  const expected = JSON.parse(read("sample-season.expected.json"));
  compare(replay(lines, cfg), expected, "ornek");
});

test("rastgele sezonlar: resmi Python fold ciktisiyla birebir", () => {
  const cases = JSON.parse(read("fold-random.json"));
  let voids = {};
  for (const c of cases) {
    compare(replay(c.lines, c.config), c.expected, c.name);
    for (const s of c.expected.sweeps) for (const t of s.trades) {
      const k = t.outcome === "void" ? t.reason : "settled_ok";
      voids[k] = (voids[k] || 0) + 1;
    }
  }
  // her gecersizlik nedeni en az bir kez sinanmis olmali
  for (const r of ["shape", "not_owner", "taker", "settled", "expired", "locked", "limits", "funds", "settled_ok"]) {
    assert.ok((voids[r] || 0) > 0, `vektorlerde '${r}' yok`);
  }
});

test("uc durumlar: yarim-cift VWAP, bastaki sifir, bool until, kilit, FIFO", () => {
  const cases = JSON.parse(read("fold-edge.json"));
  for (const c of cases) compare(replay(c.lines, c.config), c.expected, c.name);
});
