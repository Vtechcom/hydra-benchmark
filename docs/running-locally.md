# Running locally

End-to-end: boot a Hydra head, point the harness at it, run a testcase, read the result.

## 0. Prerequisites

| | |
|---|---|
| Node.js | ≥ 22 (`node -v`) |
| pnpm | `corepack enable && corepack prepare pnpm@latest --activate` |
| A Hydra head | booted from `infra/` (below), or any reachable `hydra-node` with an in-head funded wallet |

```bash
pnpm install
cp .env.example .env     # edit HYDRA_WS / HYDRA_HTTP if your head isn't on the default :4003
```

The funding wallet must match `BENCH_MNEMONIC`. The default mnemonic is the pre-funded wallet of the offline devnet below — change it if your head funds a different wallet.

## 1. Boot a Hydra head

`infra/` ships the heads: an **offline single-node** head (one participant, fee = 0, exec prices = 0 — a feasibility probe, not mainnet), one directory per hydra-node version × host environment.

```bash
./infra/fetch-node.sh 2.3.0            # binary → infra/bin/hydra-node-2.3.0
./infra/head.sh start --version 2.3.0  # wipes state, boots, waits for the seed UTxO
```

It listens on `:4003` — the default in `.env` — and seeds one pre-funded in-head UTxO at the `BENCH_MNEMONIC` address. `--port` moves it, `--env` selects native vs docker, `--keep-state` skips the wipe. Full reference: [`infra/README.md`](../infra/README.md).

```bash
./infra/head.sh status     # what's running
./infra/head.sh stop --version 2.3.0
```

> Pointing at a head you booted yourself? Any `hydra-node` works — make sure it is **Open**, a wallet is funded **in-head**, and that wallet matches `BENCH_MNEMONIC`. Verify with `curl -s $HYDRA_HTTP/snapshot/utxo | head -c 200`. Its results are filed under whatever version it reports in Greetings.

## 2. Sanity run (always do this first)

Use the smoke profile for the first sanity check:

```bash
pnpm bench --testcase noop-transfer --smoke   # non-Plutus floor — expect GATE PASS, P95 a few ms
pnpm bench --testcase perp-state --smoke      # real validator — expect GATE PASS at 20 TPS
```

The smoke run is small (40 lanes, 20 TPS, ~6 s) and finishes in well under a minute after pre-sign. If it fails, fix that before scaling up.

## 3. Full run

The default full profile follows the current R1 rig (200 TPS × 60s × 400 lanes → 12000 txs):

```bash
pnpm bench --testcase perp-state
```

Pre-sign (serial WASM) takes minutes at full scale — it is **off the clock** and logged with an ETA. Then the timed fire window runs; stdout prints a per-second progress line and a final `GATE PASS/FAIL` line.

### How many txs do I pre-sign? (sizing)

The number you pre-sign is fixed by **one formula**:

```
TOTAL = TPS × DURATION_S
```

To sustain `TPS` for `DURATION_S` seconds, every fired tx is a unique pre-signed tx, so you need `TPS × DURATION` of them. `200 × 60 = 12000`.

**`LANES` and `CHAIN` do NOT change the total** — only how it is split:

- `CHAIN = ceil(TPS × DURATION / LANES)`, so `LANES × CHAIN ≈ TPS × DURATION` always.
- `400 lanes × 30 = 12000`; drop to `200 lanes` → `CHAIN = 60` → still `12000`.
- `--independent` is also `12000` (`LANES = 12000 × CHAIN = 1`).

`LANES` is just how many parallel state-threads the total splits across. The only constraint: keep **`LANES ≥ TPS`** so a lane is revisited every `LANES/TPS ≥ 1 s` (else stale-input races). `400` lanes @ `200` TPS = `2 s` revisit — comfortable.

So the only two levers that shrink pre-signing are **`DURATION_S`** (the main one) and **`TPS`**. 30 s already gives plenty of samples for a stable P95 — 60 s is only needed for an official "sustained 60 s" claim.

| Goal | TPS | DURATION | LANES | CHAIN (auto) | total txs |
|---|---:|---:|---:|---:|---:|
| smoke sanity | 20 | 6 | 40 | 3 | **120** |
| quick dev | 50 | 20 | 100 | 10 | **1000** |
| one sweep point | target | 30 | target × 2 | auto | target × 30 |
| full gate (lean) | 200 | 30 | 400 | 15 | **6000** |
| default full | 200 | 60 | 400 | 30 | **12000** |
| honest P95 (closed-loop) | 200 | 30 | 200 | 30 | 6000 + `BENCH_INFLIGHT_MAX≈200` |

```bash
# lean full gate — 6000 txs instead of 12000
BENCH_TPS=200 BENCH_DURATION_S=30 BENCH_LANES=400 pnpm bench -t perp-state
```

> Tip: `BENCH_CHAIN` can be set explicitly to pin chain length, but prefer lowering `BENCH_DURATION_S` — that is what actually cuts the signing time.

## 4. Find the sustainable TPS ceiling (sweep)

Run a throughput-knee sweep to find where TxValid throughput stops tracking offered throughput:

```bash
BENCH_SWEEP="24,60,120,200,300" BENCH_STEP_S=12 pnpm bench -t perp-state
```

Sweep output goes to the run dir for the sweep profile — `results/<node-version>/<env>/perp-state/sweep-24-60-120-200-300tps-12s/run-NN/` — as `sweep.json`, `sweep-results.csv` and `sweep.generated.md`.

`confirmTps` plateauing (stops rising as you raise the target) = the node ceiling.

## 5. Service time, not queue time

Every ordinary run is already closed-loop — the in-flight bound `K` is calibrated from a short warm-up so P50/P95 measure the work itself. Nothing to pass:

```bash
pnpm bench -t perp-state          # [calibrate] K=20 — confirm ~101 TPS × target 200ms
```

To see the whole curve — the service-time floor at `K=1` and where queueing takes over — sweep `K`:

```bash
pnpm bench -t perp-state --latency
```

Measured on this rig (2.3.0, macOS arm64 native, snapshot-gated slots):

| K | confirm TPS | TxValid P50 | snapshot P50 |
|---:|---:|---:|---:|
| 1 | 25.3 | **7.7 ms** | **36.9 ms** |
| 16 | 99.6 | 52.4 | 150.0 |
| 32 | 99.6 | 108.6 | 303.9 |
| 128 | 120.8 | 344.9 | 937.4 |

Throughput stops climbing around `K≈16–32` while latency keeps doubling with `K`. Everything past that is queue: the same node reports `37ms` or `937ms` snapshot P50 depending only on pipeline depth. Pick the operating point, then pin it with `BENCH_INFLIGHT_MAX=<K>` so runs are exactly reproducible.

Use `--open-loop` only when saturation is the thing you want to observe (throughput ceiling / knee), and never quote its P95 as latency.

## 6. Compare across versions

Every run is filed under the version the node reports and the host it ran on, so version A/B is a matter of booting the other binary and re-running the same profile:

```bash
./infra/fetch-node.sh 2.2.0
./infra/head.sh start --version 2.2.0
pnpm bench -t perp-state
pnpm compare -t perp-state       # median + min–max per version
```

Method, controls and what to expect: [`version-ab.md`](version-ab.md).

## Platform note: macOS vs Linux

The `hydra-node` **image** is `linux/amd64`, and the binary embeds an amd64 `etcd` that crashes under emulation on Apple Silicon — so `infra/head.sh` runs a **native** binary there (`envs/native.sh`). Rosetta also caps sustained throughput (~16 TPS observed), so Mac numbers are fine for a *relative* A/B but are not ceilings. For real high-TPS numbers run the head on a **native x86_64 Linux** host (no emulation, no Docker-VM/VirtioFS). The harness itself is unaffected — only the node host matters.

## Troubleshooting

| Symptom | Fix |
|---|---|
| WS `ECONNREFUSED` | head not Open yet — wait for `headStatus:"Open"`; check node logs / port |
| `no spendable UTxO at <addr>` | wallet not funded in-head, or `BENCH_MNEMONIC` ≠ the funded wallet — re-fund / fix mnemonic |
| many `stale-input race` | offered rate outran lane revisit (`LANES/TPS`) — raise `BENCH_LANES`, use `--independent`, or `BENCH_INFLIGHT_MAX=K` |
| `TxInvalid` budget exceeded | redeemer exec units too low — raise them in the testcase's redeemer builder |
| huge P95 but `invalid=0` | saturation artifact, not a logic problem — re-run closed-loop (`BENCH_INFLIGHT_MAX`) |
| `confirmTps` low on Linux | check `docker stats` CPU; a single head is sequential — one core at ~100% = node-bound |
| etcd `address already in use` on node restart | orphan etcd holds the listen port — `./infra/head.sh stop --version <v>` reaps it, then start again |
