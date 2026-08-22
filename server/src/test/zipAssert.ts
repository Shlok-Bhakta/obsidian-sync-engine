import { expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const LOCAL_FILE_HEADER = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_FLAG = 0x0008;

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] |
		(bytes[offset + 1] << 8) |
		(bytes[offset + 2] << 16) |
		(bytes[offset + 3] << 24)
	) >>> 0;
}

function readU16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Pickiest unzippers refuse archives that hide CRC/size behind a data descriptor. */
export function assertZipHasKnownSizesInLocalHeaders(bytes: Uint8Array): void {
	expect(readU32(bytes, 0)).toBe(LOCAL_FILE_HEADER);
	let offset = 0;
	let entries = 0;
	while (offset + 30 <= bytes.byteLength) {
		const signature = readU32(bytes, offset);
		if (signature !== LOCAL_FILE_HEADER) break;
		const flag = readU16(bytes, offset + 6);
		expect(flag & DATA_DESCRIPTOR_FLAG).toBe(0);
		const compressedSize = readU32(bytes, offset + 18);
		const nameLength = readU16(bytes, offset + 26);
		const extraLength = readU16(bytes, offset + 28);
		offset += 30 + nameLength + extraLength + compressedSize;
		entries++;
	}
	expect(entries).toBeGreaterThan(0);
}

export function assertZipEndsAtCentralDirectory(bytes: Uint8Array): void {
	let matched = false;
	const minEocd = 22;
	const maxComment = 65_535;
	const start = Math.max(0, bytes.byteLength - minEocd - maxComment);
	for (let offset = bytes.byteLength - minEocd; offset >= start; offset--) {
		if (readU32(bytes, offset) !== EOCD_SIGNATURE) continue;
		const commentLength = readU16(bytes, offset + 20);
		if (offset + minEocd + commentLength === bytes.byteLength) {
			matched = true;
			break;
		}
	}
	expect(matched).toBe(true);
	expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
}

export async function assertSystemUnzipExtracts(bytes: Uint8Array): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "obsidian-zip-assert-"));
	const zipPath = join(dir, "archive.zip");
	try {
		await writeFile(zipPath, bytes);
		const unzip = await $`unzip -t ${zipPath}`.quiet().nothrow();
		expect(unzip.exitCode).toBe(0);
		const python = Bun.spawnSync(
			[
				"python3",
				"-c",
				"import zipfile, sys; archive = zipfile.ZipFile(sys.argv[1]); sys.exit(0 if archive.testzip() is None else 1)",
				zipPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(python.exitCode).toBe(0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
