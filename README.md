# hydra-benchmark

Extensible **load / latency benchmark harness** for a live Hydra head. It fires pre-signed transactions at a target TPS against a running `hydra-node`, correlates each tx with its `TxValid` (node applied the state transition) and `SnapshotConfirmed` (settled in a signed snapshot), and reports steady-state P50/P95/P99 latency, three honest throughputs (offered / validated / confirmed), snapshot batching, and a PASS/FAIL gate.

It is a generalisation of the **r1-spike** rig: the core harness (timed loop, measurement, gate, report) is testcase-agnostic, and each **testcase** is a plug-in that owns only the transaction shape. Two ship in the box:

| Testcase | What it fires |
|---|---|
| `perp-state` | PlutusV3 `perp_state` v1 script-spend — a real 5-invariant validator, invoked on an empty state (`MatchedOrders { batch: [] }`, `seq` bump), so each call costs about the script's fixed overhead. The original r1-spike workload |
| `noop-transfer` | Plain in-head ADA self-payment (no Plutus) — node floor cost + reference example for new testcases |

## What it has measured

All figures below: `perp-state` vs the script-free `noop-transfer` control, closed-loop at **K=16**
(snapshot-gated), **10 interleaved pairs per step**, exact sign-flip permutation tests.
Full analysis — method, DiD, multiple-comparison treatment, caveats — in
[`results/FINDINGS.md`](results/FINDINGS.md).

### A Plutus transaction costs less than half what it used to

Measured **within** each version and batch, so this depends on no cross-version assumption:

| hydra-node | `perp-state` (PlutusV3 script spend) | `noop-transfer` (no script) | cost of being a script tx |
|---|---:|---:|---:|
| 2.0.0 | **85.8 TPS** · 185 ms | 115.2 TPS · 137 ms | **−25.5% TPS** |
| 2.2.0 | **101.8 TPS** · 149 ms | 118.7 TPS · 132 ms | **−14.3% TPS** |
| 2.3.0 | **106.2 TPS** · 147 ms | 119.9 TPS · 131 ms | **−11.4% TPS** |

The script penalty fell **25.5% → 11.4%** across three releases while the script-free path moved
only +4.1%. The node did not get generally faster — it got faster **on the script path**.
*(TPS = `SnapshotConfirmed` throughput; ms = snapshot P50 latency.)*

### The large step is 2.0.0 → 2.2.0, not 2.3.0

| `perp-state`, K=16 | **2.0.0 → 2.2.0** | **2.2.0 → 2.3.0** (PR [#2717](https://github.com/cardano-scaling/hydra/pull/2717)) |
|---|---|---|
| confirm TPS | **+19.3%** · 10/10 pairs · p=**0.002** | +2.7% · 8/10 · p=0.014 |
| TxValid P50 | **−33.1%** · 10/10 · p=**0.002** | +2.6% · 4/10 · p=0.44 (unchanged) |
| snapshot P50 | **−18.9%** · 10/10 · p=**0.002** | −2.5% · 8/10 · p=0.023 |
| min–max ranges overlap? | **no** (12.5 TPS gap) | yes, all metrics |
| clears Holm-Bonferroni? | **yes — 5 of 6 metrics** | **no — 0 of 5** |
| net of control (DiD) | **+15.3%** confirm TPS, p<0.0001 | +2.0% confirm TPS, p=0.032 |

2.1.0/2.2.0 optimise the node loop **generically** (cache signable bytes, `Seq`, `Strict Map`, drop
`newLocalUTxO` from `StateChanged`), so the control correctly moves too (+4.0%) — the treatment
simply moves 5× further. The gain is **snapshot cadence**, not batching: 2.2.0 emits 24% more
snapshots each carrying *fewer* transactions.

### PR #2717, the single-variable number

2.3.0 ships **exactly one** runtime performance change: snapshot processing no longer re-evaluates
Plutus scripts for transactions already validated on receipt. Its release note calls that
"significantly increasing sustained in-head throughput"; no number had been published anywhere,
and upstream's `bench-e2e` cannot measure it — its dataset is plain ADA payments, with no script
to skip.

Net of control: **+2.0% settlement throughput** (95% CI `[+1.3%, +4.3%]`, p=0.032). Only the
settlement path moves, TxValid does not (DiD −0.2%, p=0.96), and the control is flat — exactly the
signature #2717 predicts. But with five metrics tested **no single one clears Holm-Bonferroni** at
α=0.05 (best 0.014 → 0.070); the evidence is the pre-predicted *shape*, not one p-value, and ~22
pairs would be needed for each metric to stand alone.

**"Significantly increasing sustained in-head throughput" is not supported by this measurement** —
though it is a floor, not a ceiling: the validator runs on a degenerate state (empty balances,
`MatchedOrders { batch: [] }`), so each call costs about the script's fixed overhead, and #2717's
benefit scales with script cost.

> ⚠️ The `+890%` / "10x-perf" figures circulating for Hydra are **not** 2.3.0 — that stack (#2776–#2780) merged eight days after the 2.3.0 tag and lands in 2.4.0.

> **Honesty boundary.** Numbers from a single *offline, single-participant* head with fee = 0 and exec-unit prices = 0 are a feasibility probe, **not** a mainnet or multi-party measurement. See [`docs/interpreting-results.md`](docs/interpreting-results.md).

---

## Quick start

```bash
# 1. install (Node 22+, pnpm)
pnpm install
cp .env.example .env

# 2. boot a head — one hydra-node version, one host environment
./infra/fetch-node.sh 2.3.0
./infra/head.sh start --version 2.3.0

# 3. quick sanity (20 TPS × 6s × 40 lanes) — expect GATE PASS, low P95
BENCH_TPS=20 BENCH_DURATION_S=6 BENCH_LANES=40 pnpm bench -t noop-transfer

# 4. full profile
pnpm bench --testcase perp-state

# 5. compare versions (median + spread, never a single run)
pnpm compare -t perp-state
```

> `.env` values **override** the `--smoke` profile — set `BENCH_*` inline (as
> above) when you want a specific profile. The profile is part of the result
> path, so whatever actually ran is visible after the fact.

Heads, versions and environments: [`infra/README.md`](infra/README.md).
Version A/B methodology: [`docs/version-ab.md`](docs/version-ab.md).

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
| `--open-loop` | fire at a fixed rate with no backpressure — percentiles then include queue time |
| `--latency` | sweep the in-flight bound K: service time at K=1, then the queueing knee |
| `--list` | list registered testcases |

### Closed-loop is the default

A percentile is only a latency if nothing was queued behind it. Firing open-loop at
a rate the node cannot sustain measures the backlog, not the node — on this rig the
same head reports **37ms** or **937ms** snapshot P50 depending only on how many
transactions are left in flight. So a normal run is **closed-loop**: the in-flight
bound K is calibrated from a short warm-up (`K ≈ confirmTps × target latency`, then
discarded), and P50/P95 describe service time.

```bash
pnpm bench -t perp-state                 # closed-loop, K auto-calibrated
BENCH_INFLIGHT_MAX=16 pnpm bench -t …    # pin K (exact reproduction)
pnpm bench -t perp-state --open-loop     # deliberately measure saturation behaviour
pnpm bench -t perp-state --latency       # the whole latency-vs-K curve
```

Open-loop still has one honest use: finding the throughput ceiling (`BENCH_SWEEP`),
where saturation is the point. Never quote its P95 as latency.

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
| `BENCH_INFLIGHT_MAX` | `auto` | closed-loop bound K on un-acked txs. `auto` calibrates it, `<n>` pins it, `0` = open-loop |
| `BENCH_TARGET_LATENCY_MS` | = gate | latency the auto-calibrator aims at (Little's Law) |
| `BENCH_K_SWEEP` | `1,2,4,…,128` | `--latency`: which K values to sweep |
| `BENCH_K_STEP_TXS` | 200 | `--latency`: txs per K step |
| `BENCH_INFLIGHT_GATE` | `txvalid` | which ack frees a slot: `txvalid` \| `snapshot` |
| `BENCH_GATE_MS` | 200 | P95 gate threshold |
| `BENCH_WARMUP_FRAC` | 0.2 | trim each end of the window before computing steady P95 |

> **Sizing.** The number of txs you pre-sign is `TOTAL = TPS × DURATION_S` (`200 × 60 = 12000`). `LANES`/`CHAIN` only split that total, they don't shrink it — `LANES` is the parallel state-thread count (keep `≥ TPS`). To pre-sign fewer, lower `BENCH_DURATION_S` (main lever) or `BENCH_TPS`; 30 s is plenty for a stable P95. Full table in [`docs/running-locally.md`](docs/running-locally.md#how-many-txs-do-i-pre-sign-sizing).

Example sweep to find the sustainable TPS ceiling:

```bash
BENCH_SWEEP="24,60,120,200,300" BENCH_STEP_S=12 pnpm bench -t perp-state
```

## Output

A benchmark number means nothing without the node version and the host it ran on,
so both are directory levels rather than prose in a report:

```
results/
  <node-version>/<env>/<testcase>/<profile>/run-NN/
      summary.json           decision, latency percentiles, throughputs, batching, validator meta
                             (`--latency` writes latency.json / latency.generated.md instead)
      report.generated.md    human report with the gate verdict and a metrics table
      arrivals.csv           TxValid-burst + SnapshotConfirmed timeline (ack cadence)
      node-vs-client.csv     node-emit vs client-recv gaps (measurement-artifact control)
  index.csv                  one row per run — every result, flat
```

For example `results/2.3.0-ef833d8a/macos-arm64-native/perp-state/200tps-30s-40lanes-chained-open/run-01/`.

- **`<node-version>`** comes from the node's own `hydraNodeVersion` Greetings
  frame — never from a flag — so a run cannot be filed under a version it was not
  measured on. A head that reports nothing lands in `unknown-version/`.
- **`<env>`** is `BENCH_ENV`, else the running head's environment, else the
  detected host. Mac and Linux numbers never merge into one median.
- **`<profile>`** encodes TPS × duration × lanes × chained/independent ×
  open/closed-loop. Medians are only computed within one profile.
- **`run-NN`** increments; nothing is ever overwritten.

`BENCH_OUT_DIR` still overrides the whole path for one-off experiments.

```bash
pnpm compare                              # every group with runs
pnpm compare -t perp-state                # one testcase, median + min–max per version
pnpm compare -t perp-state --paired       # pairwise Δ + exact permutation p-value
```

A few percent hides inside run-to-run spread, so ranges can overlap while the
effect is real. `--paired` compares interleaved runs pair by pair, which cancels
machine drift — see [`docs/version-ab.md`](docs/version-ab.md) and a worked
result in [`results/FINDINGS.md`](results/FINDINGS.md).

`results/unknown-version/unknown-env/` holds the pre-versioning baselines
recovered from git — their node version and host were never recorded, and they
are deliberately not comparable to anything newer.

## Docs

- [`infra/README.md`](infra/README.md) — boot a head per hydra-node version and host environment.
- [`docs/version-ab.md`](docs/version-ab.md) — how to A/B two hydra-node versions (and what the controls are).
- [`docs/running-locally.md`](docs/running-locally.md) — run end-to-end (macOS & Linux), troubleshooting.
- [`docs/writing-a-testcase.md`](docs/writing-a-testcase.md) — add a new testcase in ~3 steps.
- [`docs/architecture.md`](docs/architecture.md) — how the harness is wired (core vs testcase).
- [`docs/interpreting-results.md`](docs/interpreting-results.md) — what the numbers mean and how to read them honestly.
- [`results/FINDINGS.md`](results/FINDINGS.md) — **the** analysis of every result in this repo (single canonical report).

## Requirements

- Node.js ≥ 22, pnpm
- A reachable Hydra head (`hydra-node`) with an in-head funded wallet
- The funding wallet must match `BENCH_MNEMONIC` (default = the offline-devnet pre-funded wallet)
