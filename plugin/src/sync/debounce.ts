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

	private readonly logger: Logger;

	constructor(
		private readonly delayMs: number,
		logger: Logger = new NoopLogger(),
	) {
		this.logger = logger.child("debounce");
	}

	/** (Re)schedule `fn` to run for `key` after the debounce window elapses. */
	trigger(key: K, fn: () => void | Promise<void>): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing.handle);
			this.logger.debug("trigger.rescheduled", {
				key: String(key),
				delayMs: this.delayMs,
			});
		} else {
			this.logger.debug("trigger.scheduled", {
				key: String(key),
				delayMs: this.delayMs,
			});
		}
		const handle = globalThis.setTimeout(() => {
			this.timers.delete(key);
			this.logger.debug("timer.fired", { key: String(key) });
			void Promise.resolve(fn()).catch((error) => {
				this.logger.error("timer.callback_failed", {
					key: String(key),
					error,
				});
			});
		}, this.delayMs);
		this.timers.set(key, { handle, fn });
	}

	/** Cancel any pending timer for `key` without running its callback. */
	cancel(key: K): void {
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			globalThis.clearTimeout(existing.handle);
			this.timers.delete(key);
			this.logger.debug("timer.cancelled", { key: String(key) });
		} else {
			this.logger.debug("timer.cancel_skipped", {
				key: String(key),
				reason: "not_pending",
			});
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
		this.logger.debug("flush.started", {
			pendingCallbacks: pending.length,
		});
		this.timers.clear();
		await Promise.all(
			pending.map(({ handle, fn }) => {
				globalThis.clearTimeout(handle);
				return Promise.resolve(fn());
			}),
		);
		this.logger.debug("flush.completed", {
			flushedCallbacks: pending.length,
		});
	}
}
import { NoopLogger, type Logger } from "../logger";
