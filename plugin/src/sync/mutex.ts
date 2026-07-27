/** A tiny promise-chain mutex: queued callers run one at a time, in FIFO order. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.tail.then(fn, fn);
		// Advance the chain regardless of whether `fn` succeeded or failed, so a
		// rejection never deadlocks later callers.
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

const mutexes = new Map<string, Mutex>();

/** Process-wide mutex keyed by name (e.g. an outbox file path). */
export function mutexFor(key: string): Mutex {
	let mutex = mutexes.get(key);
	if (!mutex) {
		mutex = new Mutex();
		mutexes.set(key, mutex);
	}
	return mutex;
}
