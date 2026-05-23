import { App, normalizePath, PluginManifest } from "obsidian";
import { base64ToBytes, bytesToBase64 } from "../../../shared/protocol";
import { outboxData } from "../../../shared/types";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

type OutboxMeta = {
    nextRowId: number;
    nextSegmentId: number;
};

type EncodedOutboxRow = Omit<outboxData, "data" | "contentBytes" | "yjsState"> & {
    id: number;
    data?: string;
    contentBytes?: string;
    yjsState?: string;
};

export type OutboxSegment = {
    id: string;
    path: string;
};

export interface OutboxStore {
    open(): Promise<void>;
    close(): Promise<void>;
    putInOutbox(row: outboxData): Promise<number>;
    hasPendingChanges(): Promise<boolean>;
    claimNextSegment(sealActive: boolean): Promise<OutboxSegment | null>;
    readSegmentJsonl(segment: OutboxSegment): Promise<string>;
    readSegment(segment: OutboxSegment): Promise<outboxData[]>;
    completeSegment(segment: OutboxSegment): Promise<void>;
    releaseSegment(segment: OutboxSegment): Promise<void>;
}

const MAX_ACTIVE_RECORDS = 100;
const MAX_ACTIVE_BYTES = 256 * 1024;
const DEFAULT_META: OutboxMeta = {
    nextRowId: 1,
    nextSegmentId: 1,
};

function pendingSegmentName(segmentId: number): string {
    return `${segmentId.toString().padStart(12, "0")}.pending.jsonl`;
}

function sendingSegmentName(segmentId: string): string {
    return `${segmentId}.sending.jsonl`;
}

function getSegmentId(fileName: string): string {
    return fileName.split(".")[0] ?? fileName;
}

export class JsonlOutboxStore implements OutboxStore {
    private readonly dir: string;
    private readonly activePath: string;
    private readonly metaPath: string;
    private meta: OutboxMeta = { ...DEFAULT_META };
    private activeRecords = 0;
    private activeBytes = 0;
    private isOpen = false;
    private queue: Promise<void> = Promise.resolve();
    private metaDirty = false;

    constructor(private readonly app: App, manifest: PluginManifest) {
        this.dir = normalizePath(`${app.vault.configDir}/plugins/${manifest.id}/outbox`);
        this.activePath = normalizePath(`${this.dir}/active.jsonl`);
        this.metaPath = normalizePath(`${this.dir}/meta.json`);
    }

    async open(): Promise<void> {
        await this.runExclusive(async () => {
            await this.ensureDirectory();
            this.meta = await this.readMeta();
            await this.recoverSendingSegments();
            await this.ensureFile(this.activePath);
            await this.repairMetaFromDisk();
            await this.refreshActiveStats();
            this.isOpen = true;
            log.info("outbox opened", {
                dir: this.dir,
                activeRecords: this.activeRecords,
                activeBytes: this.activeBytes,
                nextRowId: this.meta.nextRowId,
                nextSegmentId: this.meta.nextSegmentId,
            });
        });
    }

    async close(): Promise<void> {
        await this.runExclusive(async () => {
            await this.writeMetaIfDirty();
            this.isOpen = false;
        });
    }

    async putInOutbox(row: outboxData): Promise<number> {
        return this.runExclusive(async () => {
            this.assertOpen();
            const id = this.meta.nextRowId++;
            const storedRow: EncodedOutboxRow = {
                ...row,
                id,
                data: row.data ? bytesToBase64(row.data) : undefined,
                contentBytes: row.contentBytes ? bytesToBase64(row.contentBytes) : undefined,
                yjsState: row.yjsState ? bytesToBase64(row.yjsState) : undefined,
            };
            const line = `${JSON.stringify(storedRow)}\n`;
            await this.app.vault.adapter.append(this.activePath, line);
            this.activeRecords++;
            this.activeBytes += line.length;
            this.metaDirty = true;
            log.debug("outbox row appended", {
                rowId: id,
                operation: row.operation,
                path: row.path,
                activeRecords: this.activeRecords,
                activeBytes: this.activeBytes,
            });

            if (this.activeRecords >= MAX_ACTIVE_RECORDS || this.activeBytes >= MAX_ACTIVE_BYTES) {
                await this.sealActiveSegment();
            }

            return id;
        });
    }

    async hasPendingChanges(): Promise<boolean> {
        return this.runExclusive(async () => {
            this.assertOpen();
            if (this.activeRecords > 0) {
                return true;
            }
            return (await this.listSegmentFiles())
                .some(name => name.endsWith(".pending.jsonl") || name.endsWith(".sending.jsonl"));
        });
    }

    async claimNextSegment(sealActive: boolean): Promise<OutboxSegment | null> {
        return this.runExclusive(async () => {
            this.assertOpen();
            if (sealActive && this.activeRecords > 0) {
                await this.sealActiveSegment();
            }

            const pending = await this.listPendingSegments();
            const next = pending[0];
            if (!next) {
                return null;
            }

            const id = getSegmentId(next);
            const pendingPath = normalizePath(`${this.dir}/${next}`);
            const sendingPath = normalizePath(`${this.dir}/${sendingSegmentName(id)}`);
            await this.app.vault.adapter.rename(pendingPath, sendingPath);
            return { id, path: sendingPath };
        });
    }

    async readSegment(segment: OutboxSegment): Promise<outboxData[]> {
        const raw = await this.readSegmentJsonl(segment);
        const rows: outboxData[] = [];

        for (const [index, line] of raw.split("\n").entries()) {
            if (!line.trim()) {
                continue;
            }

            try {
                const encoded = JSON.parse(line) as EncodedOutboxRow;
                rows.push({
                    ...encoded,
                    data: encoded.data ? base64ToBytes(encoded.data) : undefined,
                    contentBytes: encoded.contentBytes ? base64ToBytes(encoded.contentBytes) : undefined,
                    yjsState: encoded.yjsState ? base64ToBytes(encoded.yjsState) : undefined,
                });
            } catch (error) {
                log.error("skipping corrupt outbox line", { line: index + 1, path: segment.path, ...errorContext(error) });
            }
        }

        return rows;
    }

    async readSegmentJsonl(segment: OutboxSegment): Promise<string> {
        return this.app.vault.adapter.read(segment.path);
    }

    async completeSegment(segment: OutboxSegment): Promise<void> {
        await this.runExclusive(async () => {
            if (await this.app.vault.adapter.exists(segment.path)) {
                await this.app.vault.adapter.remove(segment.path);
            }
        });
    }

    async releaseSegment(segment: OutboxSegment): Promise<void> {
        await this.runExclusive(async () => {
            if (!(await this.app.vault.adapter.exists(segment.path))) {
                return;
            }

            const pendingPath = normalizePath(`${this.dir}/${segment.id}.pending.jsonl`);
            await this.app.vault.adapter.rename(segment.path, pendingPath);
        });
    }

    private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.queue;
        let release!: () => void;
        this.queue = new Promise<void>(resolve => {
            release = resolve;
        });

        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }

    private async ensureDirectory(): Promise<void> {
        const parts = this.dir.split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!(await this.app.vault.adapter.exists(current))) {
                await this.app.vault.adapter.mkdir(current);
            }
        }
    }

    private async ensureFile(path: string): Promise<void> {
        if (!(await this.app.vault.adapter.exists(path))) {
            await this.app.vault.adapter.write(path, "");
        }
    }

    private async readMeta(): Promise<OutboxMeta> {
        if (!(await this.app.vault.adapter.exists(this.metaPath))) {
            await this.app.vault.adapter.write(this.metaPath, JSON.stringify(DEFAULT_META));
            return { ...DEFAULT_META };
        }

        const parsed = JSON.parse(await this.app.vault.adapter.read(this.metaPath)) as Partial<OutboxMeta>;
        return {
            nextRowId: Math.max(1, parsed.nextRowId ?? DEFAULT_META.nextRowId),
            nextSegmentId: Math.max(1, parsed.nextSegmentId ?? DEFAULT_META.nextSegmentId),
        };
    }

    private async writeMeta(): Promise<void> {
        await this.app.vault.adapter.write(this.metaPath, JSON.stringify(this.meta));
        this.metaDirty = false;
    }

    private async writeMetaIfDirty(): Promise<void> {
        if (this.metaDirty) {
            await this.writeMeta();
        }
    }

    private async refreshActiveStats(): Promise<void> {
        const raw = await this.app.vault.adapter.read(this.activePath);
        this.activeBytes = raw.length;
        this.activeRecords = raw.trim() ? raw.trimEnd().split("\n").length : 0;
    }

    private async recoverSendingSegments(): Promise<void> {
        const files = await this.listSegmentFiles();
        for (const file of files.filter(name => name.endsWith(".sending.jsonl"))) {
            const id = getSegmentId(file);
            await this.app.vault.adapter.rename(
                normalizePath(`${this.dir}/${file}`),
                normalizePath(`${this.dir}/${id}.pending.jsonl`),
            );
        }
    }

    private async repairMetaFromDisk(): Promise<void> {
        const segmentFiles = await this.listSegmentFiles();
        let maxSegmentId = 0;
        let maxRowId = 0;

        for (const file of segmentFiles) {
            if (file.endsWith(".pending.jsonl") || file.endsWith(".sending.jsonl")) {
                maxSegmentId = Math.max(maxSegmentId, Number.parseInt(getSegmentId(file), 10) || 0);
                maxRowId = Math.max(maxRowId, await this.readMaxRowId(normalizePath(`${this.dir}/${file}`)));
            }
        }

        maxRowId = Math.max(maxRowId, await this.readMaxRowId(this.activePath));
        this.meta.nextSegmentId = Math.max(this.meta.nextSegmentId, maxSegmentId + 1);
        this.meta.nextRowId = Math.max(this.meta.nextRowId, maxRowId + 1);
        await this.writeMeta();
    }

    private async readMaxRowId(path: string): Promise<number> {
        if (!(await this.app.vault.adapter.exists(path))) {
            return 0;
        }

        const raw = await this.app.vault.adapter.read(path);
        let maxId = 0;
        for (const [index, line] of raw.split("\n").entries()) {
            if (!line.trim()) {
                continue;
            }
            try {
                const row = JSON.parse(line) as Partial<EncodedOutboxRow>;
                maxId = Math.max(maxId, row.id ?? 0);
            } catch (error) {
                log.error("skipping corrupt outbox line", { line: index + 1, path, ...errorContext(error) });
            }
        }
        return maxId;
    }

    private async listPendingSegments(): Promise<string[]> {
        return (await this.listSegmentFiles())
            .filter(name => name.endsWith(".pending.jsonl"))
            .sort();
    }

    private async listSegmentFiles(): Promise<string[]> {
        const listed = await this.app.vault.adapter.list(this.dir);
        return listed.files
            .map(path => path.split("/").pop())
            .filter((name): name is string => name !== undefined);
    }

    private async sealActiveSegment(): Promise<void> {
        if (this.activeRecords === 0) {
            return;
        }

        const segmentId = this.meta.nextSegmentId++;
        const pendingPath = normalizePath(`${this.dir}/${pendingSegmentName(segmentId)}`);
        await this.app.vault.adapter.rename(this.activePath, pendingPath);
        await this.app.vault.adapter.write(this.activePath, "");
        this.activeRecords = 0;
        this.activeBytes = 0;
        this.metaDirty = true;
        await this.writeMeta();
        log.debug("outbox active segment sealed", { segmentId: String(segmentId), pendingPath });
    }

    private assertOpen(): void {
        if (!this.isOpen) {
            throw new Error("Outbox store is not open");
        }
    }
}
