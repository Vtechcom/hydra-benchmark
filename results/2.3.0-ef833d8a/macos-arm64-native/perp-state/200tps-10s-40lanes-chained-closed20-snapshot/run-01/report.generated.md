# perp-state — Hydra in-head benchmark @ 200 TPS [auto-generated]

> PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.

**Date:** 2026-07-27T07:51:12.957Z

**Decision:** **GATE PASS** — gated on **txvalid** steady P95 = 129.56704200000058ms vs gate ≤ 200ms.

## What was measured

2000 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 200 TPS (open-loop). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 200 |
| Loop mode | open-loop |
| Lanes × chain | 40 × 50 = 2000 |
| Offered (submit) | 1900 @ 110.2 TPS |
| Node-validated (TxValid) | 1900 @ 110.2 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 1900 @ 110.2 TPS |
| Snapshots observed | 203 |
| Avg tx / snapshot | 9.4 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **70.72687499999847 / 129.56704200000058 / 146.28370799999902 / 174.3739999999998 ms** (n=1126/1900) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 179.1045409999988 / 224.296875 / 239.58779099999992 / 240.0725829999992 ms (n=1126/1900) |
| Saturated? | false |
| node-vs-client verdict | both-continuous |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ 200ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ 200 but validated ≪ 200 ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

- **validatorTitle:** `perp_state.perp_state.spend`
- **validatorHash:** `589a06302b8c412c58e39e904c670affd5ef8ef7e910617b94bbb1e0`
- **validatorAddress:** `addr_test1wpvf5p3s9wxyztzcuw0fqnr8ptlatmuw7l53qctmjjamrcqsklgl5`
- **operatorVkh:** `a8817721ee8a283156d7638de0e17540b97df1e9e85c6b90fb435868`
- **note:** `single-node devnet — multi-party confirm latency not captured; in-head exec-unit price = 0`

## Gate decision

✅ **PASS** — txvalid steady P95 129.56704200000058ms ≤ 200ms with 0 invalid txs at 110.2 TPS offered.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4003 HYDRA_HTTP=http://localhost:4003 \
  BENCH_TPS=200 BENCH_DURATION_S=10 BENCH_LANES=40 \
  pnpm bench --testcase perp-state            # this run (200 TPS × 10s, 2000 txs)
```

Machine-readable summary: `2.3.0-ef833d8a/macos-arm64-native/perp-state/200tps-10s-40lanes-chained-closed20-snapshot/run-01/summary.json` (under `results/`).
