# Benchmark heads — one per hydra-node version × host environment

Every head here is a single-party `hydra-node` in **offline mode**: no Cardano L1,
no chain socket, no peers, seeded at boot from `ledger/utxo-1.json`, fees and
exec-unit prices zeroed. That is the measurement rig for this repo.

The tree exists so that **version** and **environment** are the only things that
change between two runs:

```
infra/
  ledger/                 ← shared byte-for-byte by EVERY version and env (the control)
    protocol-parameters.json    fee = 0, executionUnitPrices = 0
    shelley-genesis.json        block time
    utxo-1.json                 seed UTxO at the BENCH_MNEMONIC address
  head.sh                 ← the only entrypoint: start | stop | status | list
  fetch-node.sh <version> ← bin/hydra-node-<version>
  envs/
    native.sh             ← host binary (macOS arm64, Linux x86_64, …)
    docker.sh + docker-compose.yaml   ← native amd64 hosts only
  bin/                    ← gitignored: hydra-node-2.2.0, hydra-node-2.3.0, …
  state/<version>/<env>/  ← gitignored: persistence, embedded etcd, keys, head.log
```

If the ledger config differed between two versions, a version delta would mean
nothing. It is one directory, shared, for exactly that reason.

---

## Use

```bash
./infra/fetch-node.sh 2.3.0          # binary → bin/hydra-node-2.3.0
./infra/head.sh start --version 2.3.0
pnpm bench -t perp-state
./infra/head.sh stop --version 2.3.0
```

| Command | |
|---|---|
| `head.sh start --version V [--env E] [--port P] [--keep-state]` | wipe state, boot, wait until the seed UTxO is actually live |
| `head.sh stop --version V [--port P]` | kill the node and any orphan embedded etcd |
| `head.sh status` | what was last started, plus which ports answer |
| `head.sh list` | binaries present and state dirs on disk |
| `fetch-node.sh V` | download (or symlink from a sibling checkout) that version |

**`start` wipes state by default.** A finished run leaves thousands of chained
UTxOs and a fat snapshot log behind; re-using that head measures the backlog
rather than a clean steady state. Pass `--keep-state` only when you mean it.

### Two versions side by side

Ports derive from `--port` (API `P`, listen `P+1000`, monitoring `P+2000`), and
state is keyed by version + env, so heads do not collide:

```bash
./infra/head.sh start --version 2.2.0 --port 4004
./infra/head.sh start --version 2.3.0 --port 4003
HYDRA_WS=ws://localhost:4004 HYDRA_HTTP=http://localhost:4004 pnpm bench -t perp-state
HYDRA_WS=ws://localhost:4003 HYDRA_HTTP=http://localhost:4003 pnpm bench -t perp-state
```

Results are filed under the version the **node itself reports** in its Greetings
frame, not under `--version`, so a typo in the flag cannot mislabel a datapoint.

### Environments

`--env` defaults to the detected host (`macos-arm64-native`, `linux-x86_64-native`, …).
Pass it explicitly to select or to label:

| `--env` | Runs via | Notes |
|---|---|---|
| `macos-arm64-native` | `envs/native.sh` | default on Apple Silicon |
| `linux-x86_64-native` | `envs/native.sh` | **the only env for ceiling numbers** |
| `docker` / `docker-*` | `envs/docker.sh` | native amd64 hosts only |

The env string becomes a directory level in `results/`, so numbers from different
hosts are never averaged together.

---

## macOS Apple Silicon: native, not Docker

The official `hydra-node` image is **amd64 only**, and hydra-node embeds an amd64
`etcd` binary as its network layer. That Go binary crashes under emulation:

| Backend | Failure |
|---|---|
| Rosetta | `Failed to create temporary file` |
| QEMU | etcd Go runtime SIGSEGV → `Sub-process etcd exited with: ExitFailure 2` |

No config fixes this. Hence the native binary from `fetch-node.sh`.

Rosetta also caps sustained node throughput (~16 TPS observed), so **a Mac number
is a relative A/B datapoint, not a ceiling**. Run `linux-x86_64-native` for
ceilings. The harness itself is unaffected — only the node host matters.

---

## Wallet

The seed UTxO in `ledger/utxo-1.json` must sit at the address derived from
`BENCH_MNEMONIC`, or every testcase dies with `no spendable UTxO at <addr>`:

```bash
pnpm address
# addr_test1qz5gzaepa69zsv2k6a3cmc8pw4qtjl03a859c6usldp4s6r5gw88l78t4wdzqzp6nettjf9vqu45ta4zkza20hhst3vq433aez
```

Changed the mnemonic? Paste the new address into `ledger/utxo-1.json` and restart.
The seed holds 100 000 000 ADA, so lane funding never binds.

The hydra **signing key** under `state/<version>/<env>/credentials/` is a different
thing — it signs snapshots, not transactions. A single-party offline head does not
care about its identity, so it is generated on first boot and gitignored.

---

## Ledger params

`ledger/protocol-parameters.json` is preprod-derived with two deliberate edits:

| Field | Value | Why |
|---|---|---|
| `txFeeFixed`, `txFeePerByte` | 0 | in-head txs pay no fee |
| `executionUnitPrices` | `{priceMemory: 0, priceSteps: 0}` | exec units cost nothing in-head |

Both testcases build transactions with matching zeros (`priceMem: 0, priceStep: 0`
on the SDK `TxBuilder`) — the SDK defaults to real preprod prices, which would
charge a script spend ~1.5 ADA the head never asks for and unbalance the chain.

This zeroing is also precisely why these numbers are a **feasibility probe, not a
mainnet measurement** — see [`docs/interpreting-results.md`](../docs/interpreting-results.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `hydra-node <v> not found` | `./infra/fetch-node.sh <v>`, or set `HYDRA_NODE_BIN` |
| WS `ECONNREFUSED` from the harness | head not up — check `state/<v>/<env>/head.log` |
| `no spendable UTxO at <addr>` | `ledger/utxo-1.json` address ≠ `BENCH_MNEMONIC` — see [Wallet](#wallet) |
| etcd `address already in use` | `./infra/head.sh stop --version <v> --port <p>`, then start again |
| Gatekeeper blocks the binary | `xattr -dr com.apple.quarantine infra/bin` |
| results land in `unknown-version/` | the node never sent `hydraNodeVersion` — check the WS URL points at a real head |
