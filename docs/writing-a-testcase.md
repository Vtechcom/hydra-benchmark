# Writing a new testcase

A testcase is a plug-in that owns **only the transaction shape**. The core gives you a connected `HydraClient`, the resolved config, and a logger; you give it a matrix of pre-signed transactions and a gate spec. Everything else — the timed loop, latency math, gate decision, report — is handled for you.

Use `src/testcases/noop-transfer/` as the smallest working reference, and `src/testcases/perp-state/` for a full Plutus example.

## The contract

```ts
// src/core/types.ts
export type Testcase = {
  name: string                 // CLI id: --testcase <name>
  description: string          // shown by --list
  gate: GateSpec               // { metric: 'txvalid'|'snapshot', p95Ms, requireZeroInvalid }
  prepare(ctx: PrepareContext): Promise<Signed[][]>   // returns chains[lane][i]
  meta?(ctx: PrepareContext): Record<string, unknown> // optional report metadata
}
```

`PrepareContext` = `{ config, client, log }`. A `Signed` is:

```ts
{ signed: string,   // signed tx CBOR hex
  txId:   string,   // computed from the bytes (use Resolver.resolveTxHash)
  lane:   number,
  i:      number,                 // position in the lane's chain
  trackKeys?: string[] }          // output keys `txId#idx` for snapshot-confirm matching
```

## Three steps

### 1. Create the folder

```
src/testcases/my-case/
  index.ts          # exports a `Testcase`
  blueprint.json    # (optional) any compiled validator / data your case needs
```

### 2. Implement `prepare`

Do the **off-clock** work: bootstrap, fanout the wallet into independent lanes, then pre-sign a forward-chain of `config.chainLen` txs per lane. Return one chain per lane.

```ts
import { AppWallet, NETWORK_ID, Resolver } from '@hydra-sdk/core'
import { TxBuilder } from '@hydra-sdk/transaction'
import type { PrepareContext, Signed, Testcase } from '../../core/types'

const newTxBuilder = () => new TxBuilder({ isHydra: true, params: { minFeeA: 0, minFeeB: 0 } })

export const myCase: Testcase = {
  name: 'my-case',
  description: 'what this fires',
  gate: { metric: 'txvalid', p95Ms: 200, requireZeroInvalid: true },

  async prepare({ config, client, log }: PrepareContext): Promise<Signed[][]> {
    const wallet = new AppWallet({ key: { type: 'mnemonic', words: config.mnemonic }, networkId: NETWORK_ID.PREPROD })
    const addr = wallet.getAccount(0, 0).baseAddressBech32

    // --- fanout: spend wallet → config.lanes independent seed UTxOs ---
    //   query client.queryUtxo(addr), build a fanout tx, client.submitTxSync(...),
    //   then client.waitForUtxo(`${txId}#${lastIdx}`, 30_000) before chaining off change.

    // --- pre-sign: for each lane, forward-chain config.chainLen txs ---
    const chains: Signed[][] = []
    for (let l = 0; l < config.lanes; l++) {
      const chain: Signed[] = []
      let input = /* lane seed */ undefined
      for (let i = 0; i < config.chainLen; i++) {
        const tx = await newTxBuilder()/* … build from input … */.complete()
        const signed = await wallet.signTx(tx.to_hex())
        const txId = Resolver.resolveTxHash(signed)
        chain.push({ signed, txId, lane: l, i, trackKeys: [`${txId}#0`] })
        input = /* this tx's output #0, for the next spend */ undefined
      }
      chains.push(chain)
    }
    return chains
  },
}
```

Rules that keep the measurement honest:

- **Independent lanes.** Each lane must have its own inputs (and collateral, if scripts) so lanes never conflict. Keep `config.lanes ≥ config.tps`.
- **Chain forward off your own outputs.** Compute the next input from the signed tx's output keys — never round-trip the node during pre-sign.
- **Set `trackKeys`** to the output keys that uniquely identify the tx, so the reporter can match `SnapshotConfirmed` even when the node lists confirmed UTxOs instead of txIds.
- **`--independent`** sets `config.chainLen = 1` for you — honour it by emitting exactly one tx per lane in that mode (the loop above already does).

### 3. Register it

```ts
// src/testcases/index.ts
import { myCase } from './my-case/index'
register(myCase)
```

Done:

```bash
pnpm bench --list                       # my-case now appears
pnpm bench --testcase my-case --smoke
```

## Testcase-specific env knobs

Read anything extra straight from `config.env`:

```ts
const lockAda = config.env.BENCH_MY_LOCK_ADA ? Number(config.env.BENCH_MY_LOCK_ADA) : 5
```

Document new knobs in `.env.example` and the README table.

## Choosing the gate

- Workload feasibility ("can the node *apply* this fast?") → `metric: 'txvalid'`.
- Settlement SLA ("how long until safe to withdraw?") → `metric: 'snapshot'` (and expect higher numbers — Hydra batches snapshots).
- `requireZeroInvalid: true` fails the gate on any **logic-reject** TxInvalid; stale-input races (rig timing) are always excluded.
