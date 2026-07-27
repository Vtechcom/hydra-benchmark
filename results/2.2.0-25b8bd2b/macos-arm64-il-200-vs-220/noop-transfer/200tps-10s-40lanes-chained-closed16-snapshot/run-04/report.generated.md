# noop-transfer — Hydra in-head benchmark @ 200 TPS [auto-generated]

> Plain in-head ADA self-payment (no Plutus) — node floor cost + reference example for new testcases.

**Date:** 2026-07-27T09:53:17.743Z

**Decision:** **GATE PASS** — gated on **txvalid** steady P95 = 103.07854200000111ms vs gate ≤ 200ms.

## What was measured

2000 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 200 TPS (closed-loop(16,snapshot)). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 200 |
| Loop mode | closed-loop(16,snapshot) |
| Lanes × chain | 40 × 50 = 2000 |
| Offered (submit) | 2000 @ 118.2 TPS |
| Node-validated (TxValid) | 2000 @ 118.2 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 2000 @ 118.2 TPS |
| Snapshots observed | 250 |
| Avg tx / snapshot | 8 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **55.14416600000004 / 103.07854200000111 / 111.5992499999993 / 131.13550000000032 ms** (n=1200/2000) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 133.61820799999987 / 150.62929200000144 / 174.37604199999987 / 191.7127079999991 ms (n=1200/2000) |
| Saturated? | false |
| node-vs-client verdict | both-continuous |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ 200ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ 200 but validated ≪ 200 ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

- **wallet:** `addr_test1qz5gzaepa69zsv2k6a3cmc8pw4qtjl03a859c6usldp4s6r5gw88l78t4wdzqzp6nettjf9vqu45ta4zkza20hhst3vq433aez`
- **laneAda:** `3`
- **note:** `non-Plutus baseline`

## Gate decision

✅ **PASS** — txvalid steady P95 103.07854200000111ms ≤ 200ms with 0 invalid txs at 118.2 TPS offered.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4004 HYDRA_HTTP=http://localhost:4004 \
  BENCH_TPS=200 BENCH_DURATION_S=10 BENCH_LANES=40 \
  BENCH_INFLIGHT_MAX=16 BENCH_INFLIGHT_GATE=snapshot \
  pnpm bench --testcase noop-transfer   # this run (2000 txs, closed-loop(16,snapshot))
```

Machine-readable summary: `2.2.0-25b8bd2b/macos-arm64-il-200-vs-220/noop-transfer/200tps-10s-40lanes-chained-closed16-snapshot/run-04/summary.json` (under `results/`).
