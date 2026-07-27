import { afterEach, describe, expect, jest, test } from "bun:test";
import { Debouncer } from "./debounce";

describe("debounce", () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	test("rapid triggers for the same key collapse into a single call after the quiet period", () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		let calls = 0;

		debouncer.trigger("a.md", () => calls++);
		jest.advanceTimersByTime(400);
		debouncer.trigger("a.md", () => calls++);
		jest.advanceTimersByTime(400);
		debouncer.trigger("a.md", () => calls++);

		expect(calls).toBe(0);
		jest.advanceTimersByTime(999);
		expect(calls).toBe(0);
		jest.advanceTimersByTime(1);
		expect(calls).toBe(1);
	});

	test("different keys debounce independently", () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		const calls: string[] = [];

		debouncer.trigger("a.md", () => calls.push("a"));
		jest.advanceTimersByTime(500);
		debouncer.trigger("b.md", () => calls.push("b"));
		jest.advanceTimersByTime(500);

		expect(calls).toEqual(["a"]);

		jest.advanceTimersByTime(500);
		expect(calls).toEqual(["a", "b"]);
	});

	test("cancel prevents a pending call from firing", () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		let calls = 0;

		debouncer.trigger("a.md", () => calls++);
		debouncer.cancel("a.md");
		jest.advanceTimersByTime(2000);

		expect(calls).toBe(0);
		expect(debouncer.isPending("a.md")).toBe(false);
	});
});
