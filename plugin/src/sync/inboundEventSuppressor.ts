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
}
