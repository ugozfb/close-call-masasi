"""Cekirdek test vektorleri (imza, kanonik metin, anahtar).

Kaynaklar:
  - close1 odasinin 25 Eylul 14:03-14:11 UTC export'u (gercek, herkese acik oda kaydi)
  - d-close1-positions / d-close1-pnl hakem kayitlari (gercek, herkese acik)
  - PyNaCl ile uretilen test anahtarlari (yalniz test icin; hicbir yere kayit edilmez)

    python3 tools/gen_core_vectors.py <close1-export.jsonl> <positions.json> <pnl.json> test/vectors/core.json
"""
import base64
import json
import re
import sys
from pathlib import Path

from nacl.signing import SigningKey

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def did_of(pub: bytes) -> str:
    return "did:key:z" + b58encode(b"\xed\x01" + pub)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def canon(terms) -> str:
    return json.dumps(terms, sort_keys=True, separators=(",", ":"))


def main():
    export, positions, pnl, out = map(Path, sys.argv[1:5])
    lines = export.read_text(encoding="utf-8").splitlines()
    offers, trades, owners, big = [], [], [], []
    for line in lines:
        q = re.sub(r'"nonce":\s*(\d+)', r'"nonce":"\1"', line)     # nonce metin olarak kalsin
        rec = json.loads(q)
        text = json.loads(rec["text"])
        if text.get("t") == "offer":
            offers.append({"record": rec, "canonical": canon(text["terms"])})
        elif text.get("t") == "trade":
            trades.append({"record": rec, "canonical": canon(text["terms"])})
        elif text.get("t") == "owner":
            if int(rec["nonce"]) > 2**53 and len(big) < 20:
                big.append(rec)
            elif len(owners) < 40:
                owners.append(rec)
    ref = []
    for path in (positions, pnl):
        room = json.loads(re.sub(r'"nonce":\s*(\d+)', r'"nonce":"\1"', path.read_text(encoding="utf-8")))
        for rec in room["messages"][-6:]:
            ref.append({"room": room["room"], "record": rec})

    keys = []
    for i in range(4):
        seed = bytes([(i * 37 + j * 11 + 5) % 256 for j in range(32)])
        sk = SigningKey(seed)
        pub = bytes(sk.verify_key)
        did = did_of(pub)
        msgs = ["close-1|terms|{\"id\":\"x\"}", f"close1|{1790000000000000 + i}|{{\"t\":\"owner\"}}", "Türkçe ğüşiöç"]
        keys.append({
            "seed_hex": seed.hex(), "seed_b64u": b64u(seed), "secret64_hex": (seed + pub).hex(),
            "did": did, "jwk": {"kty": "OKP", "crv": "Ed25519", "d": b64u(seed), "x": b64u(pub)},
            "signatures": [{"message": m, "sig": b64u(sk.sign(m.encode("utf-8")).signature)} for m in msgs],
        })
    data = {"offers": offers, "trades": trades, "owners": owners, "owners_big_nonce": big,
            "referee": ref, "keys": keys}
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(out, {k: len(v) for k, v in data.items()})


if __name__ == "__main__":
    main()
