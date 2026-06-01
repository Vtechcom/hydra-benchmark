/**
 * Testcase: `perp-state` — the original r1-spike workload.
 *
 * Smallest PlutusV3 script-spend that touches a REAL validator (`perp_state`,
 * Story 3.1, parameterised by an `operator` vkey hash). Each tx spends a
 * validator-locked UTxO carrying an inline `PerpState` datum and emits a fresh
 * one with `seq` bumped by 1, authorised by a no-op `MatchedOrders { batch: [],
 * seq }` redeemer (conserves value 0==0, bumps seq → all 5 invariants hold).
 *
 *   Phase 1 (fanout): spend the wallet into LANES independent seed triples —
 *     each lane = {validator UTxO seq0, funding UTxO, dedicated collateral}.
 *   Phase 2 (pre-sign): forward-chain CHAIN_LEN spends per lane; txIds computed
 *     from signed bytes (no node round-trip). All off the clock.
 *
 * The core harness fires the matrix round-robin and measures. See
 * `src/testcases/perp-state/plutus.json` for the validator blueprint.
 */
import { AppWallet, NETWORK_ID, PlutusUtils, Resolver } from '@hydra-sdk/core'
import { CardanoWASM } from '@hydra-sdk/cardano-wasm'
import { TxBuilder } from '@hydra-sdk/transaction'
import type { PrepareContext, Signed, Testcase } from '../../core/types'
import type { Utxo } from '../../core/hydra'
import plutus from './plutus.json' with { type: 'json' }

const lovelace = (q: string | number) => [{ unit: 'lovelace', quantity: String(q) }]
const newTxBuilder = () => new TxBuilder({ isHydra: true, params: { minFeeA: 0, minFeeB: 0 } })

// Per-run state derived once in prepare() and reused by helpers via this closure-ish module object.
type Ctx = {
	wallet: AppWallet
	walletAddress: string
	operatorVkhHex: string
	scriptCborHex: string
	validatorAddress: string
	lockLL: string
	fundLL: string
	colLL: string
	lockAda: number
	fundAda: number
	colAda: number
	fanoutPerTx: number
}

function deriveCtx(p: PrepareContext): Ctx {
	const { config } = p
	const wallet = new AppWallet({ key: { type: 'mnemonic', words: config.mnemonic }, networkId: NETWORK_ID.PREPROD })
	const account = wallet.getAccount(0, 0)
	const walletAddress = account.baseAddressBech32

	// operator = this wallet's payment key hash; baked as the validator param + a required signer on
	// every spend so each MatchedOrders batch is self-authorised (invariant 5).
	const operatorKeyHash = CardanoWASM.BaseAddress.from_address(account.baseAddress)!.payment_cred().to_keyhash()!
	const operatorVkhHex = operatorKeyHash.to_hex()

	const vEntry = (plutus.validators as { title: string; compiledCode: string; hash: string }[]).find(
		v => v.title === 'perp_state.perp_state.spend'
	)
	if (!vEntry) throw new Error('perp_state.perp_state.spend not in plutus.json')
	const operatorParam = CardanoWASM.PlutusData.new_bytes(operatorKeyHash.to_bytes()).to_bytes()
	const scriptCborHex = PlutusUtils.applyParamsToScript(vEntry.compiledCode, [operatorParam])
	const validatorAddress = PlutusUtils.validatorToAddress({ type: 'PlutusV3', scriptCborHex }, NETWORK_ID.PREPROD)

	const num = (k: string, d: number) => (config.env[k] ? Number(config.env[k]) : d)
	const lockAda = num('BENCH_LOCK_ADA', num('R1_LOCK_ADA', 5))
	const fundAda = num('BENCH_FUND_ADA', num('R1_FUND_ADA', 2))
	const colAda = num('BENCH_COLLATERAL_ADA', num('R1_COLLATERAL_ADA', 5))
	const fanoutPerTx = num('BENCH_FANOUT_PER_TX', num('R1_FANOUT_PER_TX', 60))

	return {
		wallet,
		walletAddress,
		operatorVkhHex,
		scriptCborHex,
		validatorAddress,
		lockLL: String(lockAda * 1_000_000),
		fundLL: String(fundAda * 1_000_000),
		colLL: String(colAda * 1_000_000),
		lockAda,
		fundAda,
		colAda,
		fanoutPerTx
	}
}

// Minimal accepted PerpState: empty balances/positions/funding, zero pnl/insurance/vault, monotonic seq.
function buildPerpState(seq: number): CardanoWASM.PlutusData {
	const f = CardanoWASM.PlutusList.new()
	f.add(CardanoWASM.PlutusData.new_map(CardanoWASM.PlutusMap.new())) // balances: Pairs (empty)
	f.add(CardanoWASM.PlutusData.new_list(CardanoWASM.PlutusList.new())) // positions: []
	f.add(CardanoWASM.PlutusData.new_bytes(new Uint8Array())) // orderbook_root: #""
	f.add(CardanoWASM.PlutusData.new_integer(CardanoWASM.BigInt.from_str('0'))) // realized_pnl
	f.add(CardanoWASM.PlutusData.new_list(CardanoWASM.PlutusList.new())) // funding: []
	f.add(CardanoWASM.PlutusData.new_integer(CardanoWASM.BigInt.from_str('0'))) // insurance
	f.add(CardanoWASM.PlutusData.new_integer(CardanoWASM.BigInt.from_str('0'))) // vault
	f.add(CardanoWASM.PlutusData.new_integer(CardanoWASM.BigInt.from_str(String(seq)))) // seq
	return CardanoWASM.PlutusData.new_constr_plutus_data(CardanoWASM.ConstrPlutusData.new(CardanoWASM.BigNum.from_str('0'), f))
}

// Redeemer: MatchedOrders { batch: [], seq } = Constr(0, [ [], seq ]).
function matchedOrdersRedeemer(seq: number): CardanoWASM.Redeemer {
	const f = CardanoWASM.PlutusList.new()
	f.add(CardanoWASM.PlutusData.new_list(CardanoWASM.PlutusList.new())) // batch: []
	f.add(CardanoWASM.PlutusData.new_integer(CardanoWASM.BigInt.from_str(String(seq)))) // seq
	const data = CardanoWASM.PlutusData.new_constr_plutus_data(CardanoWASM.ConstrPlutusData.new(CardanoWASM.BigNum.from_str('0'), f))
	return CardanoWASM.Redeemer.new(
		CardanoWASM.RedeemerTag.new_spend(),
		CardanoWASM.BigNum.from_str('0'),
		data,
		CardanoWASM.ExUnits.new(CardanoWASM.BigNum.from_str('14000000'), CardanoWASM.BigNum.from_str('10000000000'))
	)
}

type Lane = { validator: Utxo; funding: Utxo; collateral: Utxo }

const mkFundingUtxo = (txHash: string, idx: number, addr: string, ll: string): Utxo => ({
	input: { txHash, outputIndex: idx },
	output: { address: addr, amount: [{ unit: 'lovelace', quantity: ll }] }
})
const mkValidatorUtxo = (c: Ctx, txHash: string, idx: number, seq: number): Utxo => ({
	input: { txHash, outputIndex: idx },
	output: { address: c.validatorAddress, amount: [{ unit: 'lovelace', quantity: c.lockLL }], inlineDatum: buildPerpState(seq).to_hex() },
	seq
})

// ── phase 1: fanout → LANES independent {validator, funding, collateral} triples ──────────
async function fanout(p: PrepareContext, c: Ctx): Promise<Lane[]> {
	const { client, config, log } = p
	log(`[fanout] ${config.lanes} lanes × {validator@${c.lockAda} + funding@${c.fundAda} + collateral@${c.colAda}} ADA`)
	const lanes: Lane[] = []
	let remaining = config.lanes
	const perTx = Math.max(1, Math.floor(c.fanoutPerTx / 3)) // 3 outputs per lane

	while (remaining > 0) {
		const walletUtxos = await client.queryUtxo(c.walletAddress)
		if (!walletUtxos.length) throw new Error(`no spendable UTxO at ${c.walletAddress}`)
		const funding = walletUtxos.sort((a, b) => Number(b.output.amount[0].quantity) - Number(a.output.amount[0].quantity))[0]

		const n = Math.min(perTx, remaining)
		const tb = newTxBuilder().setInputs([funding] as any)
		let idx = 0
		const triples: { v: number; f: number; col: number }[] = []
		for (let i = 0; i < n; i++) {
			tb.addOutput({ address: c.validatorAddress, amount: lovelace(c.lockLL) }).txOutInlineDatumValue(buildPerpState(0))
			const v = idx++
			tb.addOutput({ address: c.walletAddress, amount: lovelace(c.fundLL) })
			const f = idx++
			tb.addOutput({ address: c.walletAddress, amount: lovelace(c.colLL) })
			const col = idx++
			triples.push({ v, f, col })
		}
		const tx = await tb.changeAddress(c.walletAddress).complete()
		const signed = await c.wallet.signTx(tx.to_hex())
		const txId = Resolver.resolveTxHash(signed)
		await client.submitTxSync(signed, txId, 'bench-fanout')

		for (const t of triples)
			lanes.push({
				validator: mkValidatorUtxo(c, txId, t.v, 0),
				funding: mkFundingUtxo(txId, t.f, c.walletAddress, c.fundLL),
				collateral: mkFundingUtxo(txId, t.col, c.walletAddress, c.colLL)
			})
		remaining -= n
		log(`[fanout] tx ${txId.slice(0, 12)}… +${n} lanes (left ${remaining})`)
		await client.waitForUtxo(`${txId}#${idx - 1}`, 30_000)
	}
	log(`[fanout] done: ${lanes.length} lanes`)
	return lanes
}

// ── phase 2: pre-sign every lane's chain (cold, off the clock) ───────────────────────────
function buildSpend(c: Ctx, scriptUtxo: Utxo, funding: Utxo, collateral: Utxo): Promise<CardanoWASM.Transaction> {
	const inSeq = scriptUtxo.seq ?? 0
	const outSeq = inSeq + 1 // strict seq monotonicity (invariant 4): out.seq > in.seq
	return newTxBuilder()
		.setInputs([funding] as any)
		.txIn(scriptUtxo.input.txHash, scriptUtxo.input.outputIndex, lovelace(c.lockLL) as any, c.validatorAddress)
		.txInScript(c.scriptCborHex)
		.txInInlineDatum(buildPerpState(inSeq))
		.txInRedeemerValue(matchedOrdersRedeemer(outSeq))
		.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount as any, collateral.output.address)
		.addOutput({ address: c.validatorAddress, amount: lovelace(c.lockLL) })
		.txOutInlineDatumValue(buildPerpState(outSeq))
		.addOutput({ address: c.walletAddress, amount: lovelace(c.fundLL) })
		.requiredSignerHash(c.operatorVkhHex) // operator ∈ extra_signatories (invariant 5)
		.changeAddress(c.walletAddress)
		.complete() as Promise<CardanoWASM.Transaction>
}

async function presign(p: PrepareContext, c: Ctx, lanes: Lane[]): Promise<Signed[][]> {
	const { config, log } = p
	log(`[presign] ${config.lanes} lanes × ${config.chainLen} = ${config.totalTxs} txs (serial WASM — off the clock)…`)
	const t0 = Date.now()
	const chains: Signed[][] = []
	let done = 0
	for (let l = 0; l < lanes.length; l++) {
		const lane = lanes[l]
		let vIn = lane.validator
		let fIn = lane.funding
		const col = lane.collateral
		const chain: Signed[] = []
		for (let i = 0; i < config.chainLen; i++) {
			const outSeq = (vIn.seq ?? 0) + 1
			const tx = await buildSpend(c, vIn, fIn, col)
			const signed = await c.wallet.signTx(tx.to_hex())
			const txId = Resolver.resolveTxHash(signed)
			chain.push({ signed, txId, lane: l, i, trackKeys: [`${txId}#0`, `${txId}#1`] })
			// chain forward: this tx's outputs are the next spend's inputs (deterministic, no node round-trip).
			vIn = mkValidatorUtxo(c, txId, 0, outSeq)
			fIn = mkFundingUtxo(txId, 1, c.walletAddress, c.fundLL)
			done++
		}
		chains.push(chain)
		if ((l + 1) % 50 === 0 || l + 1 === lanes.length) {
			const rate = done / ((Date.now() - t0) / 1000)
			const etaS = (config.totalTxs - done) / Math.max(rate, 0.1)
			log(`[presign] ${done}/${config.totalTxs} (${rate.toFixed(0)} tx/s, eta ${etaS.toFixed(0)}s)`)
		}
	}
	log(`[presign] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
	return chains
}

// shared per-prepare ctx so meta() can read the derived validator info without re-deriving.
let lastCtx: Ctx | undefined

export const perpState: Testcase = {
	name: 'perp-state',
	description: 'PlutusV3 perp_state script-spend (no-op MatchedOrders, seq bump) — the original r1-spike workload.',
	gate: { metric: 'txvalid', p95Ms: 200, requireZeroInvalid: true },
	async prepare(p) {
		const c = deriveCtx(p)
		lastCtx = c
		p.log(`[perp-state] wallet ${c.walletAddress.slice(0, 20)}… validator ${c.validatorAddress.slice(0, 20)}…`)
		const lanes = await fanout(p, c)
		return presign(p, c, lanes)
	},
	meta() {
		const c = lastCtx
		if (!c) return {}
		return {
			validatorTitle: 'perp_state.perp_state.spend',
			validatorHash: PlutusUtils.validatorToScriptHash({ type: 'PlutusV3', scriptCborHex: c.scriptCborHex }),
			validatorAddress: c.validatorAddress,
			operatorVkh: c.operatorVkhHex,
			note: 'single-node devnet — multi-party confirm latency not captured; in-head exec-unit price = 0'
		}
	}
}
