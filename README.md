# hydra-benchmark

Extensible **load / latency benchmark harness** for a live Hydra head. It fires pre-signed transactions at a target TPS against a running `hydra-node`, correlates each tx with its `TxValid` (node applied the state transition) and `SnapshotConfirmed` (settled in a signed snapshot), and reports steady-state P50/P95/P99 latency, three honest throughputs (offered / validated / confirmed), snapshot batching, and a PASS/FAIL gate.

It is a generalisation of the **r1-spike** rig: the core harness (timed loop, measurement, gate, report) is testcase-agnostic, and each **testcase** is a plug-in that owns only the transaction shape. Two ship in the box:

| Testcase | What it fires |
|---|---|
| `perp-state` | PlutusV3 `perp_state` script-spend (no-op `MatchedOrders`, `seq` bump) — the original r1-spike workload |
| `noop-transfer` | Plain in-head ADA self-payment (no Plutus) — node floor cost + reference example for new testcases |

> **Honesty boundary.** Numbers from a single *offline, single-participant* head with fee = 0 and exec-unit prices = 0 are a feasibility probe, **not** a mainnet or multi-party measurement. See [`docs/interpreting-results.md`](docs/interpreting-results.md).

---

## Quick start

```bash
# 1. install (Node 22+, pnpm)
pnpm install

# 2. point at a running Hydra head (offline single-node devnet by default)
cp .env.example .env        # then edit HYDRA_WS / HYDRA_HTTP if needed

# 3. list testcases
pnpm bench --list

# 4. quick sanity (20 TPS × 6s × 40 lanes) — expect GATE PASS, low P95
pnpm bench --testcase noop-transfer --smoke
pnpm bench --testcase perp-state --smoke

# 5. full R1 profile (default full profile is 200 TPS × 60s × 400 lanes)
pnpm bench --testcase perp-state
```

Booting a head and the full local walkthrough: [`docs/running-locally.md`](docs/running-locally.md).

## CLI

```
pnpm bench --testcase <name> [--smoke] [--independent]
pnpm bench --list
pnpm bench --help
```

| Flag | Meaning |
|---|---|
| `-t, --testcase <name>` | which testcase to run (default `perp-state`) |
| `--smoke` | quick sanity profile: 20 TPS × 6s × 40 lanes |
| `--independent` | pin chain length to 1 — every tx spends its own seed (isolates raw single-tx latency) |
| `--list` | list registered testcases |

### Common env knobs

All optional; see [`.env.example`](.env.example). `BENCH_*` are primary; the old `R1_*` names are accepted as fallbacks.

Defaults follow the current R1 rig: full profile is 200 TPS × 60s × 400 lanes; `--smoke` is 20 TPS × 6s × 40 lanes. `.env` (loaded automatically) overrides these defaults; CLI/inline env overrides `.env`.

| Env | Default | Meaning |
|---|---|---|
| `HYDRA_WS` / `HYDRA_HTTP` | `ws://localhost:4003` / `http://localhost:4003` | head endpoints |
| `BENCH_TPS` | 200 full / 20 smoke | target submit rate |
| `BENCH_DURATION_S` | 60 full / 6 smoke | fire-window seconds |
| `BENCH_LANES` | 400 full / 40 smoke | independent seed lanes (keep ≥ TPS) |
| `BENCH_CHAIN` | auto | pre-signed spends per lane |
| `BENCH_SWEEP` | unset | comma-separated TPS steps for throughput-knee sweep, e.g. `24,60,120,200,300` |
| `BENCH_STEP_S` | 12 | seconds per sweep step |
| `BENCH_INFLIGHT_MAX` | 0 (open-loop) | closed-loop bound on un-acked txs (`K ≈ confirmTps × latency_s`) |
| `BENCH_INFLIGHT_GATE` | `txvalid` | which ack frees a slot: `txvalid` \| `snapshot` |
| `BENCH_GATE_MS` | 200 | P95 gate threshold |
| `BENCH_WARMUP_FRAC` | 0.2 | trim each end of the window before computing steady P95 |

> **Sizing.** The number of txs you pre-sign is `TOTAL = TPS × DURATION_S` (`200 × 60 = 12000`). `LANES`/`CHAIN` only split that total, they don't shrink it — `LANES` is the parallel state-thread count (keep `≥ TPS`). To pre-sign fewer, lower `BENCH_DURATION_S` (main lever) or `BENCH_TPS`; 30 s is plenty for a stable P95. Full table in [`docs/running-locally.md`](docs/running-locally.md#how-many-txs-do-i-pre-sign-sizing).

Example sweep to find the sustainable TPS ceiling:

```bash
BENCH_SWEEP="24,60,120,200,300" BENCH_STEP_S=12 pnpm bench -t perp-state
```

## Output

Each run writes to `results/<testcase>/`:

| File | Contents |
|---|---|
| `summary.json` | machine-readable: decision, latency percentiles, throughputs, batching, validator meta |
| `report.generated.md` | human report with the gate verdict and a metrics table |
| `arrivals.csv` | TxValid-burst + SnapshotConfirmed timeline (ack cadence) |
| `node-vs-client.csv` | node-emit vs client-recv gaps (measurement-artifact control) |

## Docs

- [`docs/running-locally.md`](docs/running-locally.md) — boot a head + run end-to-end (macOS & Linux), troubleshooting.
- [`docs/writing-a-testcase.md`](docs/writing-a-testcase.md) — add a new testcase in ~3 steps.
- [`docs/architecture.md`](docs/architecture.md) — how the harness is wired (core vs testcase).
- [`docs/interpreting-results.md`](docs/interpreting-results.md) — what the numbers mean and how to read them honestly.

## Requirements

- Node.js ≥ 22, pnpm
- A reachable Hydra head (`hydra-node`) with an in-head funded wallet
- The funding wallet must match `BENCH_MNEMONIC` (default = the offline-devnet pre-funded wallet)
