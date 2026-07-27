/**
 * Where a run's artifacts land, and how runs are grouped for comparison.
 *
 *   results/<node-version>/<env>/<testcase>/<profile>/run-NN/…
 *   results/index.csv        one row per run — the cross-version comparison table
 *
 * The point of this layout is that the two things a benchmark result depends on
 * and cannot be recovered from the numbers — WHICH hydra-node and WHICH host —
 * are directory levels, not prose in a report. `<profile>` is the third level
 * because a median is only meaningful across runs of the identical profile, and
 * mixing a 20 TPS smoke into a 200 TPS series silently poisons it.
 *
 * `<node-version>` comes from the node's own Greetings, never from a flag, so a
 * head started with the wrong `--version` still files its results correctly.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BenchConfig } from './config'

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * `2.3.0-ef833d8a07d412a5a58cf1976afd4e81866ac4df` → `2.3.0-ef833d8a`.
 * The commit prefix is kept because master builds share a version number.
 */
export function versionLabel(reported: string | undefined): string {
	if (!reported) return 'unknown-version'
	const m = reported.match(/^([0-9]+\.[0-9]+\.[0-9]+)(?:-([0-9a-f]{6,}))?/)
	if (!m) return safe(reported).slice(0, 40)
	return m[2] ? `${m[1]}-${m[2].slice(0, 8)}` : m[1]
}

/**
 * Which host the node ran on. Explicit `BENCH_ENV` wins; otherwise the head
 * launcher's `infra/state/current.json` (it knows whether it started docker or
 * a native binary); otherwise the local platform, assuming native.
 */
export function envLabel(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	if (env.BENCH_ENV) return safe(env.BENCH_ENV)
	try {
		const cur = JSON.parse(readFileSync(resolve(cwd, 'infra/state/current.json'), 'utf8'))
		if (cur?.env) return safe(String(cur.env))
	} catch {
		/* no head started locally — fall through to platform detection */
	}
	const osNames: Record<string, string> = { darwin: 'macos', linux: 'linux', win32: 'windows' }
	const archNames: Record<string, string> = { arm64: 'arm64', x64: 'x86_64' }
	const os = osNames[process.platform] ?? process.platform
	const arch = archNames[process.arch] ?? process.arch
	return `${os}-${arch}-native`
}

/**
 * The load profile, as a directory name. Runs are only comparable within one.
 *
 * `effectiveInflightMax` is what the runner actually used — with auto-calibration
 * the K is not known until the warm-up has run, and two runs that settled on
 * different K are not the same profile, so the resolved value is what names the
 * directory.
 */
export function profileLabel(config: BenchConfig, effectiveInflightMax?: number): string {
	if (config.latency && config.kSteps.length)
		return `latency-K${config.kSteps[0]}-${config.kSteps[config.kSteps.length - 1]}-${config.kStepTxs}tx-${config.inflightGate}`
	if (config.sweepSteps.length > 1) return `sweep-${config.sweepSteps.join('-')}tps-${config.stepS}s`
	const k = effectiveInflightMax ?? config.inflightMax
	const loop = k > 0 ? `closed${k}-${config.inflightGate}` : 'open'
	const shape = config.independent ? 'independent' : 'chained'
	// tps × durationS still names the pre-signed pool size, which is what makes
	// two closed-loop runs comparable even though the rate itself no longer binds.
	return `${config.tps}tps-${config.durationS}s-${config.lanes}lanes-${shape}-${loop}`
}

/** Next free `run-NN` inside a profile dir (runs accumulate; nothing is overwritten). */
export function nextRunDir(profileDir: string): { dir: string; runId: string } {
	mkdirSync(profileDir, { recursive: true })
	const used = readdirSync(profileDir)
		.map(n => /^run-(\d+)$/.exec(n)?.[1])
		.filter((n): n is string => !!n)
		.map(Number)
	const runId = `run-${String((used.length ? Math.max(...used) : 0) + 1).padStart(2, '0')}`
	return { dir: resolve(profileDir, runId), runId }
}

export type RunLocation = {
	outDir: string
	runId: string
	nodeVersion: string
	nodeVersionRaw: string | undefined
	env: string
	profile: string
	resultsRoot: string
}

/**
 * Resolve the full destination for one run. An explicit `BENCH_OUT_DIR` still
 * wins — one-off experiments should not have to fit the tree.
 */
export function resolveRunLocation(
	config: BenchConfig,
	testcase: string,
	reportedVersion: string | undefined,
	effectiveInflightMax?: number,
	cwd = process.cwd()
): RunLocation {
	const resultsRoot = resolve(cwd, 'results')
	const nodeVersion = versionLabel(reportedVersion)
	const env = envLabel(config.env, cwd)
	const profile = profileLabel(config, effectiveInflightMax)
	if (config.outDir) {
		const outDir = resolve(cwd, config.outDir)
		return { outDir, runId: 'custom', nodeVersion, nodeVersionRaw: reportedVersion, env, profile, resultsRoot }
	}
	const profileDir = resolve(resultsRoot, nodeVersion, env, testcase, profile)
	const { dir, runId } = nextRunDir(profileDir)
	return { outDir: dir, runId, nodeVersion, nodeVersionRaw: reportedVersion, env, profile, resultsRoot }
}

const INDEX_COLUMNS = [
	'timestamp',
	'nodeVersion',
	'env',
	'testcase',
	'profile',
	'runId',
	'decision',
	'offeredTps',
	'validTps',
	'confirmTps',
	'txValidP50',
	'txValidP95',
	'snapshotP50',
	'snapshotP95',
	'avgTxPerSnapshot',
	'invalid',
	'staleInputRace',
	'path'
] as const

/**
 * Append one row per run to `results/index.csv`. This is what makes the tree
 * queryable without walking it — and what `scripts/compare.ts` reads.
 */
export function appendIndexRow(resultsRoot: string, row: Record<string, unknown>): void {
	const file = resolve(resultsRoot, 'index.csv')
	mkdirSync(resultsRoot, { recursive: true })
	if (!existsSync(file)) writeFileSync(file, INDEX_COLUMNS.join(',') + '\n')
	appendFileSync(file, INDEX_COLUMNS.map(c => String(row[c] ?? '')).join(',') + '\n')
}
