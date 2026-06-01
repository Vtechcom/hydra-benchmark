/**
 * The plug-in contract every testcase implements. The core harness owns the
 * timed fire+measure loop, the latency math, the gate decision and the report;
 * a testcase owns everything transaction-specific — bootstrap, fanout, and
 * pre-signing the matrix of txs the runner will fire.
 *
 * See `docs/writing-a-testcase.md` for a step-by-step guide.
 */
import type { BenchConfig } from './config'
import type { HydraClient } from './hydra'

/** A pre-signed transaction, ready to be fired on the clock. */
export type Signed = {
	/** signed transaction CBOR hex */
	signed: string
	/** txId computed from the signed bytes (no node round-trip) */
	txId: string
	/** which lane (independent state thread) this belongs to */
	lane: number
	/** position within the lane's pre-signed chain (0-based) */
	i: number
	/**
	 * Output UTxO keys (`txId#index`) this tx produces that uniquely identify it.
	 * Used as a fallback to match SnapshotConfirmed → tx when the snapshot message
	 * lists confirmed UTxOs rather than confirmed txIds. Optional.
	 */
	trackKeys?: string[]
}

export type GateSpec = {
	/** which ack latency the PASS/FAIL gate is decided on */
	metric: 'txvalid' | 'snapshot'
	/** P95 latency threshold in ms */
	p95Ms: number
	/** when true, any logic-reject (non stale-input) TxInvalid fails the gate */
	requireZeroInvalid: boolean
}

export type PrepareContext = {
	config: BenchConfig
	client: HydraClient
	log: (msg: string) => void
}

export type Testcase = {
	/** unique id used on the CLI: `--testcase <name>` */
	name: string
	/** one-line human description (shown by `--list`) */
	description: string
	/** default gate criteria; `config.gateMs` overrides `gate.p95Ms` when set */
	gate: GateSpec
	/**
	 * Off-clock preparation. Bootstrap any state, fan the wallet out into
	 * independent lanes, and pre-sign each lane's chain of txs. Returns one
	 * signed-chain per lane (`chains[lane][i]`). The runner fires them
	 * round-robin, column-major (all lanes' tx i, then i+1, …).
	 */
	prepare(ctx: PrepareContext): Promise<Signed[][]>
	/** optional metadata merged into the report (e.g. validator hash/address) */
	meta?(ctx: PrepareContext): Record<string, unknown>
}
