import { describe, expect, jest, test } from "bun:test";
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

	test("unused alternative events are cleared when a mutation settles", () => {
		jest.useFakeTimers();
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "rename-delete", "delete");
		expect(suppressor.consume("a.md", "rename-delete")).toBe(true);
		suppressor.settle("a.md");
		jest.runAllTimers();
		expect(suppressor.consume("a.md", "delete")).toBe(false);
		expect(suppressor.consume("a.md", "delete")).toBe(false);
		jest.useRealTimers();
	});

	test("a queued alternative can still be consumed before settlement", () => {
		jest.useFakeTimers();
		const suppressor = new InboundEventSuppressor();
		suppressor.expect("a.md", "rename-delete", "delete");
		suppressor.settle("a.md");
		expect(suppressor.consume("a.md", "delete")).toBe(true);
		jest.runAllTimers();
		expect(suppressor.consume("a.md", "rename-delete")).toBe(false);
		jest.useRealTimers();
	});
});
