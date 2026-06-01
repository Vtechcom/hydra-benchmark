/**
 * Turns a `Stats` run into the gate decision + artifacts:
 *   results/<testcase>/summary.json          machine-readable
 *   results/<testcase>/report.generated.md    human report
 *   results/<testcase>/arrivals.csv           ack-cadence timeline
 *   results/<testcase>/node-vs-client.csv      node-emit vs client-recv gaps
 *
 * Gate logic (testcase-agnostic): PASS ⟺ steady-state P95 of the gated metric
 * ≤ threshold, AND (if required) 0 logic-reject invalids, AND the node is not
 * saturated, AND real steady samples exist. Two latencies are always reported —
 * TxValid (matching) and SnapshotConfirmed (settlement) — regardless of which
 * one gates, because they mean different things (see docs/interpreting-results).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BenchConfig } from './config'
import type { GateSpec } from './types'
import type { Stats } from './runner'
import { pct, steadyBlock } from './metrics'

export type ReportInput = {
	testcaseName: string
	testcaseDescription: string
	gate: GateSpec
	config: BenchConfig
	stats: Stats
	meta: Record<string, unknown>
	outDir: string
}

export type ReportResult = { pass: boolean; summary: Record<string, unknown> }

export function writeReport(input: ReportInput): ReportResult {
	const { testcaseName, testcaseDescription, gate, config, stats, meta, outDir } = input
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
		decision,
		gatedOn: gate.metric,
		mode: config.independent ? 'independent' : 'chained',
		loop: config.inflightMax > 0 ? `closed-loop(${config.inflightMax},${config.inflightGate})` : 'open-loop',
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
		head: { ws: config.ws, http: config.http },
		timestamp: new Date().toISOString()
	}

	mkdirSync(outDir, { recursive: true })
	writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

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

	writeFileSync(resolve(outDir, 'report.generated.md'), renderMarkdown({ testcaseName, testcaseDescription, gate, gateMs, config, stats, summary, tv, sc, pass, decision, meta }))

	console.log(
		`\n${decision} [${summary.loop}] — ${gate.metric} steady P95=${gated.p95}ms (gate ${gateMs}ms) | TxValid P95=${tv.p95}ms snapshot P95=${sc.p95}ms | offered ${summary.offeredTps} / valid ${summary.validTps} / confirm ${summary.confirmTps} TPS | invalid=${stats.invalid} stale=${stats.staleInputRace}`
	)
	console.log(`report → ${resolve(outDir, 'report.generated.md')}`)
	console.log(`summary → ${resolve(outDir, 'summary.json')}`)
	return { pass, summary }
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
}): string {
	const { testcaseName, testcaseDescription, gate, gateMs, config, stats, summary, tv, sc, pass, decision, meta } = p
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
  pnpm bench --testcase ${testcaseName}            # this run (${config.tps} TPS × ${config.durationS}s, ${config.totalTxs} txs)
\`\`\`

Machine-readable summary: \`results/${testcaseName}/summary.json\`.
`
}
