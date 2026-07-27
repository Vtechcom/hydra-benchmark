# noop-transfer — Hydra in-head benchmark @ 20 TPS [auto-generated]

> Plain in-head ADA self-payment (no Plutus) — node floor cost + reference example for new testcases.

**Date:** 2026-07-27T07:31:03.169Z

**Decision:** **GATE PASS** — gated on **txvalid** steady P95 = 15.165875000000597ms vs gate ≤ 200ms.

## What was measured

120 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 20 TPS (open-loop). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 20 |
| Loop mode | open-loop |
| Lanes × chain | 40 × 3 = 120 |
| Offered (submit) | 120 @ 20.2 TPS |
| Node-validated (TxValid) | 120 @ 20.2 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 120 @ 20.2 TPS |
| Snapshots observed | 120 |
| Avg tx / snapshot | 1 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **7.318041999999878 / 15.165875000000597 / 20.101208000000042 / 20.101208000000042 ms** (n=72/120) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 27.035374999999476 / 38.256624999999985 / 43.95420899999999 / 43.95420899999999 ms (n=72/120) |
| Saturated? | false |
| node-vs-client verdict | both-continuous |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ 200ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ 20 but validated ≪ 20 ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

- **wallet:** `addr_test1qz5gzaepa69zsv2k6a3cmc8pw4qtjl03a859c6usldp4s6r5gw88l78t4wdzqzp6nettjf9vqu45ta4zkza20hhst3vq433aez`
- **laneAda:** `3`
- **note:** `non-Plutus baseline`

## Gate decision

✅ **PASS** — txvalid steady P95 15.165875000000597ms ≤ 200ms with 0 invalid txs at 20.2 TPS offered.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4004 HYDRA_HTTP=http://localhost:4004 \
  BENCH_TPS=20 BENCH_DURATION_S=6 BENCH_LANES=40 \
  pnpm bench --testcase noop-transfer            # this run (20 TPS × 6s, 120 txs)
```

Machine-readable summary: `2.2.0-25b8bd2b/macos-arm64-native/noop-transfer/20tps-6s-40lanes-chained-open/run-02/summary.json` (under `results/`).
