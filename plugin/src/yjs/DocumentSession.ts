import type { Editor } from "obsidian";
import * as Y from "yjs";
import type { Revision } from "obsidian-sync-protocol";
import type { OutboxStore } from "../sync/OutboxStore";
import { sha256 } from "../sync/storage";
import type { YjsStateStore } from "./YjsStateStore";

const LOCAL_ORIGIN = Symbol("local-editor");
const REMOTE_ORIGIN = Symbol("remote-sync");

export class DocumentSession {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  private editors = new Set<Editor>();
  private saveTimer: number | null = null;
  private applyingRemote = false;
  private operation = Promise.resolve();

  constructor(
    readonly fileId: string,
    private path: string,
    private baseRevision: Revision,
    private readonly stateStore: YjsStateStore,
    private readonly outbox: OutboxStore,
  ) {}

  async open(localText: string, serverState?: Uint8Array): Promise<void> {
    const persisted = await this.stateStore.load(this.fileId);
    if (persisted) Y.applyUpdate(this.doc, persisted, REMOTE_ORIGIN);
    else if (serverState) Y.applyUpdate(this.doc, serverState, REMOTE_ORIGIN);
    else if (localText) this.text.insert(0, localText);
    if (this.text.toJSON() !== localText) await this.applyEditorText(localText, "external-open");
    await this.stateStore.save(this.fileId, this.doc);
  }

  attach(editor: Editor): void { this.editors.add(editor); }

  async detach(editor: Editor): Promise<boolean> {
    this.editors.delete(editor);
    if (this.editors.size === 0) {
      if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
      await this.stateStore.save(this.fileId, this.doc);
      this.doc.destroy();
      return true;
    }
    return false;
  }

  isApplyingRemote(): boolean { return this.applyingRemote; }
  updatePath(path: string): void { this.path = path; }
  updateRevision(revision: Revision): void { this.baseRevision = revision; }

  async applyEditorText(next: string, origin: "editor" | "external-open" = "editor"): Promise<void> {
    this.operation = this.operation.then(async () => {
      const current = this.text.toJSON();
      if (current === next) return;
      const change = smallestChange(current, next);
      let update: Uint8Array | null = null;
      const listener = (value: Uint8Array, eventOrigin: unknown) => { if (eventOrigin === LOCAL_ORIGIN) update = value; };
      this.doc.on("update", listener);
      this.doc.transact(() => {
        if (change.deleteCount) this.text.delete(change.from, change.deleteCount);
        if (change.insert) this.text.insert(change.from, change.insert);
      }, LOCAL_ORIGIN);
      this.doc.off("update", listener);
      if (update) {
        const objectHash = await sha256(update);
        await this.outbox.enqueue({
          mutationId: crypto.randomUUID(), operation: "yjs_update", fileId: this.fileId,
          path: this.path, baseRevision: this.baseRevision, objectHash,
        }, update);
      }
      if (origin === "editor") this.scheduleSave();
      else await this.stateStore.save(this.fileId, this.doc);
    });
    await this.operation;
  }

  async applyRemoteUpdate(update: Uint8Array): Promise<string> {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
    const next = this.text.toJSON();
    this.applyingRemote = true;
    try {
      for (const editor of this.editors) {
        const current = editor.getValue();
        if (current === next) continue;
        const change = smallestChange(current, next);
        editor.replaceRange(change.insert, editor.offsetToPos(change.from), editor.offsetToPos(change.from + change.deleteCount));
      }
    } finally {
      this.applyingRemote = false;
    }
    await this.stateStore.save(this.fileId, this.doc);
    return next;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.stateStore.save(this.fileId, this.doc);
    }, 500);
  }
}

export function smallestChange(before: string, after: string): { from: number; deleteCount: number; insert: string } {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;
  return { from: prefix, deleteCount: before.length - prefix - suffix, insert: after.slice(prefix, after.length - suffix) };
}
