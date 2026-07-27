/**
 * Turns a `Stats` run into the gate decision + artifacts, inside the run dir
 * `results/<node-version>/<env>/<testcase>/<profile>/run-NN/` (see core/paths):
 *   summary.json          machine-readable
 *   report.generated.md   human report
 *   arrivals.csv          ack-cadence timeline
 *   node-vs-client.csv    node-emit vs client-recv gaps
 * plus one appended row in `results/index.csv`.
 *
 * Gate logic (testcase-agnostic): PASS ⟺ steady-state P95 of the gated metric
 * ≤ threshold, AND (if required) 0 logic-reject invalids, AND the node is not
 * saturated, AND real steady samples exist. Two latencies are always reported —
 * TxValid (matching) and SnapshotConfirmed (settlement) — regardless of which
 * one gates, because they mean different things (see docs/interpreting-results).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { relative } from 'node:path'
import type { BenchConfig } from './config'
import type { GateSpec } from './types'
import type { Stats } from './runner'
import { pct, steadyBlock } from './metrics'
import { appendIndexRow, type RunLocation } from './paths'

export type ReportInput = {
	testcaseName: string
	testcaseDescription: string
	gate: GateSpec
	config: BenchConfig
	stats: Stats
	meta: Record<string, unknown>
	outDir: string
	/** which node version / host / profile this run belongs to */
	run: RunLocation
}

/** The run's coordinates, embedded in every summary so a stray file stays self-describing. */
function runStamp(run: RunLocation, config: BenchConfig) {
	return {
		nodeVersion: run.nodeVersion,
		nodeVersionRaw: run.nodeVersionRaw ?? null,
		env: run.env,
		profile: run.profile,
		runId: run.runId,
		head: { ws: config.ws, http: config.http }
	}
}

export type ReportResult = { pass: boolean; summary: Record<string, unknown> }

export function writeReport(input: ReportInput): ReportResult {
	const { testcaseName, testcaseDescription, gate, config, stats, meta, outDir, run } = input
	const gateMs = config.gateMs || gate.p95Ms
	const span = stats.lastFireTs - stats.firstFireTs
	const lo = stats.firstFireTs + config.warmupFrac * span
	const hi = stats.lastFireTs - config.warmupFrac * span

	const tv = steadyBlock(stats.validSamples, lo, hi) // TxValid latency (matching)
	const sc = steadyBlock(stats.samples, lo, hi) // SnapshotConfirmed latency (settlement)
	const gated = gate.metric === 'snapshot' ? sc : tv

	const fireSpanS = Math.max(span / 1000, 1)
	const offeredTps = stats.submitted / fireSpanS
	const validTps = stats.valid / fireSpanS
	const confirmTps = stats.confirmed / fireSpanS
	// Node saturation: it validates far slower than offered ⇒ unbounded backlog, latency meaningless.
	const saturated = stats.valid > 0 && validTps < 0.8 * offeredTps

	const pass =
		gated.n > 0 &&
		!gated.fellBack &&
		!saturated &&
		gated.p95 <= gateMs &&
		(!gate.requireZeroInvalid || stats.invalid === 0)
	const decision = pass ? 'GATE PASS' : 'GATE FAIL'

	// Batching evidence: cluster TxValid arrivals into bursts (gap > 250ms starts a new burst).
	const BURST_GAP_MS = 250
	const arrivals = [...stats.validArrivals].sort((a, b) => a - b)
	const validBursts: { t: number; n: number }[] = []
	for (const t of arrivals) {
		const last = validBursts[validBursts.length - 1]
		if (last && t - last.t <= BURST_GAP_MS) {
			last.n++
			last.t = t
		} else validBursts.push({ t, n: 1 })
	}
	const burstGaps = validBursts.slice(1).map((b, i) => b.t - validBursts[i].t).sort((a, b) => a - b)
	const snapGaps = stats.snapArrivals.slice(1).map((s, i) => s.ts - stats.snapArrivals[i].ts).sort((a, b) => a - b)
	const batching = {
		burstGapMs: BURST_GAP_MS,
		txValidBursts: validBursts.length,
		txValidBurstSize: { p50: pct(validBursts.map(b => b.n).sort((a, b) => a - b), 50), max: Math.max(0, ...validBursts.map(b => b.n)) },
		txValidInterBurstMs: { p50: pct(burstGaps, 50), p95: pct(burstGaps, 95), max: burstGaps[burstGaps.length - 1] ?? 0 },
		snapshotIntervalMs: { p50: pct(snapGaps, 50), p95: pct(snapGaps, 95), max: snapGaps[snapGaps.length - 1] ?? 0 }
	}

	// node-vs-client disambiguation. Gaps are clock-skew-independent. node-ts continuous + local-ts bursty
	// ⇒ WS/client batching artifact; node-ts itself bursty ⇒ node genuinely emits in cycles.
	const raw = [...stats.validRaw].sort((a, b) => a.nodeTs - b.nodeTs)
	const nodeGaps = raw.slice(1).map((r, i) => r.nodeTs - raw[i].nodeTs).sort((a, b) => a - b)
	const localSorted = [...stats.validRaw].map(r => r.localTs).sort((a, b) => a - b)
	const localGaps = localSorted.slice(1).map((t, i) => t - localSorted[i]).sort((a, b) => a - b)
	const nodeVsClient = {
		samples: raw.length,
		nodeEmitGapMs: { p50: pct(nodeGaps, 50), p95: pct(nodeGaps, 95), max: nodeGaps[nodeGaps.length - 1] ?? 0 },
		clientRecvGapMs: { p50: pct(localGaps, 50), p95: pct(localGaps, 95), max: localGaps[localGaps.length - 1] ?? 0 },
		verdict:
			raw.length < 5
				? 'insufficient-samples'
				: pct(nodeGaps, 50) > 400
					? 'node-bursty (node emits in cycles — real)'
					: pct(localGaps, 50) > 400
						? 'client-batched (WS delivers in batches — measurement artifact)'
						: 'both-continuous'
	}

	const summary = {
		testcase: testcaseName,
		...runStamp(run, config),
		decision,
		gatedOn: gate.metric,
		mode: config.independent ? 'independent' : 'chained',
		// The K the runner settled on — with auto-calibration `config.inflightMax`
		// is still 0 here, and reporting that would label a closed-loop run "open-loop".
		loop: stats.effectiveInflightMax > 0 ? `closed-loop(${stats.effectiveInflightMax},${config.inflightGate})` : 'open-loop',
		inflightMax: stats.effectiveInflightMax,
		inflightCalibration: stats.calibration ?? null,
		gateMs,
		targetTps: config.tps,
		durationS: config.durationS,
		lanes: config.lanes,
		chainLen: config.chainLen,
		totalTxs: config.totalTxs,
		warmupFrac: config.warmupFrac,
		submitted: stats.submitted,
		valid: stats.valid,
		invalid: stats.invalid,
		staleInputRace: stats.staleInputRace,
		confirmed: stats.confirmed,
		snapshots: stats.snapshots,
		avgTxPerSnapshot: stats.snapshots ? +(stats.confirmed / stats.snapshots).toFixed(1) : 0,
		offeredTps: +offeredTps.toFixed(1),
		validTps: +validTps.toFixed(1),
		confirmTps: +confirmTps.toFixed(1),
		saturated,
		latencyValid: !gated.fellBack && gated.n > 0,
		txValidLatencyMs: { p50: tv.p50, p95: tv.p95, p99: tv.p99, max: tv.max, steadySamples: tv.n, totalSamples: tv.total },
		snapshotConfirmLatencyMs: { p50: sc.p50, p95: sc.p95, p99: sc.p99, max: sc.max, steadySamples: sc.n, totalSamples: sc.total },
		batching,
		nodeVsClient,
		meta,
		timestamp: new Date().toISOString()
	}

	mkdirSync(outDir, { recursive: true })
	writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
	appendIndexRow(run.resultsRoot, {
		...summary,
		txValidP50: tv.p50,
		txValidP95: tv.p95,
		snapshotP50: sc.p50,
		snapshotP95: sc.p95,
		path: relative(run.resultsRoot, outDir)
	})

	// arrival timeline (ms since first fire)
	const t0 = stats.firstFireTs
	const rows = ['event,ms_since_first_fire,count']
	for (const b of validBursts) rows.push(`txvalid_burst,${(b.t - t0).toFixed(0)},${b.n}`)
	for (const s of stats.snapArrivals) rows.push(`snapshot_confirmed,${(s.ts - t0).toFixed(0)},${s.n}`)
	writeFileSync(resolve(outDir, 'arrivals.csv'), rows.join('\n') + '\n')

	// per-TxValid node-emit vs client-recv timeline (gaps matter; columns share no clock)
	const nt0 = raw.length ? raw[0].nodeTs : 0
	const lt0 = raw.length ? Math.min(...stats.validRaw.map(r => r.localTs)) : 0
	const nvc = ['node_emit_ms,client_recv_ms']
	for (const r of raw) nvc.push(`${(r.nodeTs - nt0).toFixed(0)},${(r.localTs - lt0).toFixed(0)}`)
	writeFileSync(resolve(outDir, 'node-vs-client.csv'), nvc.join('\n') + '\n')

	writeFileSync(resolve(outDir, 'report.generated.md'), renderMarkdown({ testcaseName, testcaseDescription, gate, gateMs, config, stats, summary, tv, sc, pass, decision, meta, summaryRelPath: relative(run.resultsRoot, resolve(outDir, 'summary.json')) }))

	console.log(
		`\n${decision} [${summary.loop}] — ${gate.metric} steady P95=${gated.p95}ms (gate ${gateMs}ms) | TxValid P95=${tv.p95}ms snapshot P95=${sc.p95}ms | offered ${summary.offeredTps} / valid ${summary.validTps} / confirm ${summary.confirmTps} TPS | invalid=${stats.invalid} stale=${stats.staleInputRace}`
	)
	console.log(`report → ${resolve(outDir, 'report.generated.md')}`)
	console.log(`summary → ${resolve(outDir, 'summary.json')}`)
	return { pass, summary }
}

/**
 * `--latency`: percentiles as a function of the in-flight bound K.
 *
 * One number cannot be "the latency". At K=1 the node handles one transaction at
 * a time, so P50/P95 there is **service time** — the work itself, no queueing. As
 * K rises, throughput climbs until the node saturates, after which every extra
 * in-flight transaction only adds waiting. This report gives both ends: the
 * service-time floor, and the knee — the largest K whose P95 still meets the
 * gate, i.e. the deepest pipeline that keeps latency honest.
 */
export function writeLatencyReport(input: ReportInput): ReportResult {
	const { testcaseName, testcaseDescription, gate, config, stats, meta, outDir, run } = input
	const gateMs = config.gateMs || gate.p95Ms
	const inWin = (ts: number, lo: number, hi: number) => ts >= lo && ts <= hi

	const rows = stats.kWindows.map(w => {
		// Bucket by FIRE time: a sample belongs to the K that was in force when it
		// was submitted, not to whichever K happened to be running when it acked.
		const tv = stats.validSamples.filter(s => inWin(s.fireTs, w.fireStart, w.fireEnd)).map(s => s.lat).sort((a, b) => a - b)
		const sc = stats.samples.filter(s => inWin(s.fireTs, w.fireStart, w.fireEnd)).map(s => s.lat).sort((a, b) => a - b)
		const durS = Math.max((w.fireEnd - w.fireStart) / 1000, 0.001)
		return {
			k: w.k,
			offered: w.offered,
			confirmed: sc.length,
			confirmTps: +(sc.length / durS).toFixed(1),
			txValidP50: +pct(tv, 50).toFixed(1),
			txValidP95: +pct(tv, 95).toFixed(1),
			snapshotP50: +pct(sc, 50).toFixed(1),
			snapshotP95: +pct(sc, 95).toFixed(1),
			samples: sc.length
		}
	})

	const gatedP95 = (r: (typeof rows)[number]) => (gate.metric === 'snapshot' ? r.snapshotP95 : r.txValidP95)
	const floor = rows.find(r => r.k === Math.min(...rows.map(x => x.k)))
	const meeting = rows.filter(r => r.samples > 0 && gatedP95(r) <= gateMs)
	const knee = meeting.length ? meeting[meeting.length - 1] : undefined
	const peak = rows.reduce((best, r) => (r.confirmTps > (best?.confirmTps ?? -1) ? r : best), rows[0])

	const summary = {
		testcase: testcaseName,
		kind: 'latency',
		...runStamp(run, config),
		gatedOn: gate.metric,
		gateMs,
		inflightGate: config.inflightGate,
		kSteps: config.kSteps,
		txsPerStep: config.kStepTxs,
		serviceTimeMs: floor ? { k: floor.k, txValidP50: floor.txValidP50, txValidP95: floor.txValidP95, snapshotP50: floor.snapshotP50, snapshotP95: floor.snapshotP95 } : null,
		knee: knee ? { k: knee.k, gatedP95: gatedP95(knee), confirmTps: knee.confirmTps } : null,
		peakConfirmTps: peak ? { k: peak.k, confirmTps: peak.confirmTps, gatedP95: gatedP95(peak) } : null,
		rows,
		meta,
		totalInvalid: stats.invalid,
		totalStaleInputRace: stats.staleInputRace,
		timestamp: new Date().toISOString()
	}

	mkdirSync(outDir, { recursive: true })
	writeFileSync(resolve(outDir, 'latency.json'), JSON.stringify(summary, null, 2))
	writeFileSync(
		resolve(outDir, 'latency-results.csv'),
		[
			'k,offered,confirmed,confirm_tps,txvalid_p50_ms,txvalid_p95_ms,snapshot_p50_ms,snapshot_p95_ms',
			...rows.map(r => `${r.k},${r.offered},${r.confirmed},${r.confirmTps},${r.txValidP50},${r.txValidP95},${r.snapshotP50},${r.snapshotP95}`)
		].join('\n') + '\n'
	)

	const table = [
		'| K (in-flight) | confirm TPS | TxValid P50 | TxValid P95 | snapshot P50 | snapshot P95 | samples |',
		'|---:|---:|---:|---:|---:|---:|---:|',
		...rows.map(r => `| ${r.k} | ${r.confirmTps} | ${r.txValidP50} | ${r.txValidP95} | ${r.snapshotP50} | ${r.snapshotP95} | ${r.samples} |`)
	].join('\n')

	writeFileSync(
		resolve(outDir, 'latency.generated.md'),
		`# ${testcaseName} — service time vs pipeline depth [auto-generated]

> ${testcaseDescription}

**Date:** ${summary.timestamp} · hydra-node ${run.nodeVersion} · env ${run.env}

## Service time (K=1, no queueing)

${floor ? `- TxValid **P50 ${floor.txValidP50}ms · P95 ${floor.txValidP95}ms**\n- SnapshotConfirmed **P50 ${floor.snapshotP50}ms · P95 ${floor.snapshotP95}ms**` : '- no samples at the lowest K'}

This is the work itself: one transaction in flight, nothing waiting behind it. Every larger K adds queueing on top.

## Knee

- Deepest pipeline still meeting the gate (${gate.metric} P95 ≤ ${gateMs}ms): **K = ${knee?.k ?? '—'}**${knee ? ` (P95 ${gatedP95(knee)}ms, ${knee.confirmTps} confirm TPS)` : ' — even K=1 misses the gate'}
- Peak confirm throughput observed: **${peak?.confirmTps ?? 0} TPS** at K=${peak?.k ?? '—'} (${peak ? gatedP95(peak) : '—'}ms P95)
- Logic-reject invalid: ${stats.invalid} · stale-input race: ${stats.staleInputRace}

Past the knee, throughput stops rising while latency keeps climbing — that region is queue time, and any P95 quoted from it describes the backlog, not the node.

## Latency vs K

${table}

## Reproduce

\`\`\`bash
HYDRA_WS=${config.ws} HYDRA_HTTP=${config.http} \\
  BENCH_K_SWEEP="${config.kSteps.join(',')}" BENCH_K_STEP_TXS=${config.kStepTxs} \\
  BENCH_INFLIGHT_GATE=${config.inflightGate} \\
  pnpm bench --testcase ${testcaseName} --latency
\`\`\`

Machine-readable: \`${relative(run.resultsRoot, resolve(outDir, 'latency.json'))}\` (under \`results/\`).
`
	)

	appendIndexRow(run.resultsRoot, {
		...summary,
		decision: `service-p50=${floor?.snapshotP50 ?? '—'}ms knee=K${knee?.k ?? 0}`,
		confirmTps: peak?.confirmTps ?? 0,
		txValidP50: floor?.txValidP50,
		txValidP95: floor?.txValidP95,
		snapshotP50: floor?.snapshotP50,
		snapshotP95: floor?.snapshotP95,
		invalid: stats.invalid,
		staleInputRace: stats.staleInputRace,
		path: relative(run.resultsRoot, outDir)
	})

	console.log(
		`\nSERVICE TIME (K=1) — TxValid P50=${floor?.txValidP50}ms P95=${floor?.txValidP95}ms · snapshot P50=${floor?.snapshotP50}ms P95=${floor?.snapshotP95}ms`
	)
	console.log(`knee: K=${knee?.k ?? '—'} (${gate.metric} P95 ≤ ${gateMs}ms) · peak ${peak?.confirmTps ?? 0} confirm TPS at K=${peak?.k ?? '—'}`)
	console.log(`latency report → ${resolve(outDir, 'latency.generated.md')}`)
	return { pass: !!knee, summary }
}

export function writeSweepReport(input: ReportInput): ReportResult {
	const { testcaseName, testcaseDescription, config, stats, meta, outDir, run } = input
	const trackFrac = 0.8
	const inWin = (ts: number, lo: number, hi: number) => ts >= lo && ts <= hi
	const rows = stats.stepWindows.map(w => {
		const durS = Math.max((w.fireEnd - w.fireStart) / 1000, 0.001)
		const offeredTps = w.offered / durS
		const validInWin = stats.validArrivals.filter(t => inWin(t, w.fireStart, w.fireEnd)).length
		const confInWin = stats.snapArrivals.filter(s => inWin(s.ts, w.fireStart, w.fireEnd)).reduce((a, s) => a + s.n, 0)
		const validTps = validInWin / durS
		const confTps = confInWin / durS
		const track = offeredTps > 0 ? validTps / offeredTps : 0
		return {
			tps: w.tps,
			durS: +durS.toFixed(1),
			offered: w.offered,
			offeredTps: +offeredTps.toFixed(1),
			validTps: +validTps.toFixed(1),
			confTps: +confTps.toFixed(1),
			track: +track.toFixed(2),
			saturated: track < trackFrac
		}
	})

	const tracking = rows.filter(r => !r.saturated)
	const kneeRow = tracking.length ? tracking[tracking.length - 1] : undefined
	const ceiling = Math.max(0, ...rows.map(r => r.validTps))
	const knee = kneeRow ? kneeRow.tps : 0
	const allTracked = rows.every(r => !r.saturated)
	const summary = {
		testcase: testcaseName,
		kind: 'sweep',
		...runStamp(run, config),
		stepSeconds: config.stepS,
		steps: config.sweepSteps,
		lanes: config.lanes,
		chainLen: config.chainLen,
		poolTxs: config.totalTxs,
		kneeTps: knee,
		sustainedCeilingValidTps: +ceiling.toFixed(1),
		allStepsTracked: allTracked,
		note: allTracked
			? `node tracked every offered step up to ${Math.max(...config.sweepSteps)} TPS; raise BENCH_SWEEP to find the true ceiling`
			: `node plateaus around ${ceiling.toFixed(0)} validTps; knee (last tracking step) = ${knee} TPS`,
		rows,
		meta,
		totalInvalid: stats.invalid,
		totalStaleInputRace: stats.staleInputRace,
		timestamp: new Date().toISOString()
	}

	mkdirSync(outDir, { recursive: true })
	writeFileSync(resolve(outDir, 'sweep.json'), JSON.stringify(summary, null, 2))
	appendIndexRow(run.resultsRoot, {
		...summary,
		decision: `knee=${knee}tps`,
		validTps: summary.sustainedCeilingValidTps,
		invalid: stats.invalid,
		staleInputRace: stats.staleInputRace,
		path: relative(run.resultsRoot, outDir)
	})
	writeFileSync(
		resolve(outDir, 'sweep-results.csv'),
		[
			'step_tps,dur_s,offered,offered_tps,valid_tps,confirm_tps,track,saturated',
			...rows.map(r => `${r.tps},${r.durS},${r.offered},${r.offeredTps},${r.validTps},${r.confTps},${r.track},${r.saturated}`)
		].join('\n') + '\n'
	)

	const table = [
		'| Step TPS | dur s | offered | offeredTps | validTps | confTps | track | saturated |',
		'|---|---|---|---|---|---|---|---|',
		...rows.map(
			r =>
				`| ${r.tps} | ${r.durS} | ${r.offered} | ${r.offeredTps} | ${r.validTps} | ${r.confTps} | ${r.track} | ${r.saturated ? 'yes' : 'no'} |`
		)
	].join('\n')

	writeFileSync(
		resolve(outDir, 'sweep.generated.md'),
		`# ${testcaseName} — Hydra in-head throughput sweep [auto-generated]

> ${testcaseDescription}

**Date:** ${summary.timestamp}

## Knee

- Knee (last step still tracking offered >= ${trackFrac}): **${knee} TPS**
- Sustained validated ceiling: **${summary.sustainedCeilingValidTps} TPS**
- ${summary.note}
- Logic-reject invalid: ${stats.invalid}
- Stale-input race (rig timing, excluded from knee): ${stats.staleInputRace}

## Per-step offered-vs-validated

${table}

\`validTps\` = TxValid arrivals bucketed into the step's fire window divided by window seconds. \`track\` = validTps/offeredTps; below ${trackFrac} means the node no longer keeps up with the offered rate.

## Reproduce

\`\`\`bash
HYDRA_WS=${config.ws} HYDRA_HTTP=${config.http} \\
  BENCH_SWEEP="${config.sweepSteps.join(',')}" BENCH_STEP_S=${config.stepS} \\
  pnpm bench --testcase ${testcaseName}
\`\`\`

Machine-readable summary: \`${relative(run.resultsRoot, resolve(outDir, 'sweep.json'))}\` (under \`results/\`).
`
	)

	console.log(`\nSWEEP knee=${knee} TPS · sustained ceiling=${summary.sustainedCeilingValidTps} validTps · ${summary.note}`)
	console.log(`sweep report → ${resolve(outDir, 'sweep.generated.md')}`)
	console.log(`sweep summary → ${resolve(outDir, 'sweep.json')}`)
	return { pass: allTracked, summary }
}

function renderMarkdown(p: {
	testcaseName: string
	testcaseDescription: string
	gate: GateSpec
	gateMs: number
	config: BenchConfig
	stats: Stats
	summary: Record<string, any>
	tv: ReturnType<typeof steadyBlock>
	sc: ReturnType<typeof steadyBlock>
	pass: boolean
	decision: string
	meta: Record<string, unknown>
	/** run dir relative to results/, so the report points at its own artifacts */
	summaryRelPath: string
}): string {
	const { testcaseName, testcaseDescription, gate, gateMs, config, stats, summary, tv, sc, pass, decision, meta, summaryRelPath } = p
	const laneRevisit = (config.lanes / config.tps).toFixed(1)
	const gatedP95 = gate.metric === 'snapshot' ? sc.p95 : tv.p95
	const metaLines = Object.entries(meta)
		.map(([k, v]) => `- **${k}:** \`${typeof v === 'object' ? JSON.stringify(v) : v}\``)
		.join('\n')

	const staleNote =
		stats.staleInputRace > 0
			? `\n> ⚠️ **${stats.staleInputRace} stale-input races** (BadInputsUTxO): a chained successor was fired before its predecessor was applied — a *rig timing* artifact, **not** a validator reject, so it is excluded from the gate. The offered rate outran node apply-latency for the lane revisit interval (${config.lanes}/${config.tps}=${laneRevisit}s). Re-run with \`--independent\` (no intra-lane deps) or \`BENCH_INFLIGHT_MAX=K\` (closed-loop) to remove it.\n`
			: ''

	return `# ${testcaseName} — Hydra in-head benchmark @ ${config.tps} TPS [auto-generated]

> ${testcaseDescription}

**Date:** ${summary.timestamp}

**Decision:** **${decision}** — gated on **${gate.metric}** steady P95 = ${gatedP95}ms vs gate ≤ ${gateMs}ms.

## What was measured

${config.totalTxs} pre-signed txs were fired round-robin across ${config.lanes} independent lanes at a sustained ${config.tps} TPS (${summary.loop}). Signing is off the hot path, so the rig genuinely *offers* the target rate — any remaining ceiling is the node's. Two latencies are correlated per tx: **TxValid** (node validated the state transition locally) and **SnapshotConfirmed** (settled in a signed snapshot).

| Metric | Value |
|---|---|
| Target TPS | ${config.tps} |
| Loop mode | ${summary.loop} |
| Lanes × chain | ${config.lanes} × ${config.chainLen} = ${config.totalTxs} |
| Offered (submit) | ${stats.submitted} @ ${summary.offeredTps} TPS |
| Node-validated (TxValid) | ${stats.valid} @ ${summary.validTps} TPS |
| TxInvalid (logic reject${gate.requireZeroInvalid ? ' — **gated**' : ''}) | ${stats.invalid} |
| Stale-input race (rig timing — **excluded from gate**) | ${stats.staleInputRace} |
| Confirmed (in snapshot) | ${stats.confirmed} @ ${summary.confirmTps} TPS |
| Snapshots observed | ${stats.snapshots} |
| Avg tx / snapshot | ${summary.avgTxPerSnapshot} |
| **TxValid latency (matching) — steady P50/P95/P99/max** | **${tv.p50} / ${tv.p95} / ${tv.p99} / ${tv.max} ms** (n=${tv.n}/${tv.total}) |
| SnapshotConfirmed latency (settlement) — steady P50/P95/P99/max | ${sc.p50} / ${sc.p95} / ${sc.p99} / ${sc.max} ms (n=${sc.n}/${sc.total}) |
| Saturated? | ${summary.saturated} |
| node-vs-client verdict | ${summary.nodeVsClient.verdict} |

Two metrics, two purposes. **TxValid** = node applied the state transition (the right latency for *matching* feasibility). **SnapshotConfirmed** = settled in a multi-party-signed snapshot (the only state safe to fan out / withdraw against). Hydra **batches** snapshots on a cadence, so per-tx SnapshotConfirmed P95 ≤ ${gateMs}ms is *not* an achievable target and must NOT gate matching; it is tracked as a separate settlement-cadence signal. Where the throughputs diverge locates any ceiling: offered ≈ ${config.tps} but validated ≪ ${config.tps} ⇒ node validation is the limit; validated ≈ offered but confirm lags ⇒ snapshot cadence (settlement), not matching.
${staleNote}
> ⚠️ TxValid is **not** finality. On head close/contestation only the latest *confirmed snapshot* survives on L1; a TxValid-but-not-yet-snapshotted tx can be lost. Custody/withdraw/fanout MUST wait for SnapshotConfirmed.

## Testcase metadata

${metaLines || '- _(none)_'}

## Gate decision

${pass
			? `✅ **PASS** — ${gate.metric} steady P95 ${gatedP95}ms ≤ ${gateMs}ms${gate.requireZeroInvalid ? ' with 0 invalid txs' : ''} at ${summary.offeredTps} TPS offered.`
			: `❌ **FAIL** — ${(gate.metric === 'snapshot' ? sc.n : tv.n) === 0 ? 'no steady-state samples captured' : `${gate.metric} steady P95 ${gatedP95}ms > ${gateMs}ms`}${stats.invalid ? ` / ${stats.invalid} invalid txs` : ''}${summary.saturated ? ' / node saturated (validated ≪ offered)' : ''}. Locate the ceiling via offered-vs-validated above.`}

## Reproduce

\`\`\`bash
HYDRA_WS=${config.ws} HYDRA_HTTP=${config.http} \\
  BENCH_TPS=${config.tps} BENCH_DURATION_S=${config.durationS} BENCH_LANES=${config.lanes} \\
  BENCH_INFLIGHT_MAX=${summary.inflightMax || 0} BENCH_INFLIGHT_GATE=${config.inflightGate} \\
  pnpm bench --testcase ${testcaseName}${summary.inflightMax ? '' : ' --open-loop'}   # this run (${config.totalTxs} txs, ${summary.loop})
\`\`\`

Machine-readable summary: \`${summaryRelPath}\` (under \`results/\`).
`
}
