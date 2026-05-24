import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { BlobClient } from "./BlobClient";

function requestResponse(status: number, text: string, arrayBuffer = new ArrayBuffer(0)): obsidian.RequestUrlResponse {
    return {
        status,
        text,
        arrayBuffer,
        headers: {},
        json: null,
    };
}

describe("BlobClient", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("refreshes auth and retries uploads once after a 401", async () => {
        const requestMock = vi.spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(requestResponse(401, "Client key is invalid"))
            .mockResolvedValueOnce(requestResponse(200, JSON.stringify({
                uploadId: "blob_1",
                path: "themes/AnuPpuccin/theme.css",
                byteSize: 3,
                contentSha256: "sha",
            })));
        const refreshAuth = vi.fn(async () => "obs_sync_fresh");
        const client = new BlobClient("wss://sync.example.test/worker", "obs_sync_stale", refreshAuth);

        await expect(client.upload(
            "themes/AnuPpuccin/theme.css",
            new Uint8Array([1, 2, 3]),
            "sha",
            "obs_client_1",
        )).resolves.toMatchObject({ uploadId: "blob_1" });

        expect(refreshAuth).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledTimes(2);
        expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
            throw: false,
        });
        expect((requestMock.mock.calls[0]?.[0] as obsidian.RequestUrlParam).headers).toMatchObject({
            Authorization: "Bearer obs_sync_stale",
            "X-Client-Id": "obs_client_1",
        });
        expect((requestMock.mock.calls[1]?.[0] as obsidian.RequestUrlParam).headers).toMatchObject({
            Authorization: "Bearer obs_sync_fresh",
        });
    });

    it("refreshes auth and retries downloads once after a 401", async () => {
        const bytes = new Uint8Array([4, 5, 6]);
        const requestMock = vi.spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(requestResponse(401, "Client key is invalid"))
            .mockResolvedValueOnce(requestResponse(200, "", bytes.buffer.slice(0)));
        const refreshAuth = vi.fn(async () => "obs_sync_fresh");
        const client = new BlobClient("https://sync.example.test", "obs_sync_stale", refreshAuth);

        await expect(client.download("assets/image.bin")).resolves.toEqual(bytes);

        expect(refreshAuth).toHaveBeenCalledTimes(1);
        expect(requestMock).toHaveBeenCalledTimes(2);
        expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
            throw: false,
        });
        expect((requestMock.mock.calls[1]?.[0] as obsidian.RequestUrlParam).headers).toMatchObject({
            Authorization: "Bearer obs_sync_fresh",
        });
    });
});
