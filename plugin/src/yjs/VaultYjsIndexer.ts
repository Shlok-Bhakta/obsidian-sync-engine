import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import * as Y from "yjs";
import { docStateFromContent } from "../../../shared/yjsSeed";
import { YjsStateStore } from "./YjsStateStore";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

const BATCH_SIZE = 25;

export type IndexedMarkdownChange = {
    path: string;
    content: string;
    yjsState: Uint8Array;
    contentHash: string;
};

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class VaultYjsIndexer {
    private stopped = false;
    private scanPromise: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly store: YjsStateStore,
        private readonly shouldIgnorePath: (path: string) => boolean,
        private readonly onIndexedChange: (change: IndexedMarkdownChange) => Promise<void> = async () => {},
    ) {}

    start(): void {
        this.stopped = false;
        log.info("Yjs indexer starting");
        this.scanPromise = this.scanVault().catch(error => {
            log.error("failed to index Yjs state", errorContext(error));
        });
    }

    stop(): void {
        this.stopped = true;
        log.info("Yjs indexer stopping");
    }

    async waitForInitialScan(): Promise<void> {
        await this.scanPromise;
    }

    async ensureFile(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile) || file.extension !== "md" || this.shouldIgnorePath(file.path)) {
            return;
        }
        const content = await this.app.vault.read(file);
        const contentHash = await sha256Hex(new TextEncoder().encode(content));
        const cachedHash = await this.store.getContentHash(file.path);
        if (cachedHash === contentHash && await this.store.has(file.path)) {
            return;
        }
        const yjsState = docStateFromContent(content, Y);
        await this.store.putWithContentHash(file.path, yjsState, contentHash);
        await this.onIndexedChange({ path: file.path, content, yjsState, contentHash });
        log.debug("indexed Yjs state", { path: file.path, chars: content.length });
    }

    async delete(file: TAbstractFile): Promise<void> {
        await this.store.delete(file.path, file instanceof TFolder);
    }

    async rename(file: TAbstractFile, oldPath: string): Promise<void> {
        await this.store.rename(oldPath, file.path, file instanceof TFolder);
        await this.ensureFile(file);
    }

    private async scanVault(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles()
            .filter(file => !this.shouldIgnorePath(file.path))
            .sort((a, b) => a.path.localeCompare(b.path));
        let processed = 0;
        log.info("Yjs vault scan started", { files: files.length });

        for (const file of files) {
            if (this.stopped) {
                log.warn("Yjs vault scan stopped early", { processed, files: files.length });
                return;
            }
            await this.ensureFile(file);
            processed++;
            if (processed % BATCH_SIZE === 0) {
                await sleep(0);
            }
        }
        log.info("Yjs vault scan complete", { processed });
    }

}
