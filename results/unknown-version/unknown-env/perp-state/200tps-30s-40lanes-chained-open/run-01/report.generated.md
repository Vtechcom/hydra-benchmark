# perp-state — Hydra in-head benchmark @ 200 TPS [auto-generated]

> PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.

**Date:** 2026-06-02T09:08:01.683Z

**Decision:** **GATE FAIL** — gated on **txvalid** steady P95 = 21686.632583ms vs gate ≤ 200ms.

## What was measured

6000 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 200 TPS (open-loop). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 200 |
| Loop mode | open-loop |
| Lanes × chain | 40 × 150 = 6000 |
| Offered (submit) | 6000 @ 191.4 TPS |
| Node-validated (TxValid) | 5229 @ 166.8 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 496 @ 15.8 TPS |
| Snapshots observed | 7 |
| Avg tx / snapshot | 70.9 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **15481.090792000003 / 21686.632583 / 22063.158209000016 / 22251.557292000012 ms** (n=3715/5229) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 18462.712792000006 / 41993.47520799999 / 42084.73758300001 / 42103.10737499999 ms (n=496/496) |
| Saturated? | false |
| node-vs-client verdict | both-continuous |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ 200ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ 200 but validated ≪ 200 ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

- **validatorTitle:** `perp_state.perp_state.spend`
- **validatorHash:** `0bc1d705fecebc103b9bec89bca84aa87038ced87f4b2b953923d518`
- **validatorAddress:** `addr_test1wq9ur4c9lm8tcypmn0kgn09gf258qwxwmpl5k2u48y3a2xqnql5ka`
- **operatorVkh:** `a8817721ee8a283156d7638de0e17540b97df1e9e85c6b90fb435868`
- **note:** `single-node devnet — multi-party confirm latency not captured; in-head exec-unit price = 0`

## Gate decision

❌ **FAIL** — txvalid steady P95 21686.632583ms > 200ms. Locate the ceiling via offered-vs-validated above.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4003 HYDRA_HTTP=http://localhost:4003 \
  BENCH_TPS=200 BENCH_DURATION_S=30 BENCH_LANES=40 \
  pnpm bench --testcase perp-state            # this run (200 TPS × 30s, 6000 txs)
```

Machine-readable summary: `results/perp-state/summary.json`.
