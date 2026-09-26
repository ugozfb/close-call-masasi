"""Fold test vektorleri: resmi close_call_fold.replay ile rastgele sezonlar uretir.

Her sezon: rastgele sahipler (bazilari hic mint edilmez), rastgele fiyat yuruyusu, her gecersizlik
nedenini tetikleyen islemler (shape, not_owner, taker, settled, expired, locked, limits, funds),
kendi kendine islem, pozisyon kapatma ve ters cevirme. Beklenen cikti resmi Python fold'undan gelir.

    python3 tools/gen_fold_vectors.py <resmi-repo> test/vectors/fold-random.json [sezon_sayisi]
"""
import json
import random
import sys
from pathlib import Path

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def rand_did(rng):
    return "did:key:z6Mk" + "".join(rng.choice(B58) for _ in range(44))


def c2(x):
    return f"{x:.2f}"


def season(rng):
    keys = [rand_did(rng) for _ in range(rng.randint(4, 9))]
    ghosts = [rand_did(rng) for _ in range(2)]            # hic mint edilmeyen anahtarlar
    px = round(rng.uniform(150, 260), 2)
    lines = [{"t": "seed", "px": c2(px)}]
    n, ref, lock = 0, px, rng.choice([30, 60, 2556])
    ids = []
    pending = list(keys)
    for _ in range(rng.randint(8, 30)):
        n += rng.randint(1, 3)
        close = round(ref * (1 + rng.gauss(0, 0.012)), 2)
        owners = []
        while pending and rng.random() < 0.6:
            owners.append(pending.pop(0))
        if rng.random() < 0.1:
            owners.append("not-a-did")
        trades = []
        for _ in range(rng.randint(0, 7)):
            everyone = keys + ghosts
            maker = rng.choice(everyone)
            signer = maker if rng.random() < 0.08 else rng.choice(everyone)
            side = rng.choice(["buy", "sell"])
            r = rng.random()
            if r < 0.04:
                qty = "0.05"
            elif r < 0.07:
                qty = "1.234"
            else:
                qty = c2(rng.choice([rng.uniform(0.1, 5), rng.uniform(5, 30), rng.uniform(30, 60)]))
            p = ref * (1 + rng.choice([rng.gauss(0, 0.01), rng.gauss(0, 0.04), rng.uniform(-0.08, 0.08)]))
            pxs = c2(round(p, 2)) if rng.random() > 0.03 else "abc"
            tid = rng.choice(ids) if ids and rng.random() < 0.1 else f"t{rng.randrange(10**6)}"
            ids.append(tid)
            taker = "any" if rng.random() < 0.6 else (signer if rng.random() < 0.85 else rng.choice(everyone))
            until = n + rng.choice([-1, 0, 0, 1, 5, 50])
            t = {"id": tid, "maker": maker, "side": side, "qty": qty, "px": pxs, "taker": taker,
                 "until": until, "countersigner": signer}
            if rng.random() < 0.02:
                t["until"] = str(until)
            trades.append(t)
        lines.append({"t": "sweep", "n": n, "ref": c2(ref), "close": c2(close), "owners": owners, "trades": trades})
        ref = close
    lines.append({"t": "final", "px": c2(round(ref * (1 + rng.gauss(0, 0.03)), 2))})
    return lines, {"lock_sweep": lock}


def main():
    repo, out = Path(sys.argv[1]), Path(sys.argv[2])
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    sys.path.insert(0, str(repo))
    from close_call_fold import replay
    rng = random.Random(20260925)
    cases = []
    for i in range(count):
        lines, cfg = season(rng)
        text = [json.dumps(x) for x in lines]
        expected = replay(text, cfg)
        cases.append({"name": f"random-{i}", "config": cfg, "lines": text, "expected": expected})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cases), encoding="utf-8")
    reasons = {}
    for c in cases:
        for s in c["expected"]["sweeps"]:
            for t in s["trades"]:
                k = t.get("reason", "settled")
                reasons[k] = reasons.get(k, 0) + 1
    print(out, len(cases), "sezon; sonuc dagilimi:", dict(sorted(reasons.items())))


if __name__ == "__main__":
    main()
