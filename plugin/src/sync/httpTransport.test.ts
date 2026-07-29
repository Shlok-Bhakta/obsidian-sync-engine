import { describe, expect, test } from "bun:test";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { PermanentRemoteError } from "./engine";
import { HttpTransport, RemoteFileNotFoundError, type HttpRequestFn } from "./httpTransport";

const SERVER_URL = "https://sync.example.com";
const SECRET = "obs_sync_test-secret";

function fakeResponse(
	overrides: Partial<RequestUrlResponse> = {},
): RequestUrlResponse {
	return {
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: undefined,
		text: "",
		...overrides,
	};
}

/** Records every call made through `request` so tests can assert on it. */
function recordingRequest(
	respond: (params: RequestUrlParam) => RequestUrlResponse,
): { request: HttpRequestFn; calls: RequestUrlParam[] } {
	const calls: RequestUrlParam[] = [];
	const request: HttpRequestFn = async (params) => {
		calls.push(params);
		return respond(params);
	};
	return { request, calls };
}

function makeTransport(request: HttpRequestFn): HttpTransport {
	return new HttpTransport({
		getServerUrl: () => SERVER_URL,
		getAuthorization: () => SECRET,
		request,
	});
}

describe("HttpTransport", () => {
	test("upload POSTs to /files with auth + path headers and parses the revision", async () => {
		const { request, calls } = recordingRequest(() =>
			fakeResponse({ json: { path: "a.md", bytesWritten: 5, revision: 3 } }),
		);
		const transport = makeTransport(request);

		const result = await transport.upload("notes/a b.md", "hello");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: `${SERVER_URL}/files`,
			method: "POST",
			body: "hello",
		});
		expect(calls[0]?.headers).toMatchObject({
			Authorization: SECRET,
			"X-Obsidian-Path": encodeURIComponent("notes/a b.md"),
		});
		expect(result).toEqual({ revision: 3 });
	});

	test("deleteRemote DELETEs /files with an encoded path query param", async () => {
		const { request, calls } = recordingRequest(() =>
			fakeResponse({ json: { path: "a.md", revision: 4 } }),
		);
		const transport = makeTransport(request);

		const result = await transport.deleteRemote("notes/a b.md");

		expect(calls[0]).toMatchObject({
			url: `${SERVER_URL}/files?path=${encodeURIComponent("notes/a b.md")}`,
			method: "DELETE",
		});
		expect(result).toEqual({ revision: 4 });
	});

	test("download GETs /files and returns the raw arrayBuffer", async () => {
		const bytes = new TextEncoder().encode("file contents").buffer;
		const { request, calls } = recordingRequest(() =>
			fakeResponse({ arrayBuffer: bytes }),
		);
		const transport = makeTransport(request);

		const result = await transport.download("notes/a.md");

		expect(calls[0]).toMatchObject({
			url: `${SERVER_URL}/files?path=${encodeURIComponent("notes/a.md")}`,
			method: "GET",
		});
		expect(result).toBe(bytes);
	});

	test("fetchInbox parses NDJSON lines into InboxOp[]", async () => {
		const body =
			[
				JSON.stringify({ rev: 1, op: "put", path: "a.md" }),
				JSON.stringify({ rev: 2, op: "delete", path: "b.md" }),
			].join("\n") + "\n";
		const { request, calls } = recordingRequest(() => fakeResponse({ text: body }));
		const transport = makeTransport(request);

		const ops = await transport.fetchInbox(0);

		expect(calls[0]).toMatchObject({
			url: `${SERVER_URL}/inbox?rev=0`,
			method: "GET",
		});
		expect(ops).toEqual([
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "delete", path: "b.md" },
		]);
	});

	test("fetchInbox returns an empty array for an empty body", async () => {
		const { request } = recordingRequest(() => fakeResponse({ text: "" }));
		const transport = makeTransport(request);

		expect(await transport.fetchInbox(5)).toEqual([]);
	});

	test("a 4xx/5xx response throws with the status and body text", async () => {
		const { request } = recordingRequest(() =>
			fakeResponse({ status: 401, text: "Unauthorized" }),
		);
		const transport = makeTransport(request);

		let caught: unknown;
		try {
			await transport.upload("a.md", "x");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("401");
		expect((caught as Error).message).toContain("Unauthorized");
	});

	test("download throws RemoteFileNotFoundError on 404", async () => {
		const { request } = recordingRequest(() =>
			fakeResponse({ status: 404, text: "Not found" }),
		);
		const transport = makeTransport(request);

		let caught: unknown;
		try {
			await transport.download("gone.md");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(RemoteFileNotFoundError);
	});

	test("upload and delete throw PermanentRemoteError on 400/413", async () => {
		const { request } = recordingRequest((params) => {
			if (params.method === "POST") {
				return fakeResponse({ status: 413, text: "Payload too large" });
			}
			return fakeResponse({ status: 400, text: "Invalid path" });
		});
		const transport = makeTransport(request);

		let uploadError: unknown;
		try {
			await transport.upload("a.md", "x");
		} catch (error) {
			uploadError = error;
		}
		expect(uploadError).toBeInstanceOf(PermanentRemoteError);

		let deleteError: unknown;
		try {
			await transport.deleteRemote("a.md");
		} catch (error) {
			deleteError = error;
		}
		expect(deleteError).toBeInstanceOf(PermanentRemoteError);
	});

	test("malformed successful revisions never acknowledge durable work", async () => {
		const malformed = [undefined, "4", Number.NaN, -1, 1.5];
		for (const revision of malformed) {
			const { request } = recordingRequest(() =>
				fakeResponse({ json: { revision } }),
			);
			const transport = makeTransport(request);
			expect(transport.upload("a.md", "x")).rejects.toThrow();
			expect(transport.deleteRemote("a.md")).rejects.toThrow();
		}
	});
});
