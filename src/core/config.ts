/**
 * Run configuration: resolved once from CLI argv + environment, then passed
 * (read-only) to the testcase and the runner. Testcases may read extra,
 * testcase-specific knobs straight from `config.env` via the `envNum`/`envStr`
 * helpers exported here.
 */

import dotenv from 'dotenv'

dotenv.config()

const DEFAULT_MNEMONIC =
	'aim betray remove party capable tiny model fashion relax room august always melody eye diamond cinnamon mother advice blanket earn garden copy empower symptom'

/** First non-empty env var among `keys`, else `def`. */
export function firstEnv(env: NodeJS.ProcessEnv, keys: string[], def: string): string {
	for (const k of keys) {
		const v = env[k]
		if (v !== undefined && v !== '') return v
	}
	return def
}

export function envNum(env: NodeJS.ProcessEnv, keys: string[], def: number): number {
	const v = firstEnv(env, keys, '')
	return v === '' ? def : Number(v)
}

export function envStr(env: NodeJS.ProcessEnv, keys: string[], def: string): string {
	return firstEnv(env, keys, def)
}

export type InflightGate = 'txvalid' | 'snapshot'

/** K sweep for `--latency`: doubling from serial (K=1) upward. */
const DEFAULT_K_STEPS = [1, 2, 4, 8, 16, 32, 64, 128]

export type BenchConfig = {
	testcase: string
	smoke: boolean
	/** every tx spends its own seed (chain length pinned to 1) — isolates raw single-tx latency */
	independent: boolean
	/** multi-step throughput-knee sweep; open-loop by design */
	sweepSteps: number[]
	stepS: number
	tps: number
	durationS: number
	lanes: number
	chainLen: number
	totalTxs: number
	warmupFrac: number
	/** gate P95 threshold (ms); overrides the testcase default when set on the CLI/env */
	gateMs: number
	/** in-flight bound K; 0 = open-loop. Meaningless while `inflightAuto` is set — the runner calibrates it. */
	inflightMax: number
	/** K was not pinned: calibrate it from a warm-up burst so P95 measures service time, not queue time. */
	inflightAuto: boolean
	/** Little's-Law target the auto-calibrator aims at (ms). */
	targetLatencyMs: number
	inflightGate: InflightGate
	/** `--latency`: sweep K instead of a single run — service-time floor at K=1, then the queueing knee. */
	latency: boolean
	kSteps: number[]
	kStepTxs: number
	graceMs: number
	ws: string
	http: string
	outDir: string
	mnemonic: string[]
	/** raw environment, for testcase-specific knobs */
	env: NodeJS.ProcessEnv
}

export type CliArgs = {
	testcase?: string
	smoke: boolean
	independent: boolean
	openLoop: boolean
	latency: boolean
	list: boolean
	help: boolean
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { smoke: false, independent: false, openLoop: false, latency: false, list: false, help: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--smoke') args.smoke = true
		else if (a === '--independent') args.independent = true
		else if (a === '--open-loop') args.openLoop = true
		else if (a === '--latency') args.latency = true
		else if (a === '--list') args.list = true
		else if (a === '--help' || a === '-h') args.help = true
		else if (a === '--testcase' || a === '-t') args.testcase = argv[++i]
		else if (!a.startsWith('-') && !args.testcase) args.testcase = a // positional testcase name
	}
	return args
}

/**
 * Build the resolved config. `lanes`/`chainLen` follow the r1-spike sizing rule
 * by default: lanes >= TPS (so a lane is revisited only every LANES/TPS >= 1s),
 * and chain length auto-sized so LANES*CHAIN ~= TPS*DURATION. In `--independent`
 * mode chain length is pinned to 1 and total tx = lanes.
 */
export function resolveConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): BenchConfig {
	const smoke = args.smoke
	const independent = args.independent
	const sweepSteps = firstEnv(env, ['BENCH_SWEEP', 'R1_SWEEP'], '')
		.split(',')
		.map(s => Number(s.trim()))
		.filter(n => n > 0)
	const isSweep = sweepSteps.length > 1
	const stepS = envNum(env, ['BENCH_STEP_S', 'R1_STEP_S'], 12)
	const maxSweepTps = isSweep ? Math.max(...sweepSteps) : 0
	const sweepTotal = isSweep ? sweepSteps.reduce((a, t) => a + Math.round(t * stepS), 0) : 0

	const tps = envNum(env, ['BENCH_TPS', 'R1_TPS'], smoke ? 20 : 200)
	const durationS = envNum(env, ['BENCH_DURATION_S', 'R1_DURATION_S'], smoke ? 6 : 60)

	const latency = args.latency && !isSweep
	const kSteps = firstEnv(env, ['BENCH_K_SWEEP'], '')
		.split(',')
		.map(s => Number(s.trim()))
		.filter(n => n >= 1)
	const kStepTxs = envNum(env, ['BENCH_K_STEP_TXS'], smoke ? 60 : 200)
	const kStepsResolved = latency ? (kSteps.length ? kSteps : DEFAULT_K_STEPS) : []

	/**
	 * Loop mode. Closed-loop is the DEFAULT because open-loop percentiles under
	 * saturation are queue time, not service time — the number people actually
	 * want. `--open-loop` (or an explicit `BENCH_INFLIGHT_MAX=0`) opts back in,
	 * and a TPS sweep is open-loop by construction since it deliberately drives
	 * the node past its knee.
	 */
	const inflightRaw = firstEnv(env, ['BENCH_INFLIGHT_MAX', 'R1_INFLIGHT_MAX'], 'auto').trim()
	const explicitOpenLoop = args.openLoop || inflightRaw === '0'
	const inflightAuto = !isSweep && !latency && !explicitOpenLoop && (inflightRaw === '' || inflightRaw.toLowerCase() === 'auto')
	const inflightMax = isSweep || latency || explicitOpenLoop || inflightAuto ? 0 : Number(inflightRaw)

	const lanes = envNum(
		env,
		['BENCH_LANES', 'R1_LANES'],
		isSweep
			? Math.max(maxSweepTps * 2, 400)
			: independent
				? smoke
					? 100
					: Math.max(tps * durationS, 200)
				: smoke
					? 40
					: 400
	)
	// A K sweep needs kStepTxs transactions per step and nothing else — the pool
	// is sized by the sweep, not by TPS × duration (there is no target rate).
	const latencyTotal = kStepsResolved.length * kStepTxs
	const chainLen = latency
		? Math.max(1, Math.ceil(latencyTotal / lanes))
		: isSweep
			? Math.max(1, Math.ceil(sweepTotal / lanes))
			: independent
				? 1
				: envNum(env, ['BENCH_CHAIN', 'R1_CHAIN'], Math.max(1, Math.ceil((tps * durationS) / lanes)))

	return {
		testcase: args.testcase ?? 'perp-state',
		smoke,
		independent,
		sweepSteps,
		stepS,
		tps,
		durationS,
		lanes,
		chainLen,
		totalTxs: lanes * chainLen,
		warmupFrac: envNum(env, ['BENCH_WARMUP_FRAC', 'R1_WARMUP_FRAC'], 0.2),
		gateMs: envNum(env, ['BENCH_GATE_MS', 'R1_GATE_MS'], 200),
		inflightMax,
		inflightAuto,
		targetLatencyMs: envNum(env, ['BENCH_TARGET_LATENCY_MS'], envNum(env, ['BENCH_GATE_MS', 'R1_GATE_MS'], 200)),
		inflightGate: envStr(env, ['BENCH_INFLIGHT_GATE', 'R1_INFLIGHT_GATE'], 'txvalid') as InflightGate,
		latency,
		kSteps: kStepsResolved,
		kStepTxs,
		graceMs: envNum(env, ['BENCH_GRACE_MS', 'R1_GRACE_MS'], 20_000),
		ws: envStr(env, ['HYDRA_WS'], 'ws://localhost:4003'),
		http: envStr(env, ['HYDRA_HTTP'], 'http://localhost:4003'),
		outDir: envStr(env, ['BENCH_OUT_DIR'], ''),
		mnemonic: envStr(env, ['BENCH_MNEMONIC', 'R1_MNEMONIC'], DEFAULT_MNEMONIC).split(' '),
		env
	}
}
