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

		debouncer.trigger("a.md", () => {
			calls++;
		});
		jest.advanceTimersByTime(400);
		debouncer.trigger("a.md", () => {
			calls++;
		});
		jest.advanceTimersByTime(400);
		debouncer.trigger("a.md", () => {
			calls++;
		});

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

		debouncer.trigger("a.md", () => {
			calls.push("a");
		});
		jest.advanceTimersByTime(500);
		debouncer.trigger("b.md", () => {
			calls.push("b");
		});
		jest.advanceTimersByTime(500);

		expect(calls).toEqual(["a"]);

		jest.advanceTimersByTime(500);
		expect(calls).toEqual(["a", "b"]);
	});

	test("cancel prevents a pending call from firing", () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		let calls = 0;

		debouncer.trigger("a.md", () => {
			calls++;
		});
		debouncer.cancel("a.md");
		jest.advanceTimersByTime(2000);

		expect(calls).toBe(0);
		expect(debouncer.isPending("a.md")).toBe(false);
	});

	test("flush runs pending callbacks immediately without waiting for the timer", async () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		const calls: string[] = [];

		debouncer.trigger("a.md", () => {
			calls.push("a");
		});
		debouncer.trigger("b.md", () => {
			calls.push("b");
		});

		// Nothing should have fired yet — the timers haven't elapsed.
		expect(calls).toEqual([]);

		await debouncer.flush();

		expect(calls.sort()).toEqual(["a", "b"]);
		expect(debouncer.isPending("a.md")).toBe(false);
		expect(debouncer.isPending("b.md")).toBe(false);

		// The original timers must be cancelled, not just raced — advancing
		// past their delay should not call the callbacks a second time.
		jest.advanceTimersByTime(2000);
		expect(calls.sort()).toEqual(["a", "b"]);
	});

	test("flush awaits async callbacks before resolving", async () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);
		let resolved = false;

		debouncer.trigger("a.md", async () => {
			await Promise.resolve();
			await Promise.resolve();
			resolved = true;
		});

		await debouncer.flush();

		expect(resolved).toBe(true);
	});

	test("flush is a no-op when nothing is pending", async () => {
		jest.useFakeTimers();
		const debouncer = new Debouncer<string>(1000);

		const result = await debouncer.flush();

		expect(result).toBeUndefined();
	});
});
