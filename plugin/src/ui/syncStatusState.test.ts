import { describe, expect, test } from "bun:test";
import { MemorySyncFs } from "../test/sync";
import type { SyncTickOptions, SyncTickResult } from "../sync/engine";
import {
	countRawJsonlRows,
	formatShortRelativeTime,
	ManualSyncCoordinator,
	safeErrorSummary,
	SyncStatusState,
	type ManualSyncTarget,
} from "./syncStatusState";

const OK_RESULT: SyncTickResult = {
	ok: true,
	pushed: 0,
	applied: 0,
	deadLettered: 0,
};

describe("sync status state", () => {
	test("counts raw non-empty JSONL rows without coalescing paths", async () => {
		const fs = new MemorySyncFs();
		await fs.write(
			"outbox.jsonl",
			'{"op":"put","path":"same.md"}\n\n  \n{"op":"put","path":"same.md"}\r\n',
		);
		await fs.write("inbox.jsonl", '{"rev":1}\n{"rev":2}\n');
		const state = new SyncStatusState();

		await state.setQueueRuntime(fs, "outbox.jsonl", "inbox.jsonl");

		expect(countRawJsonlRows("\n \n")).toBe(0);
		expect(state.get().outboxDepth).toBe(2);
		expect(state.get().inboxDepth).toBe(2);
	});

	test("publishes zeroes and refreshes promptly after either queue changes", async () => {
		const fs = new MemorySyncFs();
		const state = new SyncStatusState();
		const observed: Array<[number, number]> = [];
		state.subscribe(({ outboxDepth, inboxDepth }) => {
			observed.push([outboxDepth, inboxDepth]);
		});
		await state.setQueueRuntime(fs, "outbox.jsonl", "inbox.jsonl");
		expect(state.get()).toMatchObject({ outboxDepth: 0, inboxDepth: 0 });

		await fs.write("outbox.jsonl", "one\ntwo\n");
		await state.refreshQueueDepths();
		expect(state.get()).toMatchObject({ outboxDepth: 2, inboxDepth: 0 });

		await fs.write("inbox.jsonl", "remote\n");
		await state.refreshQueueDepths();
		expect(state.get()).toMatchObject({ outboxDepth: 2, inboxDepth: 1 });

		await fs.write("outbox.jsonl", "");
		await fs.write("inbox.jsonl", "");
		await state.refreshQueueDepths();
		expect(state.get()).toMatchObject({ outboxDepth: 0, inboxDepth: 0 });
		expect(observed).toContainEqual([2, 0]);
		expect(observed).toContainEqual([2, 1]);
	});

	test("coalesces a burst of queue notifications into one follow-up read", async () => {
		class CountingFs extends MemorySyncFs {
			readCalls = 0;
			private gate: Promise<void> | null = null;
			release!: () => void;

			blockReads(): void {
				this.gate = new Promise<void>((resolve) => { this.release = resolve; });
			}

			override async read(path: string): Promise<string> {
				this.readCalls++;
				if (this.gate) {
					await this.gate;
					this.gate = null;
				}
				return super.read(path);
			}
		}
		const fs = new CountingFs();
		await fs.write("outbox.jsonl", "one\n");
		await fs.write("inbox.jsonl", "remote\n");
		const state = new SyncStatusState();
		await state.setQueueRuntime(fs, "outbox.jsonl", "inbox.jsonl");
		expect(fs.readCalls).toBe(2);

		fs.blockReads();
		const first = state.refreshQueueDepths();
		await Promise.resolve();
		const second = state.refreshQueueDepths();
		const third = state.refreshQueueDepths();
		fs.release();
		await Promise.all([first, second, third]);

		// One active pass and one coalesced follow-up, two queue files per pass.
		expect(fs.readCalls).toBe(6);
	});

	test("tracks only successful sync time, recovers errors, and excludes dead letters", () => {
		const state = new SyncStatusState();
		state.recordTickResult(
			{
				ok: false,
				failureKind: "error",
				error: "offline",
				pushed: 0,
				applied: 0,
				deadLettered: 0,
			},
			100,
		);
		expect(state.get()).toMatchObject({
			lastSuccessfulSyncAt: null,
			lastError: "offline",
		});

		state.recordTickResult(OK_RESULT, 200);
		expect(state.get()).toMatchObject({
			lastSuccessfulSyncAt: 200,
			lastError: null,
		});

		state.recordTickResult({
			ok: false,
			failureKind: "dead-letter",
			error: "wording may change without affecting classification",
			pushed: 0,
			applied: 0,
			deadLettered: 1,
		}, 300);
		expect(state.get()).toMatchObject({
			lastSuccessfulSyncAt: 300,
			lastError: null,
		});
	});

	test("formats errors safely and keeps summaries bounded", () => {
		expect(safeErrorSummary(new Error("network unavailable"))).toBe(
			"network unavailable",
		);
		expect(safeErrorSummary("short failure\nstack trace")).toBe("short failure");
		expect(safeErrorSummary({ code: "OFFLINE" })).toBe('{"code":"OFFLINE"}');
		expect(safeErrorSummary({ toJSON: () => { throw new Error("nope"); } })).toBe(
			"Sync failed unexpectedly",
		);
		expect(safeErrorSummary("x".repeat(500)).length).toBeLessThanOrEqual(160);
		expect(safeErrorSummary({})).not.toBe("[object Object]");
	});

	test("uses concise relative times including a never-synced state", () => {
		expect(formatShortRelativeTime(null, 10_000)).toBe("Never");
		expect(formatShortRelativeTime(5_000, 10_000)).toBe("Just now");
		expect(formatShortRelativeTime(0, 75_000)).toBe("1m ago");
	});

	test("deduplicates manual sync requests and scopes spinner callbacks", async () => {
		const state = new SyncStatusState();
		const coordinator = new ManualSyncCoordinator(state);
		let options: SyncTickOptions | undefined;
		let resolveTick!: (result: SyncTickResult) => void;
		let calls = 0;
		const engine: ManualSyncTarget = {
			isTickActive: () => false,
			tick: (nextOptions) => {
				calls++;
				options = nextOptions;
				return new Promise((resolve) => { resolveTick = resolve; });
			},
		};

		const first = coordinator.request(engine);
		expect(first).not.toBeNull();
		expect(coordinator.request(engine)).toBeNull();
		expect(calls).toBe(1);

		options?.onInboxRequestStarted?.();
		expect(state.get().manualInboxRequestInFlight).toBe(true);
		options?.onInboxRequestFinished?.();
		expect(state.get().manualInboxRequestInFlight).toBe(false);
		resolveTick(OK_RESULT);
		await first;

		const alreadyActive = { ...engine, isTickActive: () => true };
		expect(coordinator.request(alreadyActive)).toBeNull();
	});

	test("background syncs cannot enter the manual spinner state", async () => {
		const state = new SyncStatusState();
		const engine: ManualSyncTarget = {
			isTickActive: () => false,
			tick: async (options) => {
				expect(options).toBeUndefined();
				return OK_RESULT;
			},
		};

		await engine.tick();

		expect(state.get().manualInboxRequestInFlight).toBe(false);
	});
});
