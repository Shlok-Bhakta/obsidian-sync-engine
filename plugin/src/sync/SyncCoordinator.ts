import { MarkdownView, Notice, normalizePath, type Editor, type Plugin, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import {
  MessageType,
  PROTOCOL_VERSION,
  compareRevisions,
  deserialize,
  serialize,
  shouldSyncVaultPath,
  type Mutation,
  type BootstrapManifest,
  type Revision,
  type WebSocketMessage,
} from "obsidian-sync-protocol";
import * as Y from "yjs";
import { BootstrapUploader } from "./BootstrapUploader";
import { HttpClient, SyncHttpError } from "./HttpClient";
import { MetadataStore, type ConflictRecord } from "./MetadataStore";
import { OutboxStore } from "./OutboxStore";
import { VaultMutator } from "./VaultMutator";
import { VaultScanner } from "./VaultScanner";
import { atomicWrite, atomicWriteBinary, sha256 } from "./storage";
import { DocumentSession } from "../yjs/DocumentSession";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { SyncStatus } from "../ui/SyncStatus";
import type { ConflictChoice } from "../ui/ConflictModal";
import { colorForIdentity, decodeRelativePosition, encodeRelativePosition, setRemotePresence } from "../presence/PresenceExtension";

export type CoordinatorSettings = {
  serverUrl: string;
  clientName: string;
  clientId: string;
  clientSecret: string;
  revision: Revision;
  vaultId: string;
  bootstrapStatus?: string;
  bootstrapUrl?: string;
  bootstrapExpiresAt?: string;
};

export class SyncCoordinator {
  readonly metadata: MetadataStore;
  readonly outbox: OutboxStore;
  readonly http: HttpClient;
  private readonly yjsStates: YjsStateStore;
  private readonly scanner: VaultScanner;
  private readonly mutator: VaultMutator;
  private readonly bootstrap: BootstrapUploader;
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly editorSessions = new Map<Editor, string>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private authenticated = false;
  private syncing = false;
  private syncAgain = false;
  private reconnectAttempt = 0;
  private scanTimer: number | null = null;
  private latestServerRevision: Revision = "0";
  private bootstrapInProgress = false;
  private presenceTimer: number | null = null;
  private presenceSent = false;
  private vaultEventQueue: Promise<void> = Promise.resolve();
  private readonly remotePresence = new Map<string, Extract<WebSocketMessage, { type: MessageType.PRESENCE_UPDATE }>>();

  constructor(
    private readonly plugin: Plugin,
    private readonly settings: CoordinatorSettings,
    private readonly saveSettings: () => Promise<void>,
    readonly status: SyncStatus,
  ) {
    const base = normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}`);
    this.metadata = new MetadataStore(plugin.app.vault.adapter, `${base}/sync-state/metadata.json`);
    this.outbox = new OutboxStore(plugin.app.vault.adapter, `${base}/outbox/index.json`, `${base}/outbox/payloads`);
    this.yjsStates = new YjsStateStore(plugin.app.vault.adapter, `${base}/yjs-state`);
    this.http = new HttpClient(() => this.settings);
    this.scanner = new VaultScanner(plugin.app.vault, this.metadata, this.outbox, this.yjsStates, plugin.manifest.id);
    this.mutator = new VaultMutator(plugin.app.vault, this.metadata, this.yjsStates, this.http);
    this.bootstrap = new BootstrapUploader(this.scanner, this.metadata, this.http, this.outbox);
  }

  async start(): Promise<void> {
    await this.metadata.load();
    await this.outbox.load();
    // The server is authoritative about whether an initial bootstrap is required.
    // Hold local scanning and mutation draining until the WebSocket auth response
    // has supplied that state.
    this.bootstrapInProgress = true;
    this.settings.revision = this.metadata.revision;
    await this.saveSettings();
    this.registerVaultEvents();
    this.plugin.registerInterval(window.setInterval(() => this.requestSync(), 30_000));
    this.plugin.registerInterval(window.setInterval(() => this.schedulePresence(), 10_000));
    this.plugin.registerDomEvent(activeDocument, "selectionchange", () => this.schedulePresence());
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.schedulePresence()));
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => { void this.reconcileEditorSessions(); }));
    if (!this.validServerUrl()) { this.status.set("offline", this.metadata.revision); return; }
    try {
      await this.ensureIdentity();
    } catch (error) {
      this.status.set("error", this.metadata.revision);
      new Notice(`Sync authentication needs attention: ${formatError(error)}`);
      return;
    }
    this.connectWebSocket();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    for (const session of this.sessions.values()) await this.yjsStates.save(session.fileId, session.doc);
    this.sessions.clear();
  }

  requestSync(): void {
    if (this.syncing) { this.syncAgain = true; return; }
    if (this.bootstrapInProgress || !this.settings.clientId || !this.settings.clientSecret || !this.validServerUrl()) return;
    void this.synchronize();
  }

  async retry(): Promise<void> {
    this.authenticated = false;
    this.ws?.close();
    try {
      await this.ensureIdentity();
    } catch (error) {
      this.status.set("error", this.metadata.revision);
      new Notice(`Sync authentication needs attention: ${formatError(error)}`);
      return;
    }
    this.connectWebSocket();
    this.requestSync();
  }

  private async ensureIdentity(): Promise<void> {
    if (this.settings.clientId && this.settings.clientSecret) {
      try {
        await this.http.changes(this.metadata.revision, 1);
        return;
      } catch (error) {
        if (!(error instanceof SyncHttpError) || error.status !== 401) throw error;
      }
    }

    const identity = await this.http.registerInitial(this.settings.clientName);
    this.settings.clientId = identity.clientId;
    this.settings.clientName = identity.displayName;
    this.settings.clientSecret = identity.clientSecret;
    await this.saveSettings();
  }

  async handleEditorChange(editor: Editor, file: TFile): Promise<void> {
    if (!file.path.toLowerCase().endsWith(".md") || !shouldSyncVaultPath(file.path, { configDir: this.plugin.app.vault.configDir, pluginId: this.plugin.manifest.id })) return;
    if (this.bootstrapInProgress) { this.scheduleScan(); return; }
    let metadata = this.metadata.fileByPath(file.path);
    if (!metadata) { this.scheduleScan(); return; }
    let session = this.sessions.get(metadata.fileId);
    if (!session) {
      session = new DocumentSession(metadata.fileId, metadata.path, metadata.revision, this.yjsStates, this.outbox);
      await session.open(await this.plugin.app.vault.read(file));
      this.sessions.set(metadata.fileId, session);
    }
    if (session.isApplyingRemote()) return;
    session.attach(editor);
    this.editorSessions.set(editor, metadata.fileId);
    await session.applyEditorText(editor.getValue());
    metadata = this.metadata.fileById(metadata.fileId)!;
    await this.metadata.putFile({ ...metadata, contentHash: await sha256(new TextEncoder().encode(editor.getValue())) });
    this.requestSync();
    this.schedulePresence();
  }

  async generateBootstrapZip(): Promise<void> {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Connect and authenticate before creating a bootstrap zip");
    this.send({
      type: MessageType.BOOTSTRAP_CREATE,
      vaultId: this.settings.vaultId,
      configDir: this.plugin.app.vault.configDir,
      pluginId: this.plugin.manifest.id,
    });
  }

  async resolveConflicts(choices: Map<string, ConflictChoice>): Promise<void> {
    if (await this.revalidateConflicts()) throw new Error("Server state changed while conflicts were open; review the refreshed rows");
    for (const record of [...this.metadata.conflicts]) {
      const choice = choices.get(record.localMutation.mutationId);
      if (!choice) continue;
      if (choice === "remote") await this.useRemote(record);
      else await this.useLocal(record);
      await this.metadata.clearConflict(record.localMutation.mutationId);
    }
    this.requestSync();
  }

  private registerVaultEvents(): void {
    const schedule = (path: string) => {
      if (!shouldSyncVaultPath(path, { configDir: this.plugin.app.vault.configDir, pluginId: this.plugin.manifest.id })) return;
      void this.mutator.consumeSuppression(path).then((suppressed) => { if (!suppressed) this.scheduleScan(); });
    };
    this.plugin.registerEvent(this.plugin.app.vault.on("create", (file) => schedule(file.path)));
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => schedule(file.path)));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => schedule(file.path)));
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
      this.vaultEventQueue = this.vaultEventQueue
        .then(() => this.handleVaultRename(file.path, oldPath))
        .catch((error: unknown) => { this.persistentFailure(error); });
    }));
  }

  private scheduleScan(): void {
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      if (this.bootstrapInProgress) { this.scheduleScan(); return; }
      void this.scanner.scan().then(() => this.requestSync()).catch((error) => this.persistentFailure(error));
    }, 150);
  }

  private connectWebSocket(): void {
    if (this.stopped || !this.validServerUrl()) return;
    this.ws?.close();
    const url = this.settings.serverUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "") + "/ws";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.send({
      type: MessageType.AUTH,
      clientId: this.settings.clientId,
      clientName: this.settings.clientName,
      credential: this.settings.clientSecret,
      protocolVersion: PROTOCOL_VERSION,
      lastAppliedRevision: this.metadata.revision,
    });
    ws.onmessage = (event) => { void this.handleSocketMessage(String(event.data)); };
    ws.onerror = () => this.status.set("offline", this.metadata.revision);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.authenticated = false;
      this.status.set("offline", this.metadata.revision);
      if (!this.stopped) {
        const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt) * (0.75 + Math.random() * 0.5);
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 8);
        window.setTimeout(() => this.connectWebSocket(), delay);
      }
    };
  }

  private async handleSocketMessage(raw: string): Promise<void> {
    let message: WebSocketMessage;
    try { message = deserialize(raw); }
    catch { this.persistentFailure(new Error("Server sent an invalid protocol message")); return; }
    if (message.type === MessageType.AUTH_SUCCESS) {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.latestServerRevision = message.currentServerRevision;
      this.status.set("syncing", this.metadata.revision);
      this.schedulePresence();
      try {
        if (message.bootstrapRequired) {
          this.bootstrapInProgress = true;
          const result = await this.bootstrap.run();
          if (!result.accepted) await this.reconcileLosingBootstrap();
        }
        this.bootstrapInProgress = false;
        await this.scanner.scan();
        this.requestSync();
      } catch (error) { this.persistentFailure(error); }
      return;
    }
    if (message.type === MessageType.REVISION_AVAILABLE) {
      this.latestServerRevision = message.latestServerRevision;
      this.requestSync();
    } else if (message.type === MessageType.PRESENCE_UPDATE && message.clientId && message.clientId !== this.settings.clientId) {
      this.remotePresence.set(message.clientId, message);
      this.renderPresence();
    } else if (message.type === MessageType.PRESENCE_LEAVE) {
      this.remotePresence.delete(message.clientId);
      this.renderPresence();
    } else if (message.type === MessageType.BOOTSTRAP_STATUS) {
      this.settings.bootstrapStatus = message.status;
      this.settings.bootstrapUrl = message.url;
      this.settings.bootstrapExpiresAt = message.expiresAt;
      await this.saveSettings();
      if (message.status === "failed") new Notice(message.safeMessage ?? "Bootstrap generation failed");
    } else if (message.type === MessageType.ERROR) {
      if (message.code === "PROTOCOL_MISMATCH" || message.code.startsWith("AUTH_")) {
        this.status.set("error", this.metadata.revision);
        new Notice(message.safeMessage);
        if (message.code === "PROTOCOL_MISMATCH") this.stopped = true;
      }
    }
  }

  private async synchronize(): Promise<void> {
    if (this.syncing) return;
    if (this.metadata.conflicts.length > 0) { this.status.set("conflict", this.metadata.revision); return; }
    this.syncing = true;
    this.status.set("syncing", this.metadata.revision);
    try {
      for (let cycle = 0; cycle < 100; cycle += 1) {
        await this.pullAll();
        if (this.metadata.conflicts.length > 0) { this.status.set("conflict", this.metadata.revision); return; }
        const entries = [...this.outbox.list()];
        if (entries.length > 0) await this.drain(entries);
        const current = await this.pullAll();
        if (this.metadata.conflicts.length > 0) { this.status.set("conflict", this.metadata.revision); return; }
        if (this.outbox.list().length === 0 && compareRevisions(this.metadata.revision, current) === 0) {
          this.status.set("up-to-date", this.metadata.revision);
          return;
        }
      }
      throw new Error("Sync did not stabilize after 100 reconciliation cycles");
    } catch (error) {
      this.persistentFailure(error);
    } finally {
      this.syncing = false;
      if (this.syncAgain) { this.syncAgain = false; this.requestSync(); }
    }
  }

  private async pullAll(): Promise<Revision> {
    let reported = this.latestServerRevision;
    for (;;) {
      const response = await this.http.changes(this.metadata.revision);
      reported = response.currentServerRevision;
      for (const event of response.changes) {
        const session = this.sessions.get(event.fileId);
        if (session && event.objectHash && event.path.toLowerCase().endsWith(".md") && event.clientId !== this.settings.clientId) {
          await session.applyRemoteUpdate(await this.http.downloadObject(event.objectHash));
          this.renderPresence();
        }
        await this.mutator.apply(event, this.settings.clientId);
        if (event.clientId === this.settings.clientId) {
          await this.outbox.acknowledge(event.mutationId);
          await this.outbox.rebaseFile(event.fileId, event.revision);
        }
      }
      if (!response.hasMore) break;
    }
    this.latestServerRevision = reported;
    this.settings.revision = this.metadata.revision;
    await this.saveSettings();
    return reported;
  }

  private async drain(entries: readonly { mutation: Mutation }[]): Promise<void> {
    for (const entry of entries) {
      const mutation = entry.mutation;
      await this.outbox.markInFlight(mutation.mutationId, true);
      try {
        if (mutation.objectHash && !(await this.http.hasObject(mutation.objectHash))) {
          await this.http.uploadObject(mutation.objectHash, await this.outbox.readPayload(mutation.objectHash));
        }
        const response = await this.http.mutate([mutation]);
        const conflict = response.conflicts[0];
        if (conflict) {
          await this.metadata.addConflict({ conflict, localMutation: mutation, detectedAt: new Date().toISOString() });
          await this.outbox.markInFlight(mutation.mutationId, false);
          return;
        }
        const accepted = response.accepted.find((result) => result.mutationId === mutation.mutationId);
        if (accepted) {
          await this.outbox.acknowledge(mutation.mutationId);
          await this.outbox.rebaseFile(mutation.fileId, accepted.revision);
        } else {
          await this.outbox.markInFlight(mutation.mutationId, false);
        }
      } catch (error) {
        await this.outbox.markInFlight(mutation.mutationId, false);
        throw error;
      }
    }
  }

  private async useRemote(record: ConflictRecord): Promise<void> {
    let local = this.metadata.fileById(record.localMutation.fileId);
    if (local) {
      if (record.conflict.fileId !== local.fileId) {
        await this.metadata.removeFile(local.fileId);
        const path = record.conflict.currentPath ?? record.conflict.path;
        local = {
          fileId: record.conflict.fileId,
          path,
          kind: path.toLowerCase().endsWith(".md") ? "markdown" : "blob",
          revision: record.conflict.currentRevision,
          contentHash: null,
          deleted: record.conflict.deleted,
        };
        await this.metadata.putFile(local);
      }
      await this.mutator.applyRemoteConflict(local, record.conflict.currentObjectHash, record.conflict.deleted, record.conflict.currentPath);
      await this.metadata.putFile({ ...this.metadata.fileById(local.fileId)!, revision: record.conflict.currentRevision });
    }
    await this.outbox.acknowledge(record.localMutation.mutationId);
  }

  private async handleVaultRename(path: string, oldPath: string): Promise<void> {
    const oldSuppressed = await this.mutator.consumeSuppression(oldPath);
    const newSuppressed = await this.mutator.consumeSuppression(path);
    if (oldSuppressed && newSuppressed) return;
    if (this.bootstrapInProgress) { this.scheduleScan(); return; }
    const metadata = this.metadata.fileByPath(oldPath);
    if (metadata) {
      await this.outbox.enqueue({
        mutationId: crypto.randomUUID(), operation: "rename", fileId: metadata.fileId,
        path: oldPath, destinationPath: path, baseRevision: metadata.revision,
      });
      await this.metadata.putFile({ ...metadata, path });
    }
    this.scheduleScan();
  }

  private async reconcileLosingBootstrap(): Promise<void> {
    const manifest = this.metadata.bootstrapManifest as BootstrapManifest | undefined;
    if (!manifest) { await this.pullAll(); return; }
    const payloads = new Map<string, Uint8Array>();
    for (const entry of manifest.entries) payloads.set(entry.objectHash, await this.outbox.readPayload(entry.objectHash));
    for (const entry of manifest.entries) await this.metadata.removeFile(entry.fileId);
    await this.pullAll();
    for (const entry of manifest.entries) {
      const payload = payloads.get(entry.objectHash)!;
      if (entry.kind === "blob") {
        await atomicWriteBinary(this.plugin.app.vault.adapter, entry.path, payload.slice().buffer);
      } else {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload);
        await atomicWrite(this.plugin.app.vault.adapter, entry.path, doc.getText("content").toJSON());
      }
    }
    await this.metadata.setBootstrap(undefined);
    await this.scanner.scan();
  }

  private async revalidateConflicts(): Promise<boolean> {
    let since = this.metadata.revision;
    let changed = false;
    for (;;) {
      const response = await this.http.changes(since);
      for (const event of response.changes) {
        since = event.revision;
        const record = this.metadata.conflicts.find((item) =>
          item.conflict.fileId === event.fileId || item.conflict.blockingFileId === event.fileId,
        );
        if (!record) continue;
        if (record.conflict.blockingFileId === event.fileId) {
          if (BigInt(event.revision) <= BigInt(record.conflict.blockingRevision ?? "0")) continue;
          await this.metadata.replaceConflict({
            ...record,
            conflict: {
              ...record.conflict,
              blockingRevision: event.revision,
              blockingPath: event.operation === "rename" ? event.destinationPath ?? record.conflict.blockingPath : event.path,
              blockingObjectHash: event.objectHash ?? record.conflict.blockingObjectHash,
              blockingDeleted: event.operation === "delete",
            },
          });
          changed = true;
          continue;
        }
        if (BigInt(event.revision) <= BigInt(record.conflict.currentRevision)) continue;
        const currentPath = event.operation === "rename" ? event.destinationPath ?? record.conflict.currentPath : event.path;
        await this.metadata.replaceConflict({
          ...record,
          conflict: {
            ...record.conflict,
            currentRevision: event.revision,
            currentPath: currentPath ?? undefined,
            currentObjectHash: event.objectHash ?? record.conflict.currentObjectHash,
            deleted: event.operation === "delete",
          },
        });
        changed = true;
      }
      if (!response.hasMore) break;
    }
    return changed;
  }

  private async useLocal(record: ConflictRecord): Promise<void> {
    const original = record.localMutation;
    const replacements: Array<{ mutation: Mutation; payload?: Uint8Array }> = [];
    if (record.conflict.code === "PATH_OCCUPIED" && record.conflict.currentPath) {
      replacements.push({ mutation: {
        mutationId: crypto.randomUUID(), operation: "delete", fileId: record.conflict.blockingFileId ?? record.conflict.fileId,
        path: record.conflict.blockingPath ?? record.conflict.currentPath,
        baseRevision: record.conflict.blockingRevision ?? record.conflict.currentRevision,
      } });
    }
    let replacement: Mutation = { ...original, mutationId: crypto.randomUUID(), baseRevision: record.conflict.currentRevision };
    let payload: Uint8Array | undefined;
    if (original.operation === "update" || original.operation === "create") {
      const path = original.path;
      payload = original.objectHash
        ? await this.outbox.readPayload(original.objectHash)
        : new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path));
      const objectHash = await sha256(payload);
      replacement = { ...replacement, objectHash };
      const metadata = this.metadata.fileById(original.fileId);
      if (metadata?.kind === "blob") {
        await atomicWriteBinary(this.plugin.app.vault.adapter, path, payload.slice().buffer);
        await this.metadata.putFile({ ...metadata, contentHash: objectHash, deleted: false });
      } else if (original.operation === "create" && metadata?.kind === "markdown") {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload);
        const text = doc.getText("content").toJSON();
        await this.yjsStates.save(metadata.fileId, doc);
        await atomicWrite(this.plugin.app.vault.adapter, path, text);
        await this.metadata.putFile({ ...metadata, contentHash: await sha256(new TextEncoder().encode(text)), deleted: false });
      }
    }
    replacements.push({ mutation: replacement, payload });
    await this.outbox.replaceWith(original.mutationId, replacements);
  }

  private schedulePresence(): void {
    if (this.presenceTimer !== null) return;
    this.presenceTimer = window.setTimeout(() => {
      this.presenceTimer = null;
      void this.sendActivePresence();
    }, 50);
  }

  private async sendActivePresence(): Promise<void> {
    if (!this.authenticated) return;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file) {
      if (this.presenceSent) this.send({ type: MessageType.PRESENCE_LEAVE, clientId: this.settings.clientId });
      this.presenceSent = false;
      return;
    }
    const metadata = this.metadata.fileByPath(file.path);
    if (!metadata) return;
    let session = this.sessions.get(metadata.fileId);
    if (!session) {
      session = new DocumentSession(metadata.fileId, metadata.path, metadata.revision, this.yjsStates, this.outbox);
      await session.open(view.editor.getValue());
      session.attach(view.editor);
      this.sessions.set(metadata.fileId, session);
    }
    const anchor = view.editor.posToOffset(view.editor.getCursor("anchor"));
    const head = view.editor.posToOffset(view.editor.getCursor("head"));
    this.send({
      type: MessageType.PRESENCE_UPDATE,
      fileId: metadata.fileId,
      path: metadata.path,
      anchor: encodeRelativePosition(session.text, anchor),
      head: encodeRelativePosition(session.text, head),
      name: this.settings.clientName,
      color: colorForIdentity(this.settings.clientId, activeDocument.body.classList.contains("theme-dark")),
    });
    this.presenceSent = true;
    this.renderPresence();
  }

  private renderPresence(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file) return;
    const metadata = this.metadata.fileByPath(file.path);
    const session = metadata ? this.sessions.get(metadata.fileId) : undefined;
    const codeMirror = (view.editor as Editor & { cm?: EditorView }).cm;
    if (!metadata || !session || !codeMirror) return;
    const states = [...this.remotePresence.values()]
      .filter((state) => state.fileId === metadata.fileId)
      .flatMap((state) => {
        const anchor = decodeRelativePosition(state.anchor, session.doc);
        const head = decodeRelativePosition(state.head, session.doc);
        return anchor === null || head === null || !state.clientId ? [] : [{ clientId: state.clientId, name: state.name, color: state.color, anchor, head }];
      });
    codeMirror.dispatch({ effects: setRemotePresence.of(states) });
  }

  private async reconcileEditorSessions(): Promise<void> {
    const activeEditors = new Set<Editor>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) activeEditors.add(leaf.view.editor);
    }
    for (const [editor, fileId] of [...this.editorSessions]) {
      if (activeEditors.has(editor)) continue;
      this.editorSessions.delete(editor);
      const session = this.sessions.get(fileId);
      if (session && await session.detach(editor)) this.sessions.delete(fileId);
    }
  }

  private send(message: WebSocketMessage): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(serialize(message)); }
  private validServerUrl(): boolean { try { return ["http:", "https:"].includes(new URL(this.settings.serverUrl).protocol); } catch { return false; } }
  private persistentFailure(error: unknown): void { console.error("Obsidian sync failure", error); this.status.set("error", this.metadata.revision); }
}

function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
