import { describe, expect, it } from "bun:test";
import { unzipSync } from "fflate";
import {
	assertSystemUnzipExtracts,
	assertZipEndsAtCentralDirectory,
	assertZipHasKnownSizesInLocalHeaders,
} from "../test/zipAssert";
import { ZipArchiveWriter } from "./zipArchive";

const decoder = new TextDecoder();

describe("ZipArchiveWriter", () => {
	it("writes a tight archive that system unzippers can extract", async () => {
		const png = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
			0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
			0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00,
			0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
		const pooled = Buffer.alloc(32, 0x41);
		Buffer.from("hello").copy(pooled, 8);
		const view = pooled.subarray(8, 13);
		const zip = new ZipArchiveWriter();
		zip.add("note.md", view);
		zip.add(".obsidian/app.json", new TextEncoder().encode("{}"));
		zip.add("empty.md", new Uint8Array());
		zip.add("Inbox/回复.md", new TextEncoder().encode("from another device"));
		zip.add("pixel.png", png);

		const archive = zip.finish();
		assertZipHasKnownSizesInLocalHeaders(archive);
		assertZipEndsAtCentralDirectory(archive);
		await assertSystemUnzipExtracts(archive);

		const extracted = unzipSync(archive);
		expect(decoder.decode(extracted["note.md"])).toBe("hello");
		expect(decoder.decode(extracted[".obsidian/app.json"])).toBe("{}");
		expect(extracted["empty.md"]?.byteLength ?? 0).toBe(0);
		expect(decoder.decode(extracted["Inbox/回复.md"])).toBe("from another device");
		expect(extracted["pixel.png"]).toEqual(png);
	});
});
