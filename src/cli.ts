/**
 * Benchmark CLI entrypoint.
 *
 *   pnpm bench --testcase perp-state            # full run
 *   pnpm bench --testcase perp-state --smoke    # quick sanity
 *   pnpm bench --testcase perp-state --independent
 *   pnpm bench --list                           # list registered testcases
 *
 * Env knobs: see .env.example (BENCH_TPS, BENCH_DURATION_S, BENCH_LANES,
 * BENCH_CHAIN, BENCH_INFLIGHT_MAX, BENCH_INFLIGHT_GATE, HYDRA_WS, HYDRA_HTTP, …).
 */
import { resolve } from 'node:path'
import { parseArgs, resolveConfig } from './core/config'
import { HydraClient } from './core/hydra'
import { fireAndMeasure } from './core/runner'
import { writeReport } from './core/reporter'
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
  pnpm bench --testcase <name> [--smoke] [--independent]
  pnpm bench --list

Flags:
  -t, --testcase <name>   testcase to run (default: perp-state)
      --smoke             quick sanity profile (small lanes/TPS/duration)
      --independent       pin chain length to 1 (every tx spends its own seed)
      --list              list registered testcases and exit
  -h, --help              this help

Common env (see .env.example): HYDRA_WS, HYDRA_HTTP, BENCH_TPS, BENCH_DURATION_S,
  BENCH_LANES, BENCH_CHAIN, BENCH_INFLIGHT_MAX, BENCH_INFLIGHT_GATE, BENCH_GATE_MS.`)
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
	const outDir = config.outDir || resolve(process.cwd(), 'results', tc.name)

	console.log(
		`hydra-benchmark · testcase=${tc.name} · ${config.smoke ? 'SMOKE' : 'FULL'}${config.independent ? ' INDEPENDENT' : ''}` +
			` · ${config.tps} TPS × ${config.durationS}s · ${config.lanes} lanes × ${config.chainLen} = ${config.totalTxs} txs` +
			` · ${config.inflightMax > 0 ? `closed-loop(${config.inflightMax},${config.inflightGate})` : 'open-loop'} · WS ${config.ws}`
	)
	if (config.lanes < config.tps)
		console.warn(`[warn] lanes (${config.lanes}) < TPS (${config.tps}): a lane is revisited every ${(config.lanes / config.tps).toFixed(2)}s < 1s — chained predecessor may not be applied yet ⇒ stale-input races. Raise BENCH_LANES.`)

	const client = new HydraClient(config.ws, config.http)
	await client.connect()
	console.log('[ws] connected')
	const log = (m: string) => console.log(m)

	try {
		const prepCtx = { config, client, log }
		const chains = await tc.prepare(prepCtx)
		const stats = await fireAndMeasure(client, chains, config)
		const { pass } = writeReport({
			testcaseName: tc.name,
			testcaseDescription: tc.description,
			gate: tc.gate,
			config,
			stats,
			meta: tc.meta ? tc.meta(prepCtx) : {},
			outDir
		})
		await client.disconnect()
		process.exit(pass ? 0 : 1)
	} catch (e) {
		console.error('benchmark error:', e)
		await client.disconnect()
		process.exit(2)
	}
}

main()
