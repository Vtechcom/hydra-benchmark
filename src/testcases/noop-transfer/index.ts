/**
 * Testcase: `noop-transfer` — minimal NON-Plutus baseline.
 *
 * Each lane is a single wallet UTxO; each chained tx is a self-payment (spend
 * the UTxO, send the same value straight back to the wallet, in-head fee = 0).
 * No validator, no datum, no collateral. It measures the node's floor cost of
 * applying + snapshotting a plain payment, and serves as the reference example
 * for "how do I add a testcase" (see docs/writing-a-testcase.md) — it exercises
 * the full harness with the least possible tx machinery.
 */
import { AppWallet, NETWORK_ID, Resolver } from '@hydra-sdk/core'
import { CardanoWASM } from '@hydra-sdk/cardano-wasm'
import { TxBuilder } from '@hydra-sdk/transaction'
import type { PrepareContext, Signed, Testcase } from '../../core/types'
import type { Utxo } from '../../core/hydra'

const lovelace = (q: string | number) => [{ unit: 'lovelace', quantity: String(q) }]
const newTxBuilder = () => new TxBuilder({ isHydra: true, params: { minFeeA: 0, minFeeB: 0 } })

type Ctx = { wallet: AppWallet; walletAddress: string; laneLL: string; fanoutPerTx: number }

function deriveCtx(p: PrepareContext): Ctx {
	const { config } = p
	const wallet = new AppWallet({ key: { type: 'mnemonic', words: config.mnemonic }, networkId: NETWORK_ID.PREPROD })
	const walletAddress = wallet.getAccount(0, 0).baseAddressBech32
	const num = (k: string, d: number) => (config.env[k] ? Number(config.env[k]) : d)
	return {
		wallet,
		walletAddress,
		laneLL: String(num('BENCH_LANE_ADA', 3) * 1_000_000),
		fanoutPerTx: num('BENCH_FANOUT_PER_TX', 60)
	}
}

const mkUtxo = (txHash: string, idx: number, addr: string, ll: string): Utxo => ({
	input: { txHash, outputIndex: idx },
	output: { address: addr, amount: [{ unit: 'lovelace', quantity: ll }] }
})

// ── phase 1: fanout → LANES independent funding UTxOs ────────────────────────────────────
async function fanout(p: PrepareContext, c: Ctx): Promise<Utxo[]> {
	const { client, config, log } = p
	log(`[fanout] ${config.lanes} lanes × {funding@${Number(c.laneLL) / 1e6} ADA}`)
	const lanes: Utxo[] = []
	let remaining = config.lanes

	while (remaining > 0) {
		const walletUtxos = await client.queryUtxo(c.walletAddress)
		if (!walletUtxos.length) throw new Error(`no spendable UTxO at ${c.walletAddress}`)
		const funding = walletUtxos.sort((a, b) => Number(b.output.amount[0].quantity) - Number(a.output.amount[0].quantity))[0]

		const n = Math.min(c.fanoutPerTx, remaining)
		const tb = newTxBuilder().setInputs([funding] as any)
		for (let i = 0; i < n; i++) tb.addOutput({ address: c.walletAddress, amount: lovelace(c.laneLL) })
		const tx = await tb.changeAddress(c.walletAddress).complete()
		const signed = await c.wallet.signTx(tx.to_hex())
		const txId = Resolver.resolveTxHash(signed)
		await client.submitTxSync(signed, txId, 'bench-fanout')

		for (let i = 0; i < n; i++) lanes.push(mkUtxo(txId, i, c.walletAddress, c.laneLL))
		remaining -= n
		log(`[fanout] tx ${txId.slice(0, 12)}… +${n} lanes (left ${remaining})`)
		await client.waitForUtxo(`${txId}#${n - 1}`, 30_000)
	}
	log(`[fanout] done: ${lanes.length} lanes`)
	return lanes
}

// ── phase 2: pre-sign a chain of self-payments per lane ──────────────────────────────────
function buildTransfer(c: Ctx, input: Utxo): Promise<CardanoWASM.Transaction> {
	// spend the lane UTxO, send the same value straight back to the wallet (in-head fee = 0).
	return newTxBuilder()
		.setInputs([input] as any)
		.addOutput({ address: c.walletAddress, amount: lovelace(c.laneLL) })
		.changeAddress(c.walletAddress)
		.complete() as Promise<CardanoWASM.Transaction>
}

async function presign(p: PrepareContext, c: Ctx, lanes: Utxo[]): Promise<Signed[][]> {
	const { config, log } = p
	log(`[presign] ${config.lanes} lanes × ${config.chainLen} = ${config.totalTxs} txs (off the clock)…`)
	const t0 = Date.now()
	const chains: Signed[][] = []
	let done = 0
	for (let l = 0; l < lanes.length; l++) {
		let input = lanes[l]
		const chain: Signed[] = []
		for (let i = 0; i < config.chainLen; i++) {
			const tx = await buildTransfer(c, input)
			const signed = await c.wallet.signTx(tx.to_hex())
			const txId = Resolver.resolveTxHash(signed)
			chain.push({ signed, txId, lane: l, i, trackKeys: [`${txId}#0`] })
			input = mkUtxo(txId, 0, c.walletAddress, c.laneLL) // chain forward off output #0
			done++
		}
		chains.push(chain)
		if ((l + 1) % 100 === 0 || l + 1 === lanes.length) {
			const rate = done / ((Date.now() - t0) / 1000)
			log(`[presign] ${done}/${config.totalTxs} (${rate.toFixed(0)} tx/s)`)
		}
	}
	log(`[presign] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
	return chains
}

export const noopTransfer: Testcase = {
	name: 'noop-transfer',
	description: 'Plain in-head ADA self-payment (no Plutus) — node floor cost + reference example for new testcases.',
	gate: { metric: 'txvalid', p95Ms: 200, requireZeroInvalid: true },
	async prepare(p) {
		const c = deriveCtx(p)
		p.log(`[noop-transfer] wallet ${c.walletAddress.slice(0, 20)}…`)
		const lanes = await fanout(p, c)
		return presign(p, c, lanes)
	},
	meta(p) {
		const c = deriveCtx(p)
		return { wallet: c.walletAddress, laneAda: Number(c.laneLL) / 1e6, note: 'non-Plutus baseline' }
	}
}
