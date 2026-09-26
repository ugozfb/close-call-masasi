"""Elle kurulmus uc durumlar: VWAP yarim-cift yuvarlama, bastaki sifirlar, bool until, kilit siniri,
kendi kendine islem, FIFO kapanis ve ters cevirme. Beklenen cikti resmi Python fold'undan.

    python3 tools/gen_edge_vectors.py <resmi-repo> test/vectors/fold-edge.json
"""
import json
import sys
from pathlib import Path

A = "did:key:z6MkvENmGn6G3qgJCq7GGaXnkimub8BdKt5XvENmGn6G3qgJ"
B = "did:key:z6MkrBwx3NBDGJHyHjxNPFJ1Mwrhhztn4sBbrBwx3NBDGJHy"
C = "did:key:z6Mk6zgNFxAi719LMyXWNGEDMJFJmT2561cA6zgNFxAi719L"


def T(i, mk, side, q, px, cs, until=99, taker="any"):
    return {"id": i, "maker": mk, "side": side, "qty": q, "px": px, "taker": taker, "until": until, "countersigner": cs}


CASES = {
    # 100.00 ve 100.01'den birer adet: VWAP 100.005 -> yarim-cift 100.00
    "vwap-yarim-cift-asagi": [
        {"t": "seed", "px": "100.00"},
        {"t": "sweep", "n": 1, "ref": "100.00", "close": "100.00", "owners": [A, B],
         "trades": [T("a", A, "buy", "1", "100.00", B), T("b", A, "buy", "1", "100.01", B)]},
        {"t": "final", "px": "100.00"}],
    # 100.01 ve 100.02: VWAP 100.015 -> yarim-cift 100.02
    "vwap-yarim-cift-yukari": [
        {"t": "seed", "px": "100.00"},
        {"t": "sweep", "n": 1, "ref": "100.00", "close": "100.00", "owners": [A, B],
         "trades": [T("a", A, "buy", "1", "100.01", B), T("b", A, "buy", "1", "100.02", B)]},
        {"t": "final", "px": "100.00"}],
    "bastaki-sifir-ve-bool-until": [
        {"t": "seed", "px": "0100.5"},
        {"t": "sweep", "n": 1, "ref": "0100.50", "close": "100.40", "owners": [A, B],
         "trades": [T("a", A, "sell", "002", "0100.45", B), T("b", A, "buy", "1", "100.40", B, until=True)]},
        {"t": "final", "px": "099.9"}],
    "kilit-siniri": [
        {"t": "seed", "px": "200.00"},
        {"t": "sweep", "n": 5, "ref": "200.00", "close": "200.00", "owners": [A, B],
         "trades": [T("a", A, "buy", "1", "200.00", B)]},
        {"t": "sweep", "n": 6, "ref": "200.00", "close": "201.00", "owners": [C],
         "trades": [T("b", A, "buy", "1", "200.00", B)]},
        {"t": "final", "px": "210.00"}],
    "kendi-kendine-ve-fifo": [
        {"t": "seed", "px": "50.00"},
        {"t": "sweep", "n": 1, "ref": "50.00", "close": "50.00", "owners": [A, B, C],
         "trades": [T("a", A, "buy", "10", "50.00", B), T("b", A, "buy", "5", "51.00", C),
                    T("c", A, "sell", "3", "50.50", A)]},
        {"t": "sweep", "n": 2, "ref": "50.00", "close": "49.00", "owners": [],
         "trades": [T("d", A, "sell", "12", "49.50", B), T("e", A, "sell", "10", "49.00", C)]},
        {"t": "sweep", "n": 3, "ref": "49.00", "close": "48.00", "owners": [],
         "trades": [T("f", A, "sell", "3", "48.00", C), T("g", C, "buy", "4.5", "48.10", B)]},
        {"t": "final", "px": "47.00"}],
}


def main():
    repo, out = Path(sys.argv[1]), Path(sys.argv[2])
    sys.path.insert(0, str(repo))
    from close_call_fold import replay
    cases = []
    for name, lines in CASES.items():
        text = [json.dumps(x) for x in lines]
        cfg = {"lock_sweep": 5} if name == "kilit-siniri" else {}
        cases.append({"name": name, "config": cfg, "lines": text, "expected": replay(text, cfg)})
        print(name, [s["global_price"] for s in cases[-1]["expected"]["sweeps"]],
              [(t["id"], t.get("reason", "ok")) for s in cases[-1]["expected"]["sweeps"] for t in s["trades"]])
    out.write_text(json.dumps(cases, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
