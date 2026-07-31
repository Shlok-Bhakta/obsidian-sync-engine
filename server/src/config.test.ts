import { expect, test } from "bun:test";
import { MAX_REQUEST_BODY_SIZE } from "./config";

test("server accepts uploads larger than the former 10 MiB limit", async () => {
	const body = new Uint8Array(11 * 1024 * 1024);
	using server = Bun.serve({
		port: 0,
		maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
		async fetch(request) {
			return Response.json({
				bytesWritten: (await request.arrayBuffer()).byteLength,
			});
		},
	});

	const response = await fetch(server.url, {
		method: "POST",
		body,
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ bytesWritten: body.byteLength });
});
