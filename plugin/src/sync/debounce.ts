/**
 * Per-key debounce: calling `trigger` with the same key resets that key's
 * timer, so `fn` only runs once the key has been quiet for `delayMs`.
 *
 * Uses plain `setTimeout`/`clearTimeout` so tests can drive it with bun's
 * `jest.useFakeTimers()` / `jest.advanceTimersByTime()`.
 */
export class Debouncer<K = string> {
	private readonly timers = new Map<
		K,
		{ handle: ReturnType<typeof setTimeout>; fn: () => void | Promise<void> }
	>();

	constructor(private readonly delayMs: number) {}

	/** (Re)schedule `fn` to run for `key` after the debounce window elapses. */
	trigger(key: K, fn: () => void | Promise<void>): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing.handle);
		}
		const handle = globalThis.setTimeout(() => {
			this.timers.delete(key);
			void fn();
		}, this.delayMs);
		this.timers.set(key, { handle, fn });
	}

	/** Cancel any pending timer for `key` without running its callback. */
	cancel(key: K): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing.handle);
			this.timers.delete(key);
		}
	}

	/** True if `key` has a timer waiting to fire. */
	isPending(key: K): boolean {
		return this.timers.has(key);
	}

	/**
	 * Immediately run every pending callback (as if its quiet period had
	 * already elapsed) and clear their timers. Resolves once all callbacks —
	 * sync or async — have settled, so callers can rely on their side effects
	 * having landed before proceeding (e.g. before a manual sync tick).
	 */
	async flush(): Promise<void> {
		const pending = [...this.timers.values()];
		this.timers.clear();
		await Promise.all(
			pending.map(({ handle, fn }) => {
				globalThis.clearTimeout(handle);
				return Promise.resolve(fn());
			}),
		);
	}
}
