/**
 * Compare benchmark runs across hydra-node versions.
 *
 *   pnpm compare                                    # every testcase/profile that has ≥1 run
 *   pnpm compare -t perp-state                      # one testcase
 *   pnpm compare -t perp-state --profile 200tps-30s-40lanes-chained-open
 *   pnpm compare --env macos-arm64-native
 *
 * Reads `results/<version>/<env>/<testcase>/<profile>/run-NN/summary.json` and
 * reports **median + spread** per version — never a single run. A single run of
 * a saturated open-loop head is noise; the published Hydra baselines are single
 * runs and that is exactly the weakness this repo can avoid.
 *
 * Only runs sharing (testcase, profile, env) are ever compared: a version delta
 * is only a version delta if the load and the host are identical.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Summary = Record<string, any>
type Run = { version: string; env: string; testcase: string; profile: string; runId: string; s: Summary }

const RESULTS = resolve(process.cwd(), 'results')

function args(argv: string[]) {
	const out: { testcase?: string; profile?: string; env?: string; paired?: boolean; baseline?: string } = {}
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '-t' || argv[i] === '--testcase') out.testcase = argv[++i]
		else if (argv[i] === '--profile') out.profile = argv[++i]
		else if (argv[i] === '--env') out.env = argv[++i]
		else if (argv[i] === '--paired') out.paired = true
		else if (argv[i] === '--baseline') out.baseline = argv[++i]
	}
	return out
}

const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [])

/** Walk results/<version>/<env>/<testcase>/<profile>/run-NN/summary.json. */
function loadRuns(): Run[] {
	const runs: Run[] = []
	for (const version of dirs(RESULTS))
		for (const env of dirs(resolve(RESULTS, version)))
			for (const testcase of dirs(resolve(RESULTS, version, env)))
				for (const profile of dirs(resolve(RESULTS, version, env, testcase)))
					for (const runId of dirs(resolve(RESULTS, version, env, testcase, profile))) {
						const f = resolve(RESULTS, version, env, testcase, profile, runId, 'summary.json')
						if (!existsSync(f)) continue
						try {
							runs.push({ version, env, testcase, profile, runId, s: JSON.parse(readFileSync(f, 'utf8')) })
						} catch {
							console.warn(`[warn] unreadable summary: ${f}`)
						}
					}
	return runs
}

const median = (xs: number[]): number => {
	const a = [...xs].sort((x, y) => x - y)
	if (!a.length) return NaN
	const m = a.length >> 1
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
const fmt = (n: number) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) : '–')

/** median plus min–max, because n is small and hiding the spread would oversell it. */
function cell(xs: number[]): string {
	if (!xs.length) return '–'
	const m = median(xs)
	if (xs.length === 1) return `${fmt(m)} (n=1)`
	return `${fmt(m)} [${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}] (n=${xs.length})`
}

const METRICS: { label: string; pick: (s: Summary) => number }[] = [
	{ label: 'offered TPS', pick: s => s.offeredTps },
	{ label: 'TxValid TPS', pick: s => s.validTps },
	{ label: 'confirm TPS', pick: s => s.confirmTps },
	{ label: 'TxValid P50 ms', pick: s => s.txValidLatencyMs?.p50 },
	{ label: 'TxValid P95 ms', pick: s => s.txValidLatencyMs?.p95 },
	{ label: 'snapshot P50 ms', pick: s => s.snapshotConfirmLatencyMs?.p50 },
	{ label: 'snapshot P95 ms', pick: s => s.snapshotConfirmLatencyMs?.p95 },
	{ label: 'tx / snapshot', pick: s => s.avgTxPerSnapshot },
	{ label: 'invalid', pick: s => s.invalid },
	{ label: 'stale-input race', pick: s => s.staleInputRace }
]

/**
 * Exact paired permutation test: under the null the two versions are
 * interchangeable, so every one of the 2^n sign-flips of the per-pair
 * differences is equally likely. p = the fraction of them whose mean |Δ| is at
 * least the observed one. No normality assumption, exact for the n we run;
 * beyond 20 pairs it samples instead of enumerating.
 */
function permutationP(diffs: number[]): number {
	const n = diffs.length
	const obs = Math.abs(diffs.reduce((a, b) => a + b, 0) / n)
	if (n === 0) return 1
	if (n <= 20) {
		let hits = 0
		for (let mask = 0; mask < 1 << n; mask++) {
			let sum = 0
			for (let i = 0; i < n; i++) sum += (mask & (1 << i) ? -1 : 1) * diffs[i]
			if (Math.abs(sum / n) >= obs - 1e-12) hits++
		}
		return hits / 2 ** n
	}
	const TRIALS = 200_000
	let hits = 0
	for (let t = 0; t < TRIALS; t++) {
		let sum = 0
		for (let i = 0; i < n; i++) sum += (Math.random() < 0.5 ? -1 : 1) * diffs[i]
		if (Math.abs(sum / n) >= obs - 1e-12) hits++
	}
	return hits / TRIALS
}

/**
 * Paired comparison of two versions within one group.
 *
 * Runs are expected to have been fired **interleaved** (A, B, A, B, …): pairing
 * each run with its neighbour from the other version cancels machine drift,
 * which otherwise lands entirely on the version axis. Min–max ranges can overlap
 * while the pairwise difference is consistent and real — that is exactly the case
 * this mode exists to resolve.
 */
function pairedReport(group: Run[], versions: string[], baseline: string | undefined, key: string): void {
	if (versions.length !== 2) {
		console.log(`> --paired needs exactly 2 versions in a group; ${key} has ${versions.length}.\n`)
		return
	}
	const [a, b] = versions
	const base = baseline && versions.includes(baseline) ? baseline : a
	const other = base === a ? b : a
	const ordered = [...group].sort((x, y) => String(x.s.timestamp).localeCompare(String(y.s.timestamp)))

	const pairs: { old: Summary; new: Summary }[] = []
	for (let i = 0; i < ordered.length - 1; ) {
		const [p, q] = [ordered[i], ordered[i + 1]]
		if (p.version !== q.version) {
			pairs.push({ old: (p.version === base ? p : q).s, new: (p.version === base ? q : p).s })
			i += 2
		} else i += 1
	}
	if (!pairs.length) {
		console.log('> no adjacent runs of differing versions — were the runs interleaved?\n')
		return
	}

	const METRIC_KEYS: { label: string; pick: (s: Summary) => number; better: 'higher' | 'lower' }[] = [
		{ label: 'confirm TPS', pick: s => s.confirmTps, better: 'higher' },
		{ label: 'TxValid P50 ms', pick: s => s.txValidLatencyMs?.p50, better: 'lower' },
		{ label: 'TxValid P95 ms', pick: s => s.txValidLatencyMs?.p95, better: 'lower' },
		{ label: 'snapshot P50 ms', pick: s => s.snapshotConfirmLatencyMs?.p50, better: 'lower' },
		{ label: 'snapshot P95 ms', pick: s => s.snapshotConfirmLatencyMs?.p95, better: 'lower' }
	]

	console.log(`paired: ${base} → ${other} · ${pairs.length} pairs\n`)
	const head = ['metric', 'Δ', 'Δ%', `${other} better`, 'p (exact)']
	const rows = METRIC_KEYS.map(m => {
		const diffs = pairs.map(p => m.pick(p.new) - m.pick(p.old)).filter(Number.isFinite)
		if (!diffs.length) return [m.label, '–', '–', '–', '–']
		const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length
		const baseMean = pairs.map(p => m.pick(p.old)).reduce((x, y) => x + y, 0) / pairs.length
		const wins = diffs.filter(d => (m.better === 'higher' ? d > 0 : d < 0)).length
		const p = permutationP(diffs)
		return [m.label, `${mean >= 0 ? '+' : ''}${fmt(mean)}`, `${mean >= 0 ? '+' : ''}${((mean / baseMean) * 100).toFixed(1)}%`, `${wins}/${diffs.length}`, `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`]
	})
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
	const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
	console.log(line(head))
	console.log('|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|')
	for (const r of rows) console.log(line(r))
	console.log(`\n> \`*\` = p < 0.05. Smallest p reachable with ${pairs.length} pairs is ${(2 / 2 ** pairs.length).toFixed(4)} — read a null result as "underpowered" if that floor is near 0.05.`)
}

function main(): void {
	const a = args(process.argv.slice(2))
	// Sweep and latency runs report a curve, not one operating point — they have
	// their own reports and would show up here as a table of blanks.
	let runs = loadRuns().filter(r => r.s.kind !== 'sweep' && r.s.kind !== 'latency')
	if (a.testcase) runs = runs.filter(r => r.testcase === a.testcase)
	if (a.profile) runs = runs.filter(r => r.profile === a.profile)
	if (a.env) runs = runs.filter(r => r.env === a.env)

	if (!runs.length) {
		console.log('no runs found under results/ matching that filter.')
		return
	}

	// One comparison table per (testcase, profile, env) — the only grouping in
	// which a version-to-version difference means anything.
	const groups = new Map<string, Run[]>()
	for (const r of runs) {
		const k = `${r.testcase} ${r.profile} ${r.env}`
		groups.set(k, [...(groups.get(k) ?? []), r])
	}

	for (const [key, group] of [...groups.entries()].sort()) {
		const [testcase, profile, env] = key.split(' ')
		const versions = [...new Set(group.map(r => r.version))].sort()

		console.log(`\n## ${testcase} · ${profile} · ${env}\n`)
		if (versions.length === 1)
			console.log(`> only hydra-node ${versions[0]} has runs here — nothing to compare against yet.\n`)

		const head = ['metric', ...versions]
		const rows = METRICS.map(m => [
			m.label,
			...versions.map(v =>
				cell(
					group
						.filter(r => r.version === v)
						.map(r => m.pick(r.s))
						.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
				)
			)
		])
		const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
		const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
		console.log(line(head))
		console.log('|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|')
		for (const r of rows) console.log(line(r))

		const thin = versions.filter(v => group.filter(r => r.version === v).length < 3)
		if (thin.length)
			console.log(`\n> ⚠️ fewer than 3 runs for: ${thin.join(', ')} — medians are not yet trustworthy. Re-run the same profile a few times.`)

		if (a.paired) {
			console.log()
			pairedReport(group, versions, a.baseline, key)
		}
	}
	console.log()
}

main()
