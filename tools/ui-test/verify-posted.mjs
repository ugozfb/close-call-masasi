#!/usr/bin/env node
// YALNIZ TEST: sahte sunucuya POST ile gelen kayitlari cekirdekle bagimsizca dogrular.
//   node tools/ui-test/verify-posted.mjs <posted.json>          -> ozet JSON
//   node tools/ui-test/verify-posted.mjs --imzala <anahtar.json> <metin-dosyasi>   -> imza (harici imza testi icin)
import { readFileSync } from "node:fs";
import * as C from "../../src/core.mjs";

if (process.argv[2] === "--imzala") {
  const s = await C.importSigner(readFileSync(process.argv[3], "utf8"));
  process.stdout.write(await s.sign(readFileSync(process.argv[4], "utf8")));
  process.exit(0);
}

const posted = C.parseRoomJson(readFileSync(process.argv[2], "utf8"));
const out = [];
for (const p of posted) {
  const roomSig = await C.verifyRoomRecord(p.room, p);
  let j = null;
  try { j = JSON.parse(p.text); } catch { /* sohbet */ }
  const row = { room: p.room, seq: p.seq, from: p.from, nonceType: typeof p.nonce, roomSig, t: j && j.t };
  if (j && (j.t === "offer" || j.t === "close-call.offer.v1")) {
    const [o] = C.extractOffers(p.room, [p]);
    row.makerSig = o ? await C.verifyOffer(o) : false;
    row.terms = j.terms;
  }
  if (j && j.t === "trade") {
    const [t] = C.extractTrades(p.room, [p]);
    row.tradeSigs = t ? await C.verifyTrade(t) : false;
    row.terms = j.terms;
    row.taker = j.taker;
  }
  if (j && j.t === "owner") row.key = j.key;
  out.push(row);
}
console.log(JSON.stringify(out, null, 1));
