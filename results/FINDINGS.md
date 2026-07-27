# hydra-node 2.0.0 → 2.2.0 → 2.3.0: what actually got faster

**Single canonical analysis.** Measured 2026-07-27 · macOS arm64, single-party offline devnet ·
`perp-state` (PlutusV3 script spend) as treatment, `noop-transfer` (no script) as control ·
40 closed-loop runs in two interleaved A/B batches, plus 18 open-loop runs kept as an appendix.

Recomputed independently from the 98 `summary.json` files under `results/`. This is the **single
canonical analysis** — it consolidates and replaces three earlier per-span reports, whose
conclusions are carried forward here with four corrections (§7).

---

## 0. Headline

| | |
|---|---|
| **The big change is 2.0.0 → 2.2.0, not 2.3.0.** | Script-workload settlement throughput **+19.3%** (10/10 pairs, p = 0.002, non-overlapping ranges). This is the only result in the dataset that survives multiple-comparison correction. |
| **#2717 (2.3.0) is real and ~7× smaller.** | **+2.7%** (8/10, p = 0.014). Correct *shape* — settlement moves, TxValid does not, control flat — but no single metric clears Holm-Bonferroni at n = 10. |
| **The most durable statement.** | The cost of *being* a Plutus transaction fell by more than half: **−25.5% → −14.3% → −11.4%** throughput vs the script-free path. Each figure is self-contained within one version and one batch. |
| **Non-script throughput barely moved.** | 115.2 → 118.7 → 119.9 TPS (+4.1% over the whole span). The node did not get generally faster — it got faster **specifically on the script path**. |
| **Release-note claim.** | "Significantly increasing sustained in-head throughput" (2.3.0 / #2717) is **not supported** at this workload and operating point. |

---

## 1. Design: two interleaved batches with a shared bridge version

All 40 closed-loop runs share one profile — `200tps-10s-40lanes-chained-closed16-snapshot`
(closed-loop, in-flight bound **K = 16**, slots freed on `SnapshotConfirmed`, 2000 pre-signed
tx per run, head reseeded before every run).

| Batch | `env` | Versions | Pairs |
|---|---|---|---|
| **A** | `macos-arm64-il-200-vs-220` | 2.0.0 ↔ 2.2.0 | 10 × treatment + 10 × control |
| **B** | `macos-arm64-native-interleaved` | 2.2.0 ↔ 2.3.0 | 10 × treatment + 10 × control |

**2.2.0 sits in both batches**, which makes the span chainable (§4). Across all 40 runs:
drain **100%** (`confirmed == submitted`), `invalid = 0`, `staleInputRace = 0`.

Statistics throughout: exact sign-flip permutation test over the 2¹⁰ relabelings of the paired
differences (p floor = 0.002), bootstrap CIs over 20 000 resamples, difference-in-differences by
two-sample permutation. Δ% is the **mean of per-pair relative differences** — the quantity the
test operates on. It can differ in sign from the difference of medians when spread is asymmetric,
so level columns (medians) and Δ% columns are reported separately.

---

## 2. Batch A — 2.0.0 → 2.2.0 (the large step)

### Treatment: `perp-state`

| Metric | 2.0.0 | 2.2.0 | Δ% | 95% CI | pairs | p | ranges overlap? |
|---|---:|---:|---:|---|---:|---:|:---:|
| **confirm TPS** | 85.8 | 101.8 | **+19.3%** | `[+17.5, +21.3]` | **10/10** | **0.002** | **no** |
| **TxValid P50** | 74.9 ms | 45.5 ms | **−33.1%** | `[−39.5, −25.5]` | **10/10** | **0.002** | yes |
| **TxValid P95** | 126.2 ms | 100.2 ms | **−18.4%** | `[−24.8, −9.5]` | 9/10 | **0.004** | yes |
| **snapshot P50** | 184.5 ms | 148.9 ms | **−18.9%** | `[−20.4, −17.3]` | **10/10** | **0.002** | **no** |
| snapshot P95 | 209.9 ms | 199.6 ms | −7.1% | `[−13.5, −1.2]` | 7/10 | 0.061 | yes |
| tx / snapshot | 8.0 | 7.7 | −3.6% | — | **10/10** | **0.002** | **no** |

Raw per-run confirm TPS — the two distributions are disjoint with a 12.5 TPS gap:

```
2.0.0   86.6  85.8  86.8  86.3  85.1  85.6  86.9  84.5  82.6  85.9      max =  86.9
2.2.0  102.3 102.6  99.4  99.8 107.2 102.7 104.2 101.1 100.8 101.2      min =  99.4
```

**Multiple comparisons:** Holm-Bonferroni over the six metrics — **5 of 6 pass** at α = 0.05
(p_adj = 0.012 for confirm TPS, TxValid P50/P95, snapshot P50, tx/snapshot; snapshot P95 fails at
0.061). No correction is needed to *see* this effect; the ranges do not touch.

### Control: `noop-transfer` — it moves, and that is the correct outcome

| Metric | 2.0.0 | 2.2.0 | Δ% | pairs | p |
|---|---:|---:|---:|---:|---:|
| confirm TPS | 115.2 | 118.7 | **+4.0%** | 10/10 | 0.002 |
| TxValid P50 | 57.0 ms | 54.2 ms | −5.9% | 10/10 | 0.002 |
| TxValid P95 | 105.0 ms | 101.7 ms | −3.9% | 9/10 | 0.004 |
| snapshot P50 | 136.6 ms | 132.2 ms | −3.6% | 10/10 | 0.002 |
| snapshot P95 | 153.0 ms | 149.2 ms | −3.0% | 7/10 | 0.273 |
| tx / snapshot | 8.0 | 8.0 | 0.0% | 0/10 | 1.000 |

This is **not** the batching artifact described in §7. The batch is interleaved, and the movement
is what the mechanism predicts: 2.1.0 and 2.2.0 optimise the node loop **generically** —
[#2571](https://github.com/cardano-scaling/hydra/pull/2571) caches signable bytes,
[#2597](https://github.com/cardano-scaling/hydra/pull/2597) swaps `list` for `Seq`, and 2.2.0
switches to `Strict Map` and drops `newLocalUTxO` from per-tx and per-snapshot `StateChanged`
events. A script-free transaction *must* benefit from all of that. The +4.0% is that shared
component, measured.

Difference-in-differences — the part attributable to the script path specifically:

| Metric | treatment | control | **DiD** | p |
|---|---:|---:|---:|---:|
| confirm TPS | +19.3% | +4.0% | **+15.3%** | **<0.0001** |
| TxValid P50 | −33.1% | −5.9% | **−27.2%** | **0.0001** |
| TxValid P95 | −18.4% | −3.9% | **−14.5%** | **0.003** |
| snapshot P50 | −18.9% | −3.6% | **−15.3%** | **0.0001** |
| snapshot P95 | −7.1% | −3.0% | −4.2% | 0.34 |

---

## 3. Batch B — 2.2.0 → 2.3.0 (PR #2717)

hydra-node 2.3.0 ships **exactly one** runtime performance change:
[#2717](https://github.com/cardano-scaling/hydra/pull/2717) — snapshot processing no longer
re-evaluates Plutus scripts for transactions already validated on receipt. No number had been
published for it anywhere, and it cannot be measured by upstream's `bench-e2e`, whose dataset is
plain ADA payments with no script to skip.

| Metric | 2.2.0 | 2.3.0 | Δ% | 95% CI | pairs | p | p (Holm) |
|---|---:|---:|---:|---|---:|---:|---:|
| **confirm TPS** | 103.3 | 106.2 | **+2.7%** | `[+1.3, +4.3]` | 8/10 | **0.014** | 0.070 ❌ |
| snapshot P50 | 150.8 ms | 147.0 ms | −2.5% | `[−4.2, −0.9]` | 8/10 | 0.023 | 0.092 ❌ |
| snapshot P95 | 205.1 ms | 194.4 ms | −4.9% | `[−8.7, −0.9]` | 8/10 | 0.045 | 0.135 ❌ |
| TxValid P50 | 47.2 ms | 49.2 ms | +2.6% | `[−2.9, +8.0]` | 4/10 | 0.441 | 0.882 |
| TxValid P95 | 100.7 ms | 100.7 ms | +0.2% | `[−2.2, +2.5]` | 4/10 | 0.836 | 0.882 |

Control (`noop-transfer`) is flat, as #2717 requires — a transaction with no script has nothing
to skip: confirm TPS +0.7% (6/10, p = 0.109), snapshot P50 −0.8% (p = 0.098), snapshot P95 +0.2%
(p = 0.992).

Difference-in-differences: confirm TPS **+2.0%** (p = 0.032), snapshot P50 −1.7% (p = 0.101),
snapshot P95 −5.1% (p = 0.080), TxValid P50 **−0.2%** (p = 0.961).

**On significance.** With five metrics tested, **no single metric clears Holm-Bonferroni** at
α = 0.05 (best 0.014 → 0.070). State this first; a serious reviewer will raise it otherwise.
The evidence is the **pre-predicted shape**, not one p-value:

1. The PR text itself states it does not address the separate TxValid throughput ceiling.
   Observed: **3/3 settlement metrics move, 0/2 TxValid metrics move.** A directional prediction
   made in advance and then confirmed carries more weight than a raw p-value that has been
   penalised for multiplicity — this was not a post-hoc search.
2. The control is flat, including snapshot P95 at exactly +0.2%.
3. 8/10 pairs agree in direction on all three settlement metrics. The sign test alone on 8/10 is
   p ≈ 0.055 one-sided, with no distributional assumption.
4. TxValid P50 rises +2.6% in treatment **but +2.8% in control** — in-phase drift on both arms
   (plausibly the build-from-source residual, §8 caveat 2), DiD = −0.2%. Read through the DiD
   lens, "TxValid is untouched" is a *stronger* claim than p = 0.44 alone suggests.

**To close it properly:** from the observed per-pair SDs (Cohen's dz, target raw p < 0.010 to
clear Holm at 80% power) the requirement is **11 / 15 / 22 pairs** for confirm TPS / snapshot P50
/ snapshot P95. Ten exist. Roughly 12 more pairs — a few tens of minutes at 10 s per run — turns
this from "strongly suggestive" into "concluded". Batch A needs nothing further.

---

## 4. Bridge check, and the chained span

`2.2.0` appears in both batches, so the natural question is whether the two batches sit on the
same absolute scale. Tested directly on the shared version:

| Testcase | confirm TPS | TxValid P50 | snapshot P50 | snapshot P95 |
|---|---|---|---|---|
| `perp-state` | 101.8 → 103.3 (+1.6%, p = 0.47) | 45.5 → 47.2 (+3.7%, p = 0.45) | 148.9 → 150.8 (+1.3%, p = 0.53) | 199.6 → 205.1 (+2.7%, p = 0.68) |
| `noop-transfer` | 118.7 → 120.5 (+1.5%, p = 0.70) | 54.2 → 54.1 (−0.2%, p = 0.72) | 132.2 → 131.2 (−0.8%, p = 0.71) | 149.2 → 146.6 (−1.8%, p = 0.36) |

Same binary, two separate batches, disagreement ≤ 3.7% and no metric with p < 0.23 across all
twelve comparisons. **The batches chain**, carrying a systematic error term of roughly ±1.5%.

Chained 2.0.0 → 2.3.0 (product of the two deltas, closed-loop K = 16):

| Metric | treatment | control | **DiD (script path)** |
|---|---|---|---|
| **confirm TPS** | +19.3% × +2.7% = **+22.5%** | +4.0% × +0.7% = +4.7% | **+17.8%** |
| TxValid P50 | −33.1% × +2.6% = **−31.3%** | −5.9% × +2.8% = −3.3% | −28.1% |
| TxValid P95 | −18.4% × +0.2% = −18.3% | −3.9% × +0.3% = −3.6% | −14.6% |
| snapshot P50 | −18.9% × −2.5% = **−21.0%** | −3.6% × −0.8% = −4.4% | −16.5% |
| snapshot P95 | −7.1% × −4.8% = −11.6% | −3.0% × +0.2% = −2.8% | −8.8% |

A three-way interleaved batch would remove the ±1.5% bridge term entirely; until then, quote the
chained figures with that error stated.

---

## 5. The most durable result: what a Plutus transaction costs

These figures compare treatment against control **within one version and one batch**, so they
depend on no cross-batch assumption at all — the strongest form available in this dataset.

| hydra-node | `perp-state` (PlutusV3) | `noop-transfer` (no script) | cost of being a script tx |
|---|---:|---:|---:|
| **2.0.0** | **85.8 TPS** · 184.5 ms | 115.2 TPS · 136.6 ms | **−25.5% TPS · +35.1% latency** |
| **2.2.0** | **101.8 TPS** · 148.9 ms | 118.7 TPS · 132.2 ms | **−14.3% TPS · +12.6% latency** |
| **2.3.0** | **106.2 TPS** · 147.0 ms | 119.9 TPS · 130.7 ms | **−11.4% TPS · +12.5% latency** |

*(2.0.0 and 2.2.0 from batch A, 2.3.0 from batch B; snapshot P50 latency. 2.2.0 measured in
batch B gives −14.2% / +15.0% — consistent, per §4.)*

**The script penalty fell from 25.5% to 11.4% — more than halved — across three releases**, while
the script-free path moved only +4.1% (115.2 → 119.9 TPS). The node did not get generally faster;
it got faster on the script path.

This also bounds #2717 **from below, not above.** The validator is real — `perp_state` v1,
2.7 KB of compiled PlutusV3 enforcing five invariants (value conservation, solvency, maintenance
margin, `seq` monotonicity, operator authorisation) — but it is invoked on a **degenerate state**:
empty balances, no positions, no funding, no session keys, and a redeemer of
`MatchedOrders { batch: [], seq }`. Every invariant that folds a collection folds an empty one,
`authorized` reduces to a list-membership check with no crypto, and each invocation costs little
more than the script's fixed overhead. #2717's benefit scales with script cost, so a workload that
actually touches accounts wins more. For scale, the same codebase's `perp_state_v3` is 7.2 KB
compiled (2.6× v1) and verifies an MPF inclusion proof plus an ed25519 signature *per touched
account*. This measurement deliberately does not cover it.

---

## 6. Mechanism: snapshot cadence, not snapshot size

| | tx / snapshot | snapshots / s | confirm TPS |
|---|---:|---:|---:|
| 2.0.0 `perp-state` | 8.0 | **10.73** | 85.8 |
| 2.2.0 `perp-state` | 7.7 | **13.27** (+23.7%) | 101.8 |
| 2.0.0 `noop-transfer` | 8.0 | 14.40 | 115.2 |
| 2.2.0 `noop-transfer` | 8.0 | 14.84 (+3.0%) | 118.7 |

2.2.0 produces **24% more snapshots** while each carries **fewer** transactions (8.0 → 7.7, 10/10
pairs, p = 0.002). The entire throughput gain comes from **cadence**, not from batching harder.
The cadence deficit against the script-free ceiling narrows from 26% (2.0.0) to 11% (2.2.0).

The control holds exactly 8.0 tx/snapshot in both versions — that is K/2, pinned by the
closed-loop design — so `perp-state` dropping below 8.0 is signal, not noise.

---

## 7. Method, and the errors it took to get here

```bash
BENCH_TPS=200 BENCH_DURATION_S=10 BENCH_LANES=40 \
BENCH_INFLIGHT_MAX=16 BENCH_INFLIGHT_GATE=snapshot pnpm bench -t perp-state
```

**Error 1 — open-loop percentiles.** The first attempt fired open-loop at 200 TPS. The node
saturates there, so P95 measured the backlog, not the node: 17–23 seconds, and no metric
separated the versions. A `--latency` K sweep on one head shows the range this choice spans:

| K | confirm TPS | snapshot P50 | throughput efficiency vs K=1 |
|---:|---:|---:|---:|
| 1 | 25.3 | **36.9 ms** | 100% |
| 8 | 88.7 | 84.6 ms | 44% |
| **16** | **99.6** | 150.0 ms | 25% |
| 32 | 99.6 | 303.9 ms | 12% |
| 64 | 121.6 | 531.4 ms | 8% |
| 128 | 120.8 | **937.4 ms** | 4% |

Same node, same workload, **25× spread in "latency"** from pipeline depth alone. K = 16 sits just
past where throughput flattens (99.6 → 99.6 at K = 32 while latency doubles) — the deepest
pipeline that still keeps latency honest. Decomposing snapshot interval against tx/snapshot across
K = 16/50/200 gives ≈ **14 ms fixed per snapshot + 6.6 ms per tx**, implying an asymptotic ceiling
near 150 TPS on this rig: batching harder cannot rescue it, because the per-tx term dominates.

**Error 2 — batched run order.** Running all of 2.3.0 and then all of 2.2.0 mapped every
machine-level drift (thermal, background load, page cache) onto the version axis. In that batch
the **control gained +7%** — impossible for #2717. Re-running interleaved (A, B, A, B, …, flipping
which goes first) returned the control to flat and cut the treatment effect from +5.8% to +2.6%.
Cross-checking against batch A confirms where the artifact lived: 2.2.0 measured 103.1 TPS batched
vs 103.3 interleaved (identical), while 2.3.0 measured 109.0 batched vs 106.2 interleaved.

**Error 3 — a control rule stated unconditionally.** The rule previously recorded as *"read the
control first; if it is not flat, throw the treatment numbers away"* is correct for batch B and
**wrong for batch A**, where the control moves +4.0% at 10/10 pairs and that movement *confirms*
the mechanism. The rule is conditional on what the change does:

| Change is… | Correct control behaviour | Example |
|---|---|---|
| workload-specific (skips Plutus re-evaluation) | control must be **flat** | #2717, batch B |
| a generic node-loop optimisation | control **must move**, same direction, smaller than treatment | 2.1.0/2.2.0, batch A |

A flat control is not universally the pass condition. What is universal: the control's behaviour
must match the mechanism claimed, and treatment must exceed it (§2 DiD).

**Error 4 — a cross-batch comparison quoted as within-version.** An earlier script-cost table
paired `noop-transfer` from 2.3.0's sequential batch with `perp-state` from 2.2.0, crossing both
version and env. §5 recomputes it within version and batch.

**Statistics.** Min–max ranges of the two versions overlap in batch B even where the effect is
real, so the paired structure is what resolves it: each 2.3.0 run has an adjacent 2.2.0 run under
the same machine conditions, and the per-pair difference cancels drift. p-values are exact
sign-flip permutations over all 2¹⁰ relabelings; CIs are 20 000-resample bootstraps on the
per-pair relative differences; DiD p-values are two-sample permutations.

---

## 8. Caveats

1. **macOS arm64, single participant, fee = 0, exec-unit prices = 0.** Relative A/B is sound.
   These are **not** mainnet, multi-party, or throughput-ceiling numbers. On Apple Silicon a
   Docker head runs under emulation and caps near ~16 TPS; ceiling claims need
   `linux-x86_64-native`.
2. **2.2.0 was built from source.** Its GitHub release publishes **zero binaries** (verify:
   `gh release view 2.2.0 --repo cardano-scaling/hydra --json assets --jq '.assets|length'`), and
   the only artifact is an amd64 image that cannot run on Apple Silicon. The published zips come
   from `nix build .#release` on the same flake at the tag, so the recipe matches, but the binaries
   are not bit-identical. Part of batch B's in-phase TxValid drift may be this.
3. **One operating point.** K = 16, snapshot-gated. K = 50 and K = 200 data exist but only in the
   **sequential** env, so their version deltas are not quotable. Notably they trend *downward*
   with K (+5.7% at K=16, +4.1% at K=50, +1.7% at K=200), which would contradict the
   "effect grows nearer saturation" intuition — worth re-running interleaved before believing
   either direction.
4. **The floor, not the ceiling** — see §5 on the degenerate validator state.
5. **Bridge term.** The chained 2.0.0 → 2.3.0 figures in §4 carry ±1.5% systematic error until a
   three-way interleaved batch exists.
6. **Stale vendored blueprint.** `src/testcases/perp-state/plutus.json` holds `perp_state` v1 at
   2724 compiled bytes; the current `hydra-perps` build has v1 at 3208. Every run here used the
   vendored copy, so results are internally consistent — but re-vendor before comparing against
   numbers taken elsewhere.
7. **Not 2.4.0.** The `+890%` / "10x-perf" figures circulating for Hydra are **not** 2.3.0. That
   stack (#2776–#2780) merged 2026-07-23, eight days after the 2.3.0 tag, and lands in 2.4.0.
   Quoting it as a 2.3.0 result invalidates the report.

---

## 9. Appendix — open-loop saturation (absorption only; do not quote its percentiles)

18 runs, `perp-state` open-loop at a saturating 200 TPS × 30 s (6000 tx), n = 3 per version,
sequential batches. **These runs confirm only 11–15% of what they submit within the window**, so
`confirmTps` and the snapshot percentiles here are truncated by the measurement window and pinned
by queue depth — they are not throughput or latency. One quantity *is* robust, because it is
percentile-free and window-independent: the share of offered load the node validates.

| hydra-node | `TxValid` absorbed | validated TPS | TxValid P50 |
|---|---|---:|---:|
| 2.0.0 | 73 / 74 / 80% | 165.5 | 15.6 s |
| 2.2.0 | 86 / 89 / 93% | 199.1 | 11.6 s |
| 2.3.0 | 90 / 93 / **100%** | 206.2 | 10.7 s |

2.0.0 vs pooled {2.2.0, 2.3.0}, exact permutation (n = 3 vs 6, p floor 0.012): validated TPS
**+22.6%**, absorption **+23.6%**, TxValid P50 **−25.6%**, TxValid P95 **−20.7%** — all four with
**zero range overlap**, p = 0.012. The unabsorbed remainder was never rejected (`invalid = 0`);
it was still queued when the run ended.

Note those four metrics are **one quantity rescaled**, not four independent findings
(`absorption = validTps / offeredTps`, `validated count = validTps × window`). Little's Law
separates cause from effect: in-pipeline backlog is essentially constant (2543 → 2352 tx, −7.5%)
while drain rate rises +22.6%, so the entire latency improvement comes from faster consumption,
not a shorter queue.

`confirmTps` (25.5 → 28.1, p = 0.23) and snapshot P50 (12.4 → 12.8 s, p = 0.88) do **not**
separate here. That is a measurement limit, not a finding — the closed-loop data in §2 shows
settlement improving −18.9% over the same step. The earlier conclusion that
"2.0.0 → 2.2.0 made settlement worse (+11.4% snapshot P50)" was queue depth, not settlement cost.

One behavioural change is visible only here: node event-emit gap P50 fell 7 → 4 ms (p = 0.012, no
overlap) while P95 rose 14 → 26 ms. The distribution changed **shape** — tighter bursts separated
by longer pauses — rather than regressing. `nodeVsClient.verdict = both-continuous` on all 9 runs,
so there was no client-side bottleneck.

The control for this appendix runs at 20 TPS and is flat across all three versions (TxValid P50
7.44 / 7.49 / 7.35 ms, −1.1%, p = 0.41). That validates **host stability**, but it is not a
mechanism control, because it is not at a saturating operating point — unlike §2 and §3, where
control and treatment share the same K.

---

## 10. Reproduce

```bash
./infra/fetch-node.sh 2.3.0
./infra/fetch-node.sh 2.0.0
./infra/fetch-node.sh 2.2.0 --from <nix-built binary>   # no published binary; see docs/version-ab.md

# interleave the two versions of one step, flipping which goes first
for i in $(seq 1 10); do
  for v in 2.2.0:4004 2.3.0:4003; do
    V=${v%%:*}; P=${v##*:}
    ./infra/head.sh start --version $V --port $P
    BENCH_ENV=macos-arm64-native-interleaved \
    HYDRA_WS=ws://localhost:$P HYDRA_HTTP=http://localhost:$P \
    BENCH_TPS=200 BENCH_DURATION_S=10 BENCH_LANES=40 \
    BENCH_INFLIGHT_MAX=16 BENCH_INFLIGHT_GATE=snapshot pnpm bench -t perp-state
    ./infra/head.sh stop --version $V --port $P
  done
done

pnpm compare -t perp-state    --env macos-arm64-il-200-vs-220      --paired   # batch A
pnpm compare -t noop-transfer --env macos-arm64-il-200-vs-220      --paired   # batch A control
pnpm compare -t perp-state    --env macos-arm64-native-interleaved --paired   # batch B
pnpm compare -t noop-transfer --env macos-arm64-native-interleaved --paired   # batch B control
```

Raw runs live under
`results/<node-version>/<env>/<testcase>/200tps-10s-40lanes-chained-closed16-snapshot/run-NN/`.
Every `summary.json` carries the version the node itself reported in its Greetings frame, so a run
cannot be filed under a version it was not measured on, and `pnpm compare` only ever compares
within one (testcase, profile, env) group.

## 11. Next, in value order

| # | Work | Why |
|---|---|---|
| 1 | **+12 interleaved pairs at K = 16** for step B (total 22) | Only open item on #2717: brings all three settlement metrics past Holm. Tens of minutes. |
| 2 | **Three-way interleaved batch** (2.0.0 / 2.2.0 / 2.3.0) | Removes the ±1.5% bridge term from §4 and makes the chained span a direct measurement. |
| 3 | K = 50 / K = 200 **interleaved** | Current K-sweep deltas sit in the sequential env and are unquotable (caveat 3). Settles whether the effect grows or shrinks with snapshot size. |
| 4 | Non-empty `MatchedOrders` batches | Gives #2717's **ceiling**; today only its floor is known (§5). |
| 5 | `linux-x86_64-native` | Numbers that are both an A/B and a genuine throughput ceiling. |
| 6 | Re-vendor `plutus.json` | Caveat 6, before comparing against externally-taken numbers. |
