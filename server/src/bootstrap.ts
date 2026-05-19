import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "bun";
import { ServerFileRow, compactMaterializedSyncEvents, getServerRevision } from "./sync/engine";
import { readLargeObject } from "./db/largeObject";
import { mintNewClientKey } from "./security";

const adjectives = [
  "brisk",
  "calm",
  "clever",
  "daring",
  "eager",
  "gentle",
  "lively",
  "nimble",
  "quiet",
  "swift",
];

const nouns = [
  "apple",
  "cedar",
  "ember",
  "harbor",
  "lantern",
  "meadow",
  "orbit",
  "river",
  "signal",
  "willow",
];

type BootstrapFileRow = ServerFileRow;

export type BootstrapBuildRequest = {
  vaultName: string;
  backendUrl: string;
  configDir: string;
  pluginId: string;
};

export type BootstrapBuildResult = {
  zipPath: string;
  zipBytes: number;
  snapshotRevision: string;
  cleanup: () => Promise<void>;
};

function ensureSafeVaultName(vaultName: string): void {
  if (!vaultName || vaultName.includes("/") || vaultName.includes("\\") || vaultName === "." || vaultName === "..") {
    throw new Error("Vault name cannot be empty or contain path separators");
  }
}

function ensureSafeVaultPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Refusing to bootstrap unsafe path: ${path}`);
  }
}

function isVaultRootPath(path: string): boolean {
  return path === "/" || path === ".";
}

function randomClientName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] ?? adjectives[0];
  const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? nouns[0];
  return `${adjective}-${noun}`;
}

type ZipEntry = {
  path: string;
  isDirectory: boolean;
};

async function listZipEntries(root: string): Promise<ZipEntry[]> {
  const output: ZipEntry[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push({ path: fullPath, isDirectory: true });
      output.push(...await listZipEntries(fullPath));
    } else if (entry.isFile()) {
      output.push({ path: fullPath, isDirectory: false });
    }
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

async function createStoredZip(root: string, zipPath: string): Promise<number> {
  const entries = await listZipEntries(root);
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const relativeName = relative(root, entry.path).split(sep).join(posix.sep);
    const name = entry.isDirectory ? `${relativeName}/` : relativeName;
    const nameBytes = encoder.encode(name);
    const data = entry.isDirectory ? new Uint8Array() : new Uint8Array(await Bun.file(entry.path).arrayBuffer());
    const checksum = crc32(data);
    const common = [
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(now.time),
      uint16(now.date),
      uint32(checksum),
      uint32(data.byteLength),
      uint32(data.byteLength),
      uint16(nameBytes.byteLength),
      uint16(0),
    ];
    const local = concatBytes([
      uint32(0x04034b50),
      ...common,
      nameBytes,
      data,
    ]);
    localParts.push(local);
    centralParts.push(concatBytes([
      uint32(0x02014b50),
      uint16(20),
      ...common,
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(entry.isDirectory ? 0x10 : 0),
      uint32(offset),
      nameBytes,
    ]));
    offset += local.byteLength;
  }

  const central = concatBytes(centralParts);
  const zip = concatBytes([
    ...localParts,
    central,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.byteLength),
    uint32(offset),
    uint16(0),
  ]);
  await Bun.write(zipPath, zip);
  return zip.byteLength;
}

async function readBootstrapRows(): Promise<BootstrapFileRow[]> {
  return sql<BootstrapFileRow[]>`
    SELECT
      path,
      content,
      content_bytes AS "contentBytes",
      content_oid AS "contentOid",
      storage_kind AS "storageKind",
      byte_size::TEXT AS "byteSize",
      content_sha256 AS "contentSha256",
      yjs_state AS "yjsState",
      is_folder AS "isFolder",
      is_yjs AS "isYjs",
      deleted,
      revision::TEXT AS revision,
      EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
    FROM files
    WHERE deleted = FALSE
    ORDER BY is_folder DESC, path ASC;
  `;
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
}

async function writePluginInternals(
  root: string,
  request: BootstrapBuildRequest,
  snapshotRevision: string,
): Promise<void> {
  const pluginDir = join(root, request.configDir, "plugins", request.pluginId);
  const outboxDir = join(pluginDir, "outbox");
  await mkdir(outboxDir, { recursive: true });
  await Bun.write(join(pluginDir, "data.json"), JSON.stringify({
    backendUrl: request.backendUrl,
    clientId: `obs_client_${crypto.randomUUID()}`,
    clientKey: await mintNewClientKey(),
    clientName: randomClientName(),
    lastPulledRevision: snapshotRevision,
  }, null, 2));
  await Bun.write(join(outboxDir, "active.jsonl"), "");
  await Bun.write(join(outboxDir, "meta.json"), JSON.stringify({ nextRowId: 1, nextSegmentId: 1 }));
}

export async function buildBootstrapZip(request: BootstrapBuildRequest): Promise<BootstrapBuildResult> {
  ensureSafeVaultName(request.vaultName);
  await compactMaterializedSyncEvents();
  const snapshotRevision = await getServerRevision();
  const tempRoot = await mkdtempCompat(join(tmpdir(), "obsidian-sync-bootstrap-"));
  const vaultRoot = join(tempRoot, request.vaultName);
  await mkdir(vaultRoot, { recursive: true });

  try {
    const rows = await readBootstrapRows();
    for (const row of rows) {
      if (isVaultRootPath(row.path)) {
        continue;
      }
      ensureSafeVaultPath(row.path);
      const target = join(vaultRoot, ...row.path.split("/"));
      if (row.isFolder) {
        await mkdir(target, { recursive: true });
        continue;
      }

      let bytes: Uint8Array;
      if (row.storageKind === "lo") {
        if (!row.contentOid) {
          throw new Error(`Large object file is missing content OID: ${row.path}`);
        }
        bytes = await readLargeObject(row.contentOid);
      } else if (row.storageKind === "bytea") {
        bytes = row.contentBytes ?? new Uint8Array();
      } else {
        bytes = new TextEncoder().encode(row.content ?? "");
      }
      await writeFileBytes(target, bytes);

      if (row.isYjs && row.yjsState && row.path.endsWith(".md")) {
        const statePath = join(vaultRoot, request.configDir, "plugins", request.pluginId, "yjs-state", `${row.path}.state`);
        await writeFileBytes(statePath, row.yjsState);
      }
    }

    await writePluginInternals(vaultRoot, request, snapshotRevision);
    const zipPath = join(tempRoot, `${request.vaultName}.zip`);
    const zipBytes = await createStoredZip(tempRoot, zipPath);
    return {
      zipPath,
      zipBytes,
      snapshotRevision,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(prefix);
}
