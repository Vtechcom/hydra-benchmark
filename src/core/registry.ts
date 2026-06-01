/** Global testcase registry. Testcases call `register()` at import time. */
import type { Testcase } from './types'

const registry = new Map<string, Testcase>()

export function register(tc: Testcase): void {
	if (registry.has(tc.name)) throw new Error(`duplicate testcase name: ${tc.name}`)
	registry.set(tc.name, tc)
}

export function getTestcase(name: string): Testcase | undefined {
	return registry.get(name)
}

export function listTestcases(): Testcase[] {
	return [...registry.values()]
}
