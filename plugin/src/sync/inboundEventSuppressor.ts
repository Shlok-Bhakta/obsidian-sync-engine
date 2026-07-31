export type InboundEvent =
	| "create"
	| "modify"
	| "delete"
	| "rename-delete";

/** Tracks only the exact Vault event expected from an inbound mutation. */
export class InboundEventSuppressor {
	private readonly expected = new Map<string, Set<InboundEvent>>();

	expect(path: string, ...events: InboundEvent[]): void {
		this.expected.set(path, new Set(events));
	}

	consume(path: string, event: InboundEvent): boolean {
		const events = this.expected.get(path);
		if (!events?.delete(event)) return false;
		if (events.size === 0) this.expected.delete(path);
		return true;
	}

	cancel(path: string): void {
		this.expected.delete(path);
	}

	/**
	 * Vault events may be queued just after the mutation promise resolves.
	 * Keep this exact expectation through the current event batch, then remove
	 * only this generation so a later local action is never suppressed.
	 */
	settle(path: string): void {
		const generation = this.expected.get(path);
		if (!generation) return;
		globalThis.setTimeout(() => {
			if (this.expected.get(path) === generation) {
				this.expected.delete(path);
			}
		}, 0);
	}
}
