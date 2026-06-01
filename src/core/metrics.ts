/** Latency sample math: percentiles + steady-state windowing. */

export type Sample = { fireTs: number; lat: number }

/** Monotonic clock for all latency math (fire → ack). Immune to NTP/clock-step
 * (Date.now() can jump backwards mid-run) and sub-ms (matters at the low-TPS
 * knee where P95 ~= 5ms). Use Date.now()/ISO only for human timestamps. */
export const nowMs = () => performance.now()

export function pct(sorted: number[], p: number): number {
	if (!sorted.length) return 0
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export type Block = {
	p50: number
	p95: number
	p99: number
	max: number
	/** samples inside the steady window */
	n: number
	/** total samples regardless of window */
	total: number
	/** true when the steady window was empty and we fell back to all samples */
	fellBack: boolean
}

/**
 * Steady-state percentile block: drop the first/last `warmupFrac` of the fire
 * window so warmup + drain tail (txs spanning the whole run) can't dominate P95.
 * Under node saturation almost nothing confirms inside the steady window,
 * leaving lat=[] (which would misreport P95=0 = "perfect"); fall back to ALL
 * samples so the backlogged latency shows, and flag it via `fellBack`.
 */
export function steadyBlock(samples: Sample[], lo: number, hi: number): Block {
	let lat = samples
		.filter(s => s.fireTs >= lo && s.fireTs <= hi)
		.map(s => s.lat)
		.sort((a, b) => a - b)
	const fellBack = lat.length === 0 && samples.length > 0
	if (fellBack) lat = samples.map(s => s.lat).sort((a, b) => a - b)
	return {
		p50: pct(lat, 50),
		p95: pct(lat, 95),
		p99: pct(lat, 99),
		max: lat[lat.length - 1] ?? 0,
		n: lat.length,
		total: samples.length,
		fellBack
	}
}
