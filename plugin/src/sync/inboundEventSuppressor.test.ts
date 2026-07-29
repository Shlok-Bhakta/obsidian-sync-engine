import { describe, expect, test } from "bun:test";
import { InboundEventSuppressor } from "./inboundEventSuppressor";

describe("InboundEventSuppressor", () => {
	test("consumes only the matching path and operation", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "create");
		expect(suppressor.consume("b.md", "create")).toBe(false);
		expect(suppressor.consume("a.md", "delete")).toBe(false);
		expect(suppressor.consume("a.md", "create")).toBe(true);
		expect(suppressor.consume("a.md", "create")).toBe(false);
	});

	test("cancellation after a failed mutation preserves the next local event", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "create");
		suppressor.cancel("a.md");
		expect(suppressor.consume("a.md", "create")).toBe(false);
	});

	test("tracks both delete event shapes emitted by a Vault removal", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "rename-delete", "delete");
		expect(suppressor.consume("a.md", "rename-delete")).toBe(true);
		expect(suppressor.consume("a.md", "delete")).toBe(true);
		expect(suppressor.consume("a.md", "delete")).toBe(false);
	});
});
