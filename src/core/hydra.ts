/**
 * Thin wrapper around `@hydra-sdk/bridge` so testcases and the runner talk to
 * one stable surface: connect, query/await UTxO, submit (sync, for setup) and
 * fire (async newTx, for the timed loop), plus a message subscription.
 *
 * The core never builds transactions — testcases own all tx construction. This
 * file is the only place that knows about the Hydra WS/HTTP protocol shape.
 */
import { HydraBridge } from '@hydra-sdk/bridge'
import { Converter } from '@hydra-sdk/core'

export type HydraMessage = Record<string, any>
export type MessageHandler = (msg: HydraMessage) => void

export type Utxo = {
	input: { txHash: string; outputIndex: number }
	output: { address: string; amount: { unit: string; quantity: string }[]; inlineDatum?: string }
	/** validator UTxOs may carry an app-level sequence number (their own state thread) */
	seq?: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class HydraClient {
	private bridge: HydraBridge
	/** `hydraNodeVersion` from the node's own Greetings — the result tree's version stamp. */
	private greetedVersion?: string

	constructor(
		public readonly ws: string,
		public readonly http: string
	) {
		this.bridge = new HydraBridge({ url: ws })
		// Attach before connect: Greetings is the first frame the node sends.
		this.bridge.events.on('onMessage', (msg: HydraMessage) => {
			if (!this.greetedVersion && typeof msg?.hydraNodeVersion === 'string') this.greetedVersion = msg.hydraNodeVersion
		})
	}

	async connect(): Promise<void> {
		if (!(await this.bridge.connect())) throw new Error(`cannot connect Hydra WS ${this.ws}`)
	}

	/**
	 * The node's self-reported version, e.g. `2.3.0-ef833d8a07d4…`.
	 *
	 * Taken from Greetings rather than from a flag on purpose: results are filed
	 * under this string, so a run can never be mislabelled as a version it was
	 * not measured on. Returns undefined if the node never announced one.
	 */
	async nodeVersion(timeoutMs = 5_000): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs
		while (!this.greetedVersion && Date.now() < deadline) await sleep(50)
		return this.greetedVersion
	}

	async disconnect(): Promise<void> {
		await this.bridge.disconnect()
	}

	/** Subscribe to every node message (TxValid / TxInvalid / SnapshotConfirmed / …). */
	onMessage(handler: MessageHandler): void {
		this.bridge.events.on('onMessage', handler)
	}

	/** Fire-and-forget submit on the hot path (the timed loop uses this). */
	newTx(signedCborHex: string, description = 'bench-load'): void {
		this.bridge.commands.newTx(signedCborHex, description)
	}

	/** Submit and await the node's validation — used off-clock during setup/fanout. */
	async submitTxSync(signedCborHex: string, txId: string, description = 'bench-setup') {
		return this.bridge.submitTxSync({
			cborHex: signedCborHex,
			type: 'Witnessed Tx ConwayEra',
			description,
			txId
		})
	}

	/** Raw snapshot UTxO set keyed by `txId#index`. */
	async snapshotUtxo(): Promise<Record<string, any>> {
		const res = await fetch(`${this.http}/snapshot/utxo`)
		return (await res.json()) as Record<string, any>
	}

	/** Snapshot UTxOs at a given address, decoded to the shared `Utxo` shape. */
	async queryUtxo(address: string): Promise<Utxo[]> {
		const obj = await this.snapshotUtxo()
		return Converter.convertUTxOObjectToUTxO(obj).filter(
			(u: any) => u.output.address === address
		) as unknown as Utxo[]
	}

	/** Block until `txId#index` (the key) appears in a snapshot, or time out. */
	async waitForUtxo(key: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const obj = await this.snapshotUtxo()
			if (obj[key]) return
			await sleep(200)
		}
		throw new Error(`timed out waiting for UTxO ${key}`)
	}
}
