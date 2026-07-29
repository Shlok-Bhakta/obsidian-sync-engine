export type InboundOperation = "put" | "delete";

/** Tracks only the exact Vault event expected from an inbound mutation. */
export class InboundEventSuppressor {
	private readonly expected = new Map<string, InboundOperation>();

	expect(path: string, operation: InboundOperation): void {
		this.expected.set(path, operation);
	}

	consume(path: string, operation: InboundOperation): boolean {
		if (this.expected.get(path) !== operation) return false;
		this.expected.delete(path);
		return true;
	}

	cancel(path: string, operation: InboundOperation): void {
		if (this.expected.get(path) === operation) {
			this.expected.delete(path);
		}
	}
}
