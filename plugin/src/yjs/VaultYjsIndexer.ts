import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import * as Y from "yjs";
import { docStateFromContent } from "../../../shared/yjsSeed";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { YjsStateStore } from "./YjsStateStore";

const BATCH_SIZE = 25;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

export class VaultYjsIndexer {
    private stopped = false;
    private scanPromise: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly store: YjsStateStore,
        private readonly shouldIgnorePath: (path: string) => boolean,
    ) {}

    start(): void {
        this.stopped = false;
        this.scanPromise = this.scanVault().catch(error => {
            console.error("failed to index Yjs state", error);
        });
    }

    stop(): void {
        this.stopped = true;
    }

    async waitForInitialScan(): Promise<void> {
        await this.scanPromise;
    }

    async ensureFile(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile) || file.extension !== "md" || this.shouldIgnorePath(file.path)) {
            return;
        }
        const content = await this.app.vault.read(file);
        const state = await this.store.get(file.path);
        if (state && this.contentFromState(state) === content) {
            return;
        }
        await this.store.put(file.path, docStateFromContent(content, Y));
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

        for (const file of files) {
            if (this.stopped) {
                return;
            }
            await this.ensureFile(file);
            processed++;
            if (processed % BATCH_SIZE === 0) {
                await sleep(0);
            }
        }
    }

    private contentFromState(state: Uint8Array): string {
        const doc = new Y.Doc();
        Y.applyUpdateV2(doc, state);
        const content = doc.getText(MARKDOWN_FIELD).toJSON();
        doc.destroy();
        return content;
    }
}
