# perp-state — Hydra in-head benchmark @ 20 TPS [auto-generated]

> PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.

**Date:** 2026-06-01T09:43:56.560Z

**Decision:** **GATE FAIL** — gated on **txvalid** steady P95 = 4740.163917ms vs gate ≤ 200ms.

## What was measured

120 pre-signed txs were fired round-robin across 40 independent lanes at a sustained 20 TPS (open-loop). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | 20 |
| Loop mode | open-loop |
| Lanes × chain | 40 × 3 = 120 |
| Offered (submit) | 120 @ 20.1 TPS |
| Node-validated (TxValid) | 120 @ 20.1 TPS |
| TxInvalid (logic reject — **gated**) | 0 |
| Stale-input race (rig timing — **excluded from gate**) | 0 |
| Confirmed (in snapshot) | 120 @ 20.1 TPS |
| Snapshots observed | 6 |
| Avg tx / snapshot | 20 |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **3895.751583 / 4740.163917 / 4881.918709 / 4881.918709 ms** (n=72/120) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | 15961.407749999998 / 16764.674542 / 16913.904 / 16913.904 ms (n=72/120) |
| Saturated? | false |
| node-vs-client verdict | both-continuous |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ 200ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ 20 but validated ≪ 20 ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

- **validatorTitle:** `perp_state.perp_state.spend`
- **validatorHash:** `0bc1d705fecebc103b9bec89bca84aa87038ced87f4b2b953923d518`
- **validatorAddress:** `addr_test1wq9ur4c9lm8tcypmn0kgn09gf258qwxwmpl5k2u48y3a2xqnql5ka`
- **operatorVkh:** `a8817721ee8a283156d7638de0e17540b97df1e9e85c6b90fb435868`
- **note:** `single-node devnet — multi-party confirm latency not captured; in-head exec-unit price = 0`

## Gate decision

❌ **FAIL** — txvalid steady P95 4740.163917ms > 200ms. Locate the ceiling via offered-vs-validated above.

## Reproduce

```bash
HYDRA_WS=ws://localhost:4003 HYDRA_HTTP=http://localhost:4003 \
  BENCH_TPS=20 BENCH_DURATION_S=6 BENCH_LANES=40 \
  pnpm bench --testcase perp-state            # this run (20 TPS × 6s, 120 txs)
```

Machine-readable summary: `results/perp-state/summary.json`.
