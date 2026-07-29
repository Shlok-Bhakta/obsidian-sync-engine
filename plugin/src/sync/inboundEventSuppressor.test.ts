import { describe, expect, test } from "bun:test";
import { InboundEventSuppressor } from "./inboundEventSuppressor";

describe("InboundEventSuppressor", () => {
	test("consumes only the matching path and operation", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "put");
		expect(suppressor.consume("b.md", "put")).toBe(false);
		expect(suppressor.consume("a.md", "delete")).toBe(false);
		expect(suppressor.consume("a.md", "put")).toBe(true);
		expect(suppressor.consume("a.md", "put")).toBe(false);
	});

	test("cancellation after a failed mutation preserves the next local event", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "put");
		suppressor.cancel("a.md", "put");
		expect(suppressor.consume("a.md", "put")).toBe(false);
	});

	test("cancelling an older operation cannot erase a newer expectation", () => {
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "delete");
		suppressor.cancel("a.md", "put");
		expect(suppressor.consume("a.md", "delete")).toBe(true);
	});
});
