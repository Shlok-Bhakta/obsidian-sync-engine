/**
 * Per-key debounce: calling `trigger` with the same key resets that key's
 * timer, so `fn` only runs once the key has been quiet for `delayMs`.
 *
 * Uses plain `setTimeout`/`clearTimeout` so tests can drive it with bun's
 * `jest.useFakeTimers()` / `jest.advanceTimersByTime()`.
 */
export class Debouncer<K = string> {
	private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();

	constructor(private readonly delayMs: number) {}

	/** (Re)schedule `fn` to run for `key` after the debounce window elapses. */
	trigger(key: K, fn: () => void): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing);
		}
		const handle = globalThis.setTimeout(() => {
			this.timers.delete(key);
			fn();
		}, this.delayMs);
		this.timers.set(key, handle);
	}

	/** Cancel any pending timer for `key` without running its callback. */
	cancel(key: K): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing);
			this.timers.delete(key);
		}
	}

	/** True if `key` has a timer waiting to fire. */
	isPending(key: K): boolean {
		return this.timers.has(key);
	}
}
