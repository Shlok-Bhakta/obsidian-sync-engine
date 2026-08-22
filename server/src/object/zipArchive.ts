import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const UNIX = 3;
const UTF8_FLAG = 1 << 11;
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const UNIX_FILE_ATTRS = (0o100644 << 16) >>> 0;

type CentralEntry = {
	name: Buffer;
	flag: number;
	method: number;
	dosTime: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
};

function writeU16(target: Buffer, offset: number, value: number): void {
	target.writeUInt16LE(value, offset);
}

function writeU32(target: Buffer, offset: number, value: number): void {
	target.writeUInt32LE(value, offset);
}

function dosTime(date = new Date()): number {
	const year = date.getFullYear() - 1980;
	if (year < 0 || year > 119) {
		return dosTime(new Date("2026-01-01T00:00:00"));
	}
	return (
		(year << 25) |
		((date.getMonth() + 1) << 21) |
		(date.getDate() << 16) |
		(date.getHours() << 11) |
		(date.getMinutes() << 5) |
		(date.getSeconds() >> 1)
	);
}

function tightBytes(content: Uint8Array): Buffer {
	if (content.byteLength === 0) return Buffer.alloc(0);
	return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * Builds PKZIP archives with CRC and sizes in each local header.
 * Streaming zip writers that hide those fields behind a data descriptor
 * are rejected by Windows Explorer, some mobile unzippers, and Obsidian.
 */
export class ZipArchiveWriter {
	private buffer = Buffer.allocUnsafe(64 * 1024);
	private length = 0;
	private readonly entries: CentralEntry[] = [];

	add(path: string, content: Uint8Array): void {
		if (this.entries.length >= MAX_ENTRIES) {
			throw new Error("ZIP archives cannot contain more than 65535 files");
		}
		const name = Buffer.from(path, "utf8");
		if (name.byteLength === 0 || name.byteLength > 0xffff) {
			throw new Error(`ZIP entry name is invalid: ${path}`);
		}
		const uncompressed = tightBytes(content);
		if (uncompressed.byteLength > MAX_32) {
			throw new Error(`ZIP entry ${path} is larger than 4 GiB`);
		}
		const method = uncompressed.byteLength === 0 ? 0 : 8;
		const compressed =
			method === 0
				? uncompressed
				: deflateRawSync(uncompressed, { level: 6 });
		if (compressed.byteLength > MAX_32) {
			throw new Error(`Compressed ZIP entry ${path} is larger than 4 GiB`);
		}
		const crc = uncompressed.byteLength === 0 ? 0 : crc32(uncompressed) >>> 0;
		const flag = name.byteLength === path.length ? 0 : UTF8_FLAG;
		const localHeaderOffset = this.length;
		if (localHeaderOffset > MAX_32) {
			throw new Error("ZIP archive exceeded the 4 GiB local-header limit");
		}
		const timestamp = dosTime();

		const header = Buffer.alloc(30 + name.byteLength);
		writeU32(header, 0, LOCAL_FILE_HEADER);
		writeU16(header, 4, ZIP_VERSION);
		writeU16(header, 6, flag);
		writeU16(header, 8, method);
		writeU32(header, 10, timestamp);
		writeU32(header, 14, crc);
		writeU32(header, 18, compressed.byteLength);
		writeU32(header, 22, uncompressed.byteLength);
		writeU16(header, 26, name.byteLength);
		writeU16(header, 28, 0);
		name.copy(header, 30);

		this.append(header);
		if (compressed.byteLength > 0) this.append(compressed);

		this.entries.push({
			name,
			flag,
			method,
			dosTime: timestamp,
			crc,
			compressedSize: compressed.byteLength,
			uncompressedSize: uncompressed.byteLength,
			localHeaderOffset,
		});
	}

	finish(): Buffer {
		const centralDirectoryOffset = this.length;
		for (const entry of this.entries) {
			const header = Buffer.alloc(46 + entry.name.byteLength);
			writeU32(header, 0, CENTRAL_DIRECTORY_HEADER);
			writeU16(header, 4, (UNIX << 8) | ZIP_VERSION);
			writeU16(header, 6, ZIP_VERSION);
			writeU16(header, 8, entry.flag);
			writeU16(header, 10, entry.method);
			writeU32(header, 12, entry.dosTime);
			writeU32(header, 16, entry.crc);
			writeU32(header, 20, entry.compressedSize);
			writeU32(header, 24, entry.uncompressedSize);
			writeU16(header, 28, entry.name.byteLength);
			writeU16(header, 30, 0);
			writeU16(header, 32, 0);
			writeU16(header, 34, 0);
			writeU16(header, 36, 0);
			writeU32(header, 38, UNIX_FILE_ATTRS);
			writeU32(header, 42, entry.localHeaderOffset);
			entry.name.copy(header, 46);
			this.append(header);
		}

		const eocd = Buffer.alloc(22);
		writeU32(eocd, 0, EOCD_SIGNATURE);
		writeU16(eocd, 4, 0);
		writeU16(eocd, 6, 0);
		writeU16(eocd, 8, this.entries.length);
		writeU16(eocd, 10, this.entries.length);
		writeU32(eocd, 12, this.length - centralDirectoryOffset);
		writeU32(eocd, 16, centralDirectoryOffset);
		writeU16(eocd, 20, 0);
		this.append(eocd);
		return Buffer.from(this.buffer.subarray(0, this.length));
	}

	private append(chunk: Uint8Array): void {
		const requiredLength = this.length + chunk.byteLength;
		if (requiredLength > this.buffer.byteLength) {
			let nextCapacity = this.buffer.byteLength;
			while (nextCapacity < requiredLength) nextCapacity *= 2;
			const next = Buffer.allocUnsafe(nextCapacity);
			this.buffer.copy(next, 0, 0, this.length);
			this.buffer = next;
		}
		this.buffer.set(chunk, this.length);
		this.length = requiredLength;
	}
}
