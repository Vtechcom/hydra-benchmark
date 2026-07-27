/**
 * Benchmark CLI entrypoint.
 *
 *   pnpm bench --testcase perp-state            # full run
 *   pnpm bench --testcase perp-state --smoke    # quick sanity
 *   pnpm bench --testcase perp-state --independent
 *   pnpm bench --list                           # list registered testcases
 *
 * Env knobs: see .env.example (BENCH_TPS, BENCH_DURATION_S, BENCH_LANES,
 * BENCH_CHAIN, BENCH_SWEEP, BENCH_STEP_S, BENCH_INFLIGHT_MAX,
 * BENCH_INFLIGHT_GATE, HYDRA_WS, HYDRA_HTTP, …).
 */
import { parseArgs, resolveConfig } from './core/config'
import { HydraClient } from './core/hydra'
import { resolveRunLocation } from './core/paths'
import { fireAndMeasure } from './core/runner'
import { writeLatencyReport, writeReport, writeSweepReport } from './core/reporter'
import { getTestcase, listTestcases } from './core/registry'
import './testcases/index' // side-effect: registers all testcases
import dotenv from 'dotenv'
dotenv.config()

function printList(): void {
	console.log('Registered testcases:\n')
	for (const tc of listTestcases())
		console.log(`  ${tc.name.padEnd(16)} ${tc.description}\n${' '.repeat(18)}gate: ${tc.gate.metric} P95 ≤ ${tc.gate.p95Ms}ms, requireZeroInvalid=${tc.gate.requireZeroInvalid}`)
	console.log()
}

function printHelp(): void {
	console.log(`hydra-benchmark — extensible Hydra in-head load/latency harness

Usage:
  pnpm bench --testcase <name> [--smoke] [--independent] [--open-loop] [--latency]
  pnpm bench --list

Flags:
  -t, --testcase <name>   testcase to run (default: perp-state)
      --smoke             quick sanity profile (small lanes/TPS/duration)
      --independent       pin chain length to 1 (every tx spends its own seed)
      --open-loop         fire at a fixed rate with no backpressure; percentiles
                          then include queue time (throughput/knee runs only)
      --latency           sweep the in-flight bound K: service time at K=1, then
                          the queueing knee
      --list              list registered testcases and exit
  -h, --help              this help

Closed-loop is the DEFAULT: the in-flight bound is auto-calibrated (Little's Law)
so P50/P95 measure service time, not queue time. Pin it with BENCH_INFLIGHT_MAX=K.

Common env (see .env.example): HYDRA_WS, HYDRA_HTTP, BENCH_TPS, BENCH_DURATION_S,
  BENCH_LANES, BENCH_CHAIN, BENCH_SWEEP, BENCH_STEP_S, BENCH_INFLIGHT_MAX,
  BENCH_INFLIGHT_GATE, BENCH_GATE_MS.`)
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	if (args.help) return printHelp()
	if (args.list) return printList()

	const config = resolveConfig(args)
	const tc = getTestcase(config.testcase)
	if (!tc) {
		console.error(`unknown testcase "${config.testcase}". Run with --list to see options.`)
		process.exit(2)
	}
	const loopMode = config.latency
		? `latency sweep K=${config.kSteps.join(',')} (freed on ${config.inflightGate})`
		: config.inflightAuto
			? `closed-loop(auto K → ${config.targetLatencyMs}ms, ${config.inflightGate})`
			: config.inflightMax > 0
				? `closed-loop(${config.inflightMax},${config.inflightGate})`
				: 'open-loop'
	console.log(
		`hydra-benchmark · testcase=${tc.name} · ${config.smoke ? 'SMOKE' : 'FULL'}${config.independent ? ' INDEPENDENT' : ''}${config.sweepSteps.length > 1 ? ' SWEEP' : ''}` +
			` · ${config.tps} TPS × ${config.durationS}s · ${config.lanes} lanes × ${config.chainLen} = ${config.totalTxs} txs` +
			` · ${loopMode} · WS ${config.ws}`
	)
	const topTps = config.sweepSteps.length > 1 ? Math.max(...config.sweepSteps) : config.tps
	if (config.sweepSteps.length > 1)
		console.log(`[sweep] steps=${config.sweepSteps.join(',')} TPS · ${config.stepS}s each · pool=${config.totalTxs} (${config.lanes}×${config.chainLen})`)
	// Only meaningful open-loop: a closed-loop run self-throttles well below the
	// nominal TPS, so the lane-revisit arithmetic against `tps` would misfire.
	const openLoopRun = !config.latency && !config.inflightAuto && config.inflightMax === 0
	if (openLoopRun && config.lanes < topTps)
		console.warn(`[warn] lanes (${config.lanes}) < top TPS (${topTps}): a lane is revisited every ${(config.lanes / topTps).toFixed(2)}s < 1s — chained predecessor may not be applied yet ⇒ stale-input races. Raise BENCH_LANES.`)

	const client = new HydraClient(config.ws, config.http)
	await client.connect()
	console.log('[ws] connected')

	// The node names its own version in Greetings; results are filed under it so
	// a run can never end up labelled as a version it was not measured on.
	const reportedVersion = await client.nodeVersion()
	if (!reportedVersion)
		console.warn('[warn] node did not report hydraNodeVersion — filing under results/unknown-version/ (set BENCH_OUT_DIR to override)')

	const log = (m: string) => console.log(m)

	try {
		const prepCtx = { config, client, log }
		const chains = await tc.prepare(prepCtx)
		const stats = await fireAndMeasure(client, chains, config)

		// Resolved only now: with auto-calibration the in-flight bound — part of
		// the profile the run belongs to — is not known until the warm-up has run.
		const run = resolveRunLocation(config, tc.name, reportedVersion, stats.effectiveInflightMax)
		console.log(`[run] hydra-node ${run.nodeVersion} · env ${run.env} · ${run.profile} · ${run.runId}`)

		const reportInput = {
			testcaseName: tc.name,
			testcaseDescription: tc.description,
			gate: tc.gate,
			config,
			stats,
			meta: tc.meta ? tc.meta(prepCtx) : {},
			outDir: run.outDir,
			run
		}
		const { pass } = config.latency && config.kSteps.length
			? writeLatencyReport(reportInput)
			: config.sweepSteps.length > 1
				? writeSweepReport(reportInput)
				: writeReport(reportInput)
		await client.disconnect()
		process.exit(pass ? 0 : 1)
	} catch (e) {
		console.error('benchmark error:', e)
		await client.disconnect()
		process.exit(2)
	}
}

main()
