# perp-state — service time vs pipeline depth [auto-generated]

> PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.

**Date:** 2026-07-27T07:52:41.627Z · hydra-node 2.3.0-ef833d8a · env macos-arm64-native

## Service time (K=1, no queueing)

- TxValid **P50 7.7ms · P95 16.2ms**
- SnapshotConfirmed **P50 36.9ms · P95 47.1ms**

This is the work itself: one transaction in flight, nothing waiting behind it. Every larger K adds queueing on top.

## Knee

- Deepest pipeline still meeting the gate (txvalid P95 ≤ 200ms): **K = 16** (P95 101.3ms, 99.6 confirm TPS)
- Peak confirm throughput observed: **121.6 TPS** at K=64 (407.3ms P95)
- Logic-reject invalid: 0 · stale-input race: 0

Past the knee, throughput stops rising while latency keeps climbing — that region is queue time, and any P95 quoted from it describes the backlog, not the node.

## Latency vs K

| K (in-flight) | confirm TPS | TxValid P50 | TxValid P95 | snapshot P50 | snapshot P95 | samples |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 25.3 | 7.7 | 16.2 | 36.9 | 47.1 | 150 |
| 2 | 34.4 | 18.4 | 24.8 | 55.1 | 65 | 150 |
| 4 | 58.5 | 22.4 | 34.7 | 64 | 91.7 | 150 |
| 8 | 88.7 | 26.9 | 45.4 | 84.6 | 126.7 | 150 |
| 16 | 99.6 | 52.4 | 101.3 | 150 | 179.4 | 150 |
| 32 | 99.6 | 108.6 | 206.1 | 303.9 | 324.3 | 150 |
| 64 | 121.6 | 183.3 | 407.3 | 531.4 | 648.8 | 150 |
| 128 | 120.8 | 344.9 | 806.5 | 937.4 | 1127.3 | 150 |

## Reproduce

```bash
HYDRA_WS=ws://localhost:4003 HYDRA_HTTP=http://localhost:4003 \
  BENCH_K_SWEEP="1,2,4,8,16,32,64,128" BENCH_K_STEP_TXS=150 \
  BENCH_INFLIGHT_GATE=snapshot \
  pnpm bench --testcase perp-state --latency
```

Machine-readable: `2.3.0-ef833d8a/macos-arm64-native/perp-state/latency-K1-128-150tx-snapshot/run-01/latency.json` (under `results/`).
