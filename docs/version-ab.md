# A/B-ing hydra-node versions

This repo's highest-value use is not "what is our TPS" — it is **what changed
between two hydra-node versions**, measured on a workload the upstream benchmarks
cannot measure.

## Why this rig can answer a question the official one cannot

> **Measured.** Every result in this repo is analysed in
> [`results/FINDINGS.md`](../results/FINDINGS.md): 2.2.0 → 2.3.0 is ~2% settlement
> throughput and latency on `perp-state` (p ≈ 0.014–0.045, 10 interleaved pairs),
> TxValid untouched, control flat — while 2.0.0 → 2.2.0 is **+19.3%** on the same
> workload and operating point (10/10 pairs, p = 0.002, non-overlapping ranges).

hydra-node 2.3.0 ships exactly **one** runtime performance change:
[#2717](https://github.com/cardano-scaling/hydra/pull/2717) — snapshot processing
no longer re-evaluates Plutus scripts for transactions already validated on
receipt. The release note calls that "significantly increasing sustained in-head
throughput"; **no number has been published for it anywhere.**

It cannot be published from upstream's own rig, either:

| Upstream `bench-e2e` | this harness |
|---|---|
| dataset = plain ADA payments | `perp-state` = **PlutusV3 script spend** (real validator, 5 invariants) |
| #2717 only helps **script-heavy** workloads | exactly that workload |
| one throughput number | offered / TxValid / SnapshotConfirmed separated |
| open-loop only | open-loop **and** closed-loop (`BENCH_INFLIGHT_MAX`) |
| single run | `pnpm compare` reports median + spread over N runs |

> **Mind the invocation, not just the validator.** `perp-state` runs a real
> validator, but on a degenerate state — empty balances, no positions, empty
> `MatchedOrders` batch — so each invocation costs little more than the script's
> fixed overhead — 11–14% of throughput vs the non-Plutus control, measured
> within each version at K=16. #2717's benefit
> scales with script cost, so this profile measures its **floor**. The ceiling
> needs `perp_state_v3` (MPF inclusion proof + ed25519 per touched account,
> 7.2 KB compiled, already built in `hydra-perps/onchain`).

#2717 attacks the **SnapshotConfirmed** stage specifically. The R1 numbers show
why that is the interesting stage:

```
6000 txs offered @ 191.4 TPS
  → 5229 TxValid           @ 166.8 TPS
  →  496 SnapshotConfirmed @  15.8 TPS   ← where #2717 acts
```

> The `+890%` / "10x-perf" figures circulating for Hydra are **not** 2.3.0. That
> stack (#2776–#2780) merged 23/07/2026, eight days after the 2.3.0 tag, and will
> land in 2.4.0. Quoting it as a 2.3.0 result invalidates the report.

## Which span you are measuring

`fetch-node.sh` will pull any released version. Be explicit about what a given
span contains, because only one of them is a single-variable experiment:

| Span | Contains | Reading |
|---|---|---|
| **2.2.0 → 2.3.0** | exactly one runtime perf change (#2717) | clean: a delta *is* #2717 |
| 2.1.0 → 2.2.0 | its **own** snapshot-path optimisation — per-tx and per-snapshot `StateChanged` events no longer carry `newLocalUTxO`, so the aggregate recomputes it arithmetically instead of serialising it (2.2.0 changelog) | a second, independent snapshot-path improvement; upstream describes 2.2.0 as carrying snapshot optimisations |
| **2.0.0 → 2.3.0** | everything in 2.1.0, 2.2.0 and 2.3.0 | a broad "how much faster has the node got", **not** attributable to #2717 |
| 2.3.0 → 2.4.0 | the 10x-perf stack (#2776–#2780) | see Experiment 2 |

2.0.0 (released 02/04/2026) is worth keeping as a long-baseline anchor, but never
quote a 2.0.0→2.3.0 delta as the effect of #2717.

**Careful with pre-2.2.0 baselines.** A measurement of the same `reapplyTx` change
taken against 2.1.0 is *not* comparable to the 2.2.0 → 2.3.0 number: 2.1.0 still
serialises `newLocalUTxO` on every snapshot event, so its snapshot path carries a
cost 2.2.0 removed. Two effects sit in that span, and a percentage measured across
it belongs to both.

## Getting a 2.2.0 binary (it is not published)

The 2.2.0 GitHub release (12/06/2026) carries **zero assets** — no darwin zip, no
linux zip — and the only artifact is the amd64-only container image, which cannot
run on Apple Silicon (its embedded etcd crashes under emulation). 2.0.0, 2.1.0 and
2.3.0 all publish binaries; 2.2.0 does not. Verify for yourself:

```bash
gh release view 2.2.0 --repo cardano-scaling/hydra --json assets --jq '.assets|length'   # 0
```

So the baseline half of the cleanest experiment has to be built from source:

```bash
git -C <hydra-checkout> worktree add /tmp/hydra-2.2.0 2.2.0
cd /tmp/hydra-2.2.0 && nix build .#hydra-node          # ~9 hydra derivations; deps come from cache
./infra/fetch-node.sh 2.2.0 --from /tmp/hydra-2.2.0/result/bin/hydra-node
```

`--from` refuses a binary whose `--version` does not match the version you name,
because one mislabelled binary poisons every result filed under it.

> The published zips are themselves produced by `nix build .#release` from this
> same flake at the tag (`.github/workflows/binaries.yaml`), so a local
> `nix build .#hydra-node` follows the same recipe — the source-vs-release
> difference is small, not a different compiler or flag set. It is still not
> bit-identical; say so if you quote the delta as a published-release number.

Keep the store path alive: `nix build --out-link infra/bin/.gcroot-hydra-node-<version>`
registers a GC root, so `nix store gc` cannot collect a binary the result tree
depends on. Point `--from` at that link, not at a temporary build dir.

## Experiment 1 — 2.2.0 vs 2.3.0 (the one nobody has run)

One variable: the node binary. Same ledger config, same host, same profile.

```bash
./infra/fetch-node.sh 2.2.0 --from …   # see above — no published binary
./infra/fetch-node.sh 2.3.0
```

Then run both testcases **interleaved** (loop below) — `perp-state` as the
treatment and `noop-transfer` as the control, at a pinned K near the knee.
Reseeding between runs is not optional; `head.sh start` does it by default.

### Interleave the versions — this is not optional either

Running all of version A and then all of version B maps **every** machine-level
drift (thermal, background load, page cache) directly onto the version axis. It
was measured here, not theorised: in a batched A/B, the `noop-transfer` **control**
— which has no Plutus script and therefore cannot benefit from #2717 — gained
**+7%** between 2.2.0 and 2.3.0. Re-running the identical comparison interleaved
(A, B, A, B, …, flipping which goes first) put the control back to flat (+0.7%,
p = 0.11) and cut the treatment effect from +5.8% to **+2.6%**.

```bash
for i in $(seq 1 10); do
  for v in 2.2.0:4004 2.3.0:4003; do
    V=${v%%:*}; P=${v##*:}
    ./infra/head.sh start --version $V --port $P
    BENCH_ENV=macos-arm64-native-interleaved \
    HYDRA_WS=ws://localhost:$P HYDRA_HTTP=http://localhost:$P \
    BENCH_INFLIGHT_MAX=16 BENCH_INFLIGHT_GATE=snapshot pnpm bench -t perp-state
    ./infra/head.sh stop --version $V --port $P
  done
done
```

Label the batch (`BENCH_ENV=…-interleaved`) so an interleaved series never pools
into one median with a batched one — they were taken under different conditions,
and pooling them hides exactly the artifact interleaving exists to remove.

### Reading it

1. **`noop-transfer` is the control — and it earns its keep.** Read it **first**.
   But "flat" is the pass condition only when the change is *workload-specific*:
   #2717 skips Plutus script evaluation, and a transaction with no script has
   nothing to skip, so a control that jumps means the setup moved. That is the
   check which caught the batching artifact above.

   **A moving control is not automatically a failure.** For a *generic* node-loop
   optimisation the control **must** move — same direction, smaller than treatment.
   Measured: across 2.0.0 → 2.2.0 (cache signable bytes, `Seq`, `Strict Map`,
   `newLocalUTxO` dropped from `StateChanged`) the control gained **+4.0%** at
   10/10 pairs while treatment gained +19.3%. Discarding that on a flat-control
   rule would have thrown away the largest real effect in the dataset.

   So the universal rule is not "control must be flat" — it is: **the control must
   behave the way the claimed mechanism requires, and treatment must exceed it.**
   Report the difference-in-differences, not the treatment delta alone.
2. **Read TxValid and SnapshotConfirmed separately.** Expect SnapshotConfirmed
   throughput up, TxValid roughly flat: the PR itself states it does not address
   the TxValid ceiling.
3. **Compare pairwise, not by range.** At n=10 the two versions' min–max ranges
   overlap even when the effect is real — a few percent hides inside run-to-run
   spread. Because interleaved runs come in adjacent pairs under the same machine
   conditions, the per-pair difference cancels that spread:

   ```bash
   pnpm compare -t perp-state --env <batch> --paired
   ```

   `--paired` reports mean Δ, how many pairs went each way, and an exact
   sign-flip permutation p-value (no normality assumption). With n pairs the
   smallest reachable p is 2/2^n — 10 pairs floor at 0.002, 5 pairs at 0.06, so a
   null result at n=5 means "underpowered", not "no effect".
4. **Pin K, and pick it near the knee.** Runs are closed-loop by default with an
   auto-calibrated K, but for an A/B pin it explicitly so both versions sit at the
   same operating point: `BENCH_INFLIGHT_MAX=16 BENCH_INFLIGHT_GATE=snapshot`.
   Find the knee first with `pnpm bench -t perp-state --latency` — on this rig
   throughput flattens around K≈16–32, and a K far above it re-introduces the
   queue time the closed loop exists to remove (K=200 measured snapshot P50
   1295ms vs 37ms at K=1).

## Experiment 2 — 2.3.0 vs the 10x-perf stack (future 2.4.0)

```bash
./infra/fetch-node.sh <2.4.0-or-a-master-build>
```

Extra control here: perf-1 changes the `maxTxsPerSnapshot` default from 100 to
1000. Run it twice — once at each version's default (what a user actually gets)
and once with the value pinned equal on both (how much faster the code is). The
two answers are different, and conflating them is the usual way this comparison
goes wrong.

## What the tree guarantees

`results/<node-version>/<env>/<testcase>/<profile>/run-NN/` — the version comes
from the node's own Greetings frame, so a run cannot be filed under a version it
was not measured on, and `pnpm compare` only ever compares within one
(testcase, profile, env) group. Numbers from a Mac and from Linux never end up in
the same median.

Environment matters as much as version: on Apple Silicon a Docker head runs under
emulation and caps out near ~16 TPS. Mac runs are fine for a **relative** A/B;
ceiling claims need `linux-x86_64-native`.
