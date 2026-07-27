# perp-state — Hydra in-head benchmark @ 200 TPS [auto-generated]

> PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.

**Date:** 2026-07-27T07:12:42.617Z

**Decision:** **GATE FAIL** — gated on **txvalid** steady P95 = 23802.730167ms vs gate ≤ 200ms.

## What was measured

6000 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 200 TPS (open-loop). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 200 |
| Loop mode | open-loop |
| Lanes × chain | 40 × 150 = 6000 |
| Offered (submit) | 6000 @ 223.4 TPS |
| Node-validated (TxValid) | 4770 @ 177.6 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 665 @ 24.8 TPS |
| Snapshots observed | 11 |
| Avg tx / snapshot | 60.5 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **15652.479000000003 / 23802.730167 / 24247.652458000004 / 24372.996958000003 ms** (n=3586/4770) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 12014.795625 / 37988.85675 / 38131.746583 / 38158.412458 ms (n=665/665) |
| Saturated? | true |
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

❌ **FAIL** — txvalid steady P95 23802.730167ms > 200ms / node saturated (validated ≪ offered). Locate the ceiling via offered-vs-validated above.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4005 HYDRA_HTTP=http://localhost:4005 \
  BENCH_TPS=200 BENCH_DURATION_S=30 BENCH_LANES=40 \
  pnpm bench --testcase perp-state            # this run (200 TPS × 30s, 6000 txs)
```

Machine-readable summary: `2.0.0-e054c576/macos-arm64-native/perp-state/200tps-30s-40lanes-chained-open/run-03/summary.json` (under `results/`).
