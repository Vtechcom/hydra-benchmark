# Running locally

End-to-end: boot a Hydra head, point the harness at it, run a testcase, read the result.

## 0. Prerequisites

| | |
|---|---|
| Node.js | ≥ 22 (`node -v`) |
| pnpm | `corepack enable && corepack prepare pnpm@latest --activate` |
| A Hydra head | a running `hydra-node` with WS + HTTP reachable and an in-head funded wallet |

```bash
pnpm install
cp .env.example .env     # edit HYDRA_WS / HYDRA_HTTP if your head isn't on the default :4003
```

The funding wallet must match `BENCH_MNEMONIC`. The default mnemonic is the pre-funded wallet of the offline devnet below — change it if your head funds a different wallet.

## 1. Boot a Hydra head

This repo benchmarks an **existing** head; it doesn't ship node infra. The simplest target is an **offline single-node** head (one participant, fee = 0, exec prices = 0 — a feasibility probe, not mainnet).

If you have the `hydra-perps` repo checked out next to this one, its compose files boot exactly that:

```bash
# offline benchmark head (RAM-backed persistence)
docker compose -f ../hydra-perps/infra/preprod-offline/docker-compose.yaml up -d

# wait for headStatus:"Open"
docker compose -f ../hydra-perps/infra/preprod-offline/docker-compose.yaml \
  logs --tail=20 | grep -o 'headStatus[^,]*' | tail -1
```

That head exposes WS/HTTP on `:4002` and a pre-funded wallet (1 UTxO). Set:

```bash
export HYDRA_WS=ws://localhost:4002 HYDRA_HTTP=http://localhost:4002
```

> Bringing up your own head instead? Any `hydra-node` works — just make sure the head is **Open**, a wallet is funded **in-head**, and that wallet matches `BENCH_MNEMONIC`. Verify with `curl -s $HYDRA_HTTP/snapshot/utxo | head -c 200`.

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

Sweep output goes to `results/perp-state/sweep.json`, `sweep-results.csv`, and `sweep.generated.md`.

`confirmTps` plateauing (stops rising as you raise the target) = the node ceiling.

## 5. Honest P95 near the knee (closed-loop)

Open-loop P95 at high TPS is inflated by **queue time**, not real confirm latency (see [interpreting-results.md](interpreting-results.md)). To measure the real cycle, bound in-flight txs:

```bash
# matching latency (slot freed on TxValid). K ≈ confirmTps × ~1s.
BENCH_TPS=200 BENCH_INFLIGHT_MAX=200 BENCH_DURATION_S=60 pnpm bench -t perp-state

# settlement latency (slot freed on SnapshotConfirmed)
BENCH_TPS=200 BENCH_INFLIGHT_MAX=200 BENCH_INFLIGHT_GATE=snapshot BENCH_DURATION_S=60 pnpm bench -t perp-state
```

Sweep `K` from 1 (serial floor) upward until P95 crosses the gate — `K*` just before the knee is the optimal pipeline depth.

## Platform note: macOS vs Linux

The `hydra-node` image is `linux/amd64`. On Apple Silicon it runs through Rosetta emulation, which caps sustained throughput (~16 TPS observed). To measure real high-TPS numbers, run the head on a **native x86_64 Linux** host (no emulation, no Docker-VM/VirtioFS). The harness itself is unaffected — only the node host matters.

## Troubleshooting

| Symptom | Fix |
|---|---|
| WS `ECONNREFUSED` | head not Open yet — wait for `headStatus:"Open"`; check node logs / port |
| `no spendable UTxO at <addr>` | wallet not funded in-head, or `BENCH_MNEMONIC` ≠ the funded wallet — re-fund / fix mnemonic |
| many `stale-input race` | offered rate outran lane revisit (`LANES/TPS`) — raise `BENCH_LANES`, use `--independent`, or `BENCH_INFLIGHT_MAX=K` |
| `TxInvalid` budget exceeded | redeemer exec units too low — raise them in the testcase's redeemer builder |
| huge P95 but `invalid=0` | saturation artifact, not a logic problem — re-run closed-loop (`BENCH_INFLIGHT_MAX`) |
| `confirmTps` low on Linux | check `docker stats` CPU; a single head is sequential — one core at ~100% = node-bound |
| etcd `address already in use` on node restart | orphan etcd holds the listen port — `pkill -9 etcd` before re-start |
