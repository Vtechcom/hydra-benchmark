/**
 * Run configuration: resolved once from CLI argv + environment, then passed
 * (read-only) to the testcase and the runner. Testcases may read extra,
 * testcase-specific knobs straight from `config.env` via the `envNum`/`envStr`
 * helpers exported here.
 */

import dotenv from 'dotenv'

dotenv.config()

const DEFAULT_MNEMONIC =
	'amount half silver digital green goose loan face blanket slow proof proof unlock pride web drink youth spin state tiny napkin egg slice exhaust'

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

export type BenchConfig = {
	testcase: string
	smoke: boolean
	/** every tx spends its own seed (chain length pinned to 1) — isolates raw single-tx latency */
	independent: boolean
	tps: number
	durationS: number
	lanes: number
	chainLen: number
	totalTxs: number
	warmupFrac: number
	/** gate P95 threshold (ms); overrides the testcase default when set on the CLI/env */
	gateMs: number
	inflightMax: number
	inflightGate: InflightGate
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
	list: boolean
	help: boolean
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { smoke: false, independent: false, list: false, help: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--smoke') args.smoke = true
		else if (a === '--independent') args.independent = true
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
	const tps = envNum(env, ['BENCH_TPS', 'R1_TPS'], 20)
	const durationS = envNum(env, ['BENCH_DURATION_S', 'R1_DURATION_S'], 6)

	const lanes = envNum(
		env,
		['BENCH_LANES', 'R1_LANES'],
		independent ? Math.max(tps * durationS, 100) : 40
	)
	const chainLen = independent
		? 1
		: envNum(env, ['BENCH_CHAIN', 'R1_CHAIN'], Math.max(1, Math.ceil((tps * durationS) / lanes)))

	return {
		testcase: args.testcase ?? 'perp-state',
		smoke,
		independent,
		tps,
		durationS,
		lanes,
		chainLen,
		totalTxs: lanes * chainLen,
		warmupFrac: envNum(env, ['BENCH_WARMUP_FRAC', 'R1_WARMUP_FRAC'], 0.2),
		gateMs: envNum(env, ['BENCH_GATE_MS', 'R1_GATE_MS'], 200),
		inflightMax: envNum(env, ['BENCH_INFLIGHT_MAX', 'R1_INFLIGHT_MAX'], 0),
		inflightGate: envStr(env, ['BENCH_INFLIGHT_GATE', 'R1_INFLIGHT_GATE'], 'txvalid') as InflightGate,
		graceMs: envNum(env, ['BENCH_GRACE_MS', 'R1_GRACE_MS'], 20_000),
		ws: envStr(env, ['HYDRA_WS'], 'ws://localhost:4001'),
		http: envStr(env, ['HYDRA_HTTP'], 'http://localhost:4001'),
		outDir: envStr(env, ['BENCH_OUT_DIR'], ''),
		mnemonic: envStr(env, ['BENCH_MNEMONIC', 'R1_MNEMONIC'], DEFAULT_MNEMONIC).split(' '),
		env
	}
}
