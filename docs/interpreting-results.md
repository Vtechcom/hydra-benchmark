# Interpreting results

Every run prints a final line and writes `results/<testcase>/summary.json` + `report.generated.md`. This doc explains what each number means and the traps to avoid.

## The final line

```
GATE PASS [closed-loop(200,txvalid)] — txvalid steady P95=42ms (gate 200ms) | TxValid P95=42ms snapshot P95=180ms | offered 200.1 / valid 199.8 / confirm 199.2 TPS | invalid=0 stale=0
```

- **GATE PASS/FAIL** — decided on the testcase's gated metric (here `txvalid`).
- **steady P95** — P95 over the **steady-state window** (warmup/drain trimmed).
- **offered / valid / confirm TPS** — the three honest throughputs (below).
- **invalid** — logic-reject TxInvalids (gated). **stale** — stale-input races (rig timing, never gated).

## Three throughputs — read all three

| Throughput | Means | Source |
|---|---|---|
| **offered** | what the rig submitted (`newTx`) | `submitted / span` |
| **validated** | what the node applied locally (`TxValid`) | `valid / span` |
| **confirmed** | what settled in a signed snapshot (`SnapshotConfirmed`) | `confirmed / span` |

Where they diverge locates the ceiling:

- `offered ≈ validated ≈ confirmed` → node keeps up; the limit (if any) is **latency**, not throughput.
- `offered ≫ validated` → **node validation** is the bottleneck (backlog grows).
- `validated ≈ offered` but `confirmed ≪ validated` → **snapshot cadence** (settlement) lags, not matching.

## Two latencies — never conflate them

- **TxValid latency** (newTx → node applied the state transition). The *matching-responsiveness* metric. A ≤ 200 ms gate is reasonable here.
- **SnapshotConfirmed latency** (newTx → settled in a signed snapshot). The *settlement* metric. Hydra **batches** snapshots on a cadence, so per-tx P95 ≤ 200 ms is **not** an achievable target — it is reported, never gated by `perp-state`. Watch `avgTxPerSnapshot`: it rises under load as the node packs more txs into fewer snapshots.

> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1. Never release funds / fan out / withdraw on TxValid alone — wait for SnapshotConfirmed.

## The saturation trap (why P95 can lie)

Open-loop firing at a TPS the node can't sustain builds an unbounded backlog. Then **P95 measures queue time, not confirm latency** — it can be tens of seconds while the node is perfectly healthy at a lower rate. Tells:

- `summary.saturated = true` (validated < 80% of offered), or
- `latencyValid = false` / `fellBack` (no samples landed in the steady window).

Fix: re-run **closed-loop** (`BENCH_INFLIGHT_MAX=K`, `K ≈ confirmTps × ~1s`). Bounded in-flight makes submit-rate track confirm-rate, so P95 reflects one real confirm cycle. This is client-side backpressure for *honest measurement* — not a substitute for node-side backpressure.

## Stale-input races ≠ rejects

A `stale` count > 0 means a chained successor was fired before its predecessor was applied — a **rig timing** artifact (`BadInputsUTxO`), **not** the validator rejecting. It is bucketed separately and **excluded from the gate**. Reduce it with more lanes (`BENCH_LANES`), `--independent`, or closed-loop. Only `invalid` (genuine logic rejects) fails a `requireZeroInvalid` gate.

## node-vs-client verdict

Controls for the worry that the WebSocket/client layer batches deliveries and makes latency *look* worse than the node's. The reporter pairs each TxValid's node-side `timestamp` with the local receive time and compares inter-arrival *gaps* (clock-skew-independent):

| verdict | meaning |
|---|---|
| `both-continuous` | API/WS not batching — numbers reflect the node ✅ |
| `node-bursty …` | the node genuinely emits in cycles (real) |
| `client-batched …` | WS delivers in batches — latency is a measurement artifact |
| `insufficient-samples` | too few TxValid timestamps to decide |

## Honesty boundary

The shipped offline single-node config (one participant, fee = 0, exec prices = 0) is a **feasibility probe**. It does **not** capture multi-party (e.g. 3-of-3) consensus confirm latency — the real target topology — which will be higher; and zeroed economic params are the opposite of mainnet. Report what was *observed*; mark the *cause* of any knee as open unless you've profiled it.
