/**
 * The generic FIRE + MEASURE loop — the heart of the harness, testcase-agnostic.
 *
 * Given a pre-signed `chains[lane][i]` matrix it fires round-robin column-major
 * (every lane's tx i, then i+1, …) at the target TPS, correlates each tx with
 * its `TxValid` (node applied the state transition) and `SnapshotConfirmed`
 * (settled in a signed snapshot), and records two independent latency series.
 *
 * Open-loop (`inflightMax = 0`): fire at fixed cadence `1000/TPS`, no
 * backpressure ⇒ P95 under saturation is queue-time, not real latency.
 * Closed-loop (`inflightMax = K`): block until a slot frees, so submit-rate
 * self-throttles to confirm-rate (Little's Law: K ~= confirmTps * latency_s)
 * and measured P95 ~= one real confirm cycle. `inflightGate` picks which ack
 * (TxValid or SnapshotConfirmed) frees a slot.
 */
import type { BenchConfig } from './config'
import type { HydraClient } from './hydra'
import type { Signed } from './types'
import { nowMs, type Sample } from './metrics'

export type Stats = {
	submitted: number
	valid: number
	invalid: number
	staleInputRace: number
	confirmed: number
	snapshots: number
	/** newTx → TxValid latency (node validation — matching metric) */
	validSamples: Sample[]
	/** newTx → SnapshotConfirmed latency (settlement metric) */
	samples: Sample[]
	/** absolute local ts of each TxValid arrival (batching-timeline evidence) */
	validArrivals: number[]
	/** node-side `timestamp` paired with local receive ts (node-vs-client disambiguation) */
	validRaw: { nodeTs: number; localTs: number }[]
	/** absolute ts of each SnapshotConfirmed + # tracked txs in it */
	snapArrivals: { ts: number; n: number }[]
	/** sweep mode: fire windows used for per-step arrival bucketing */
	stepWindows: { tps: number; fireStart: number; fireEnd: number; offered: number }[]
	firstFireTs: number
	lastFireTs: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Extract the txId from a TxValid message, tolerating API shape variants. */
function txIdFromValid(msg: any): string | undefined {
	return (
		msg?.transactionId ??
		msg?.transaction?.txId ??
		msg?.transaction?.id ??
		(typeof msg?.transaction === 'string' ? msg.transaction : undefined)
	)
}

/** Pull confirmed txIds out of a SnapshotConfirmed message + the UTxO keys it lists. */
function confirmedFromSnapshot(snap: any): { txIds: Set<string>; utxoKeys: string[] } {
	const txIds = new Set<string>()
	const raw = snap?.confirmedTransactions ?? snap?.confirmed ?? []
	if (Array.isArray(raw))
		for (const c of raw) {
			if (typeof c === 'string') txIds.add(c)
			else if (c?.txId) txIds.add(c.txId)
			else if (c?.id) txIds.add(c.id)
		}
	return { txIds, utxoKeys: Object.keys(snap?.utxo ?? {}) }
}

function emptyStats(): Stats {
	return {
		submitted: 0,
		valid: 0,
		invalid: 0,
		staleInputRace: 0,
		confirmed: 0,
		snapshots: 0,
		validSamples: [],
		samples: [],
		validArrivals: [],
		validRaw: [],
		snapArrivals: [],
		stepWindows: [],
		firstFireTs: 0,
		lastFireTs: 0
	}
}

export async function fireAndMeasure(
	client: HydraClient,
	chains: Signed[][],
	config: BenchConfig
): Promise<Stats> {
	const { tps, inflightMax, inflightGate, graceMs, gateMs } = config
	const stats = emptyStats()

	// round-robin fire order: column i across every lane, then i+1 … (lane revisited every #lanes fires).
	const maxLen = chains.reduce((m, c) => Math.max(m, c.length), 0)
	const order: Signed[] = []
	for (let i = 0; i < maxLen; i++) for (let l = 0; l < chains.length; l++) if (chains[l][i]) order.push(chains[l][i])

	const fireTs = new Map<string, number>()
	const pendingTx = new Set<string>()
	const validatedTx = new Set<string>()
	const keyToTx = new Map<string, string>() // tracked output key → txId (utxo fallback)

	let inflight = 0
	const inflightTxs = new Set<string>()
	const releaseSlot = (txId: string) => {
		if (inflightTxs.delete(txId)) inflight--
	}

	const recordConfirm = (txId: string, now: number) => {
		if (!pendingTx.has(txId)) return
		const sent = fireTs.get(txId)
		if (sent !== undefined) {
			stats.samples.push({ fireTs: sent, lat: now - sent })
			stats.confirmed++
		}
		pendingTx.delete(txId)
		if (inflightGate === 'snapshot') releaseSlot(txId)
	}

	client.onMessage((msg: any) => {
		const tag = msg?.tag
		if (tag === 'TxValid') {
			stats.valid++
			const localTs = nowMs()
			stats.validArrivals.push(localTs)
			const nodeTs = msg?.timestamp ? Date.parse(msg.timestamp) : NaN
			if (!Number.isNaN(nodeTs)) stats.validRaw.push({ nodeTs, localTs })
			const id = txIdFromValid(msg)
			const sent = id ? fireTs.get(id) : undefined
			if (id && sent !== undefined && !validatedTx.has(id)) {
				validatedTx.add(id)
				stats.validSamples.push({ fireTs: sent, lat: nowMs() - sent })
			}
			if (inflightGate === 'txvalid' && id) releaseSlot(id)
			return
		}
		if (tag === 'TxInvalid') {
			// A stale-input race != a logic reject. BadInputsUTxO / unknown-input means we fired a chained
			// successor before its predecessor was applied (rig TIMING under load), NOT the validator
			// rejecting. Counting it as `invalid` would falsely fail the gate. Bucket separately.
			const errStr = JSON.stringify(msg?.validationError ?? msg)
			const id = txIdFromValid(msg)
			const isStaleInput = /BadInputsUTxO|UnknownTxIn|unknown input|badInputs|MissingTxIn|UnknownInput/i.test(errStr)
			if (isStaleInput) {
				stats.staleInputRace++
				if (stats.staleInputRace <= 5) console.warn('[fire] stale-input race (rig timing, not a logic reject):', errStr.slice(0, 200))
			} else {
				stats.invalid++
				if (stats.invalid <= 5) console.warn('[fire] TxInvalid (logic reject):', errStr.slice(0, 240))
			}
			if (id) releaseSlot(id)
			return
		}
		if (tag === 'SnapshotConfirmed') {
			stats.snapshots++
			const snap = msg?.snapshot ?? {}
			const now = nowMs()
			const before = stats.confirmed
			const { txIds, utxoKeys } = confirmedFromSnapshot(snap)
			for (const id of txIds) recordConfirm(id, now)
			// fallback: a tracked output still present in the UTxO set ⇒ its tx confirmed.
			for (const key of utxoKeys) {
				const id = keyToTx.get(key)
				if (id) recordConfirm(id, now)
			}
			stats.snapArrivals.push({ ts: now, n: stats.confirmed - before })
		}
	})

	const isSweep = config.sweepSteps.length > 1
	const schedule = isSweep
		? config.sweepSteps.map(stepTps => ({ tps: stepTps, count: Math.round(stepTps * config.stepS) }))
		: [{ tps, count: order.length }]
	const mode = inflightMax > 0 ? `closed-loop (in-flight ≤ ${inflightMax}, freed on ${inflightGate})` : 'open-loop'
	console.log(
		isSweep
			? `[fire] SWEEP ${mode} · steps ${schedule.map(s => `${s.tps}tps×${s.count}`).join(' → ')} · pool ${order.length} txs`
			: `[fire] ${mode} · ${tps} TPS · ${order.length} txs · interval ${(1000 / tps).toFixed(2)}ms · gate P95 ≤ ${gateMs}ms`
	)
	const startAt = nowMs()
	let k = 0
	for (const step of schedule) {
		const intervalMs = 1000 / step.tps
		const stepFireStart = nowMs()
		let stepOffered = 0
		const end = Math.min(order.length, k + step.count)
		for (; k < end; k++) {
			// closed-loop backpressure: block until a slot frees. await sleep() yields to the event loop ⇒
			// ack handlers run and call releaseSlot. No-op when inflightMax = 0 (open-loop / sweep).
			if (inflightMax > 0) while (inflight >= inflightMax) await sleep(2)
			const slotStart = nowMs()
			const item = order[k]
			const now = nowMs()
			fireTs.set(item.txId, now)
			pendingTx.add(item.txId)
			for (const key of item.trackKeys ?? []) keyToTx.set(key, item.txId)
			if (inflightMax > 0) {
				inflightTxs.add(item.txId)
				inflight++
			}
			if (!stats.firstFireTs) stats.firstFireTs = now
			stats.lastFireTs = now
			stats.submitted++
			stepOffered++
			client.newTx(item.signed)
			if (stepOffered % step.tps === 0)
				console.log(
					`[fire] ${step.tps}tps t=${((nowMs() - startAt) / 1000).toFixed(0)}s offered=${stats.submitted} valid=${stats.valid} confirmed=${stats.confirmed} invalid=${stats.invalid} stale=${stats.staleInputRace} inflight=${inflight} snaps=${stats.snapshots}`
				)
			const drift = nowMs() - slotStart
			if (drift < intervalMs) await sleep(intervalMs - drift)
		}
		stats.stepWindows.push({ tps: step.tps, fireStart: stepFireStart, fireEnd: nowMs(), offered: stepOffered })
		if (isSweep)
			console.log(
				`[sweep] step ${step.tps} TPS: offered=${stepOffered} cumValid=${stats.valid} cumConfirmed=${stats.confirmed} stale=${stats.staleInputRace} invalid=${stats.invalid}`
			)
	}

	console.log(`[fire] submit window closed; draining up to ${graceMs / 1000}s…`)
	const drainEnd = Date.now() + graceMs
	while (Date.now() < drainEnd && pendingTx.size > 0) await sleep(250)
	return stats
}
