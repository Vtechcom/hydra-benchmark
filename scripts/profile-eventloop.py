#!/usr/bin/env python3
"""Profile hydra-node's single-threaded event loop from its JSON logs.

The node emits, per processed input, an Envelope-wrapped trace with a UTC
`timestamp`:

  BeginInput {inputId, input}      <- loop starts processing input
  LogicOutcome {outcome}           <- pure HeadLogic.update finished (compute)
  EndInput {inputId}               <- input fully handled (compute + persist + enqueue)

Because the loop is single-threaded and serial, for a given thread the order is
  BeginInput(id) ... LogicOutcome ... EndInput(id)
so we can attribute the LogicOutcome between a Begin/End pair to that input.

We derive, per input class (ReqTx / ReqSn / AckSn / ReqDec / Client / Chain / ...):
  - compute_ms = LogicOutcome.ts - BeginInput.ts   (ledger apply / reapply / sign / accumulator)
  - persist_ms = EndInput.ts     - LogicOutcome.ts  (event persistence + effect enqueue)
  - total_ms   = EndInput.ts     - BeginInput.ts

For ReqSn we also capture the batch size (len transactionIds) and fit
  compute_ms ≈ fixed + per_tx * batch
via ordinary least squares, which answers whether snapshot cost is dominated by
the per-snapshot fixed overhead (sign / accumulator / round-trip) or by the
per-transaction reapply — i.e. whether lowering maxTxsPerSnapshot would hurt
throughput (fixed-dominated) or be ~neutral (per-tx-dominated).

Usage:  python3 profile-eventloop.py NODE_LOG.jsonl
"""
import sys
import json
from datetime import datetime
from collections import defaultdict


def parse_ts(s):
    # ISO-8601 UTC, e.g. "2026-06-02T08:43:49.733123Z" (variable fractional digits)
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # python <3.11 can't parse arbitrary fractional precision; normalise to 6 digits
    if "." in s:
        head, rest = s.split(".", 1)
        # rest = "733123+00:00" or "733+00:00"
        if "+" in rest:
            frac, tz = rest.split("+", 1)
            tz = "+" + tz
        elif "-" in rest:
            frac, tz = rest.split("-", 1)
            tz = "-" + tz
        else:
            frac, tz = rest, ""
        frac = (frac + "000000")[:6]
        s = f"{head}.{frac}{tz}"
    return datetime.fromisoformat(s).timestamp() * 1000.0  # ms


def classify(inp):
    """Map an Input JSON to a coarse class + optional batch size."""
    if not isinstance(inp, dict):
        return "Unknown", None
    tag = inp.get("tag")
    if tag == "ClientInput":
        ci = inp.get("clientInput", {})
        return f"Client.{ci.get('tag', '?')}", None
    if tag == "ChainInput":
        return "Chain", None
    if tag == "NetworkInput":
        ev = inp.get("networkEvent", {})
        if ev.get("tag") == "ConnectivityEvent":
            return "Net.Connectivity", None
        msg = ev.get("msg", {})
        mtag = msg.get("tag", "?")
        if mtag == "ReqSn":
            return "ReqSn", len(msg.get("transactionIds", []) or [])
        return mtag, None
    return tag or "Unknown", None


def percentile(xs, p):
    if not xs:
        return 0.0
    ys = sorted(xs)
    k = (len(ys) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(ys) - 1)
    return ys[lo] + (ys[hi] - ys[lo]) * (k - lo)


def ols(xs, ys):
    """Fit y = a + b x. Returns (a, b, r2)."""
    n = len(xs)
    if n < 2:
        return (ys[0] if ys else 0.0), 0.0, 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0:
        return my, 0.0, 0.0
    b = sxy / sxx
    a = my - b * mx
    sst = sum((y - my) ** 2 for y in ys)
    ssr = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - ssr / sst if sst > 0 else 0.0
    return a, b, r2


def main(path):
    # per-thread pending begin and last-logicoutcome timestamp
    begin = {}  # threadId -> (inputId, cls, batch, ts)
    last_outcome_ts = {}  # threadId -> ts
    compute = defaultdict(list)
    persist = defaultdict(list)
    total = defaultdict(list)
    reqsn_pts = []  # (batch, compute_ms)
    count = defaultdict(int)
    n_lines = 0

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                env = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts_raw = env.get("timestamp")
            msg = env.get("message")
            if ts_raw is None or not isinstance(msg, dict):
                continue
            if msg.get("tag") != "Node":
                continue
            node = msg.get("node", {})
            ntag = node.get("tag")
            tid = env.get("threadId", 0)
            try:
                ts = parse_ts(ts_raw)
            except Exception:
                continue
            n_lines += 1

            if ntag == "BeginInput":
                cls, batch = classify(node.get("input", {}))
                begin[tid] = (node.get("inputId"), cls, batch, ts)
                last_outcome_ts.pop(tid, None)
            elif ntag == "LogicOutcome":
                last_outcome_ts[tid] = ts
            elif ntag == "EndInput":
                b = begin.pop(tid, None)
                if not b:
                    continue
                _id, cls, batch, bts = b
                tot = ts - bts
                total[cls].append(tot)
                count[cls] += 1
                oc = last_outcome_ts.pop(tid, None)
                if oc is not None:
                    comp = oc - bts
                    pers = ts - oc
                    compute[cls].append(comp)
                    persist[cls].append(pers)
                    if cls == "ReqSn" and batch is not None:
                        reqsn_pts.append((batch, comp))

    print(f"# parsed {n_lines} Node trace lines from {path}\n")
    classes = sorted(total, key=lambda c: -sum(total[c]))
    hdr = f"{'input class':<22}{'n':>7}{'sum_s':>9}{'%loop':>7}{'compute p50':>13}{'compute p95':>13}{'persist p50':>13}{'total p95':>11}"
    print(hdr)
    print("-" * len(hdr))
    grand = sum(sum(v) for v in total.values()) or 1.0
    for c in classes:
        s = sum(total[c])
        print(
            f"{c:<22}{count[c]:>7}{s/1000:>9.2f}{100*s/grand:>7.1f}"
            f"{percentile(compute[c],50):>13.3f}{percentile(compute[c],95):>13.3f}"
            f"{percentile(persist[c],50):>13.3f}{percentile(total[c],95):>11.3f}"
        )
    print(f"\ntotal loop-busy time: {grand/1000:.2f}s across {sum(count.values())} inputs")
    print("(times in ms unless noted; %loop = share of total measured loop-busy time)")

    if reqsn_pts:
        batches = [b for b, _ in reqsn_pts]
        comps = [c for _, c in reqsn_pts]
        a, b, r2 = ols(batches, comps)
        print("\n## ReqSn snapshot-build compute ≈ fixed + per_tx × batch")
        print(f"  snapshots measured : {len(reqsn_pts)}")
        print(f"  batch size         : min {min(batches)}, max {max(batches)}, mean {sum(batches)/len(batches):.1f}")
        print(f"  fixed   (a)        : {a:.3f} ms / snapshot")
        print(f"  per_tx  (b)        : {b:.4f} ms / tx")
        print(f"  R^2                : {r2:.3f}")
        if a + b > 0:
            for bs in (50, 100, 200, 500):
                t = a + b * bs
                tps = 1000.0 * bs / t if t > 0 else 0
                share = 100 * a / t if t > 0 else 0
                print(f"  batch={bs:>4}: {t:8.1f} ms/snap -> serial confirm ~{tps:6.1f} TPS (fixed is {share:.0f}% of snap time)")
        print("  => if fixed% is large, smaller maxTxsPerSnapshot LOWERS confirm TPS;")
        print("     if per_tx dominates, batch size barely changes throughput.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
