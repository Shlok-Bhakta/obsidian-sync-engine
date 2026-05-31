import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { JsonlOutboxStore, OutboxStore } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { BootstrapStatus, EditorPresence, EditorPresencePosition, outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
import { SyncClient } from 'sync/SyncClient';
import { editorViewFor, fileForEditorView } from 'utils/editorFile';
import { YjsStateStore } from 'yjs/YjsStateStore';
import { VaultYjsIndexer } from 'yjs/VaultYjsIndexer';
import { docStateFromContent } from "../../shared/yjsSeed";
import { isPluginInternalPath, shouldSyncPath, shouldUseYjs } from "../../shared/pathPolicy";
import { errorContext } from "../../shared/logger";
import { log } from "./logger";

const INLINE_BYTES_LIMIT = 16 * 1024;
const CONFIG_DIR_POLL_MS = Platform.isMobile ? 30_000 : 2000;
type ConfigDirScanMode = "baseline" | "enqueue";
type BootVaultEntry = {
	isFolder: boolean;
	fingerprint: string | null;
};
type PreStartupLocalEvent = {
	path: string;
	isFolder: boolean;
	kind: "create" | "modify";
};
type RemoteEditorPresence = EditorPresence & {
	updatedAt: number;
};
type PresenceLayer = {
	el: HTMLElement;
	view: EditorView;
	scrollHandler: () => void;
};

function generateClientId(): string {
	return "obs_client_" + crypto.randomUUID();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function changedRange(before: string, after: string): { from: number; to: number; insert: string } | null {
	if (before === after) {
		return null;
	}
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
		prefix++;
	}
	let beforeSuffix = before.length;
	let afterSuffix = after.length;
	while (
		beforeSuffix > prefix &&
		afterSuffix > prefix &&
		before.charCodeAt(beforeSuffix - 1) === after.charCodeAt(afterSuffix - 1)
	) {
		beforeSuffix--;
		afterSuffix--;
	}
	return {
		from: prefix,
		to: beforeSuffix,
		insert: after.slice(prefix, afterSuffix),
	};
}

function mapPositionThroughReplacement(position: number, from: number, to: number, insertLength: number): number {
	if (position <= from) {
		return position;
	}
	if (position >= to) {
		return position + insertLength - (to - from);
	}
	return from + insertLength;
}

function parseRgb(value: string): { r: number; g: number; b: number } | null {
	const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const raw = hex[1] ?? "";
		const full = raw.length === 3 ? raw.split("").map(char => char + char).join("") : raw;
		return {
			r: Number.parseInt(full.slice(0, 2), 16),
			g: Number.parseInt(full.slice(2, 4), 16),
			b: Number.parseInt(full.slice(4, 6), 16),
		};
	}
	const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
	if (!rgb) {
		return null;
	}
	return {
		r: Math.max(0, Math.min(255, Number(rgb[1]))),
		g: Math.max(0, Math.min(255, Number(rgb[2]))),
		b: Math.max(0, Math.min(255, Number(rgb[3]))),
	};
}

function resolveCssColor(value: string): { r: number; g: number; b: number } | null {
	if (typeof document === "undefined") {
		return null;
	}
	const probe = document.createElement("span");
	probe.style.color = value;
	document.body.appendChild(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	return parseRgb(resolved);
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l };
	}
	const delta = max - min;
	const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	const h = max === red
		? (green - blue) / delta + (green < blue ? 6 : 0)
		: max === green
			? (blue - red) / delta + 2
			: (red - green) / delta + 4;
	return { h: h * 60, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
	const m = l - chroma / 2;
	const [red, green, blue] =
		h < 60 ? [chroma, x, 0] :
		h < 120 ? [x, chroma, 0] :
		h < 180 ? [0, chroma, x] :
		h < 240 ? [0, x, chroma] :
		h < 300 ? [x, 0, chroma] :
		[chroma, 0, x];
	return {
		r: Math.round((red + m) * 255),
		g: Math.round((green + m) * 255),
		b: Math.round((blue + m) * 255),
	};
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
	return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function presenceColorForName(clientName: string): string {
	const accentValue = getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
	const accent = resolveCssColor(accentValue || "rgb(124, 58, 237)") ?? { r: 124, g: 58, b: 237 };
	const base = rgbToHsl(accent);
	const hue = hashString(clientName.trim() || "Peer") % 360;
	const color = hslToRgb(hue, Math.max(0.55, base.s), Math.max(0.38, Math.min(0.68, base.l)));
	return rgbToHex(color);
}

function textColorForBackground(color: string): string {
	const rgb = parseRgb(color) ?? resolveCssColor(color) ?? { r: 0, g: 0, b: 0 };
	const linear = [rgb.r, rgb.g, rgb.b].map(channel => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
	return luminance > 0.48 ? "#000000" : "#ffffff";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
	return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export default class SyncEngine extends Plugin {
	settings: SyncEngineSettings;
	db: OutboxStore;
	docs: Map<Path, DocSync>;
	pendingDocs: Map<Path, Promise<DocSync>>;
	editorChangeQueues: Map<Path, Promise<void>>;
	pruningDocs: Set<Path>;
	yjsStateStore: YjsStateStore;
	yjsIndexer: VaultYjsIndexer;
	syncClient: SyncClient;
	bootstrapStatus: BootstrapStatus | null = null;
	private bootstrapStatusBarEl: HTMLElement | null = null;
	private bootstrapStatusListeners: Set<() => void> = new Set();
	private pendingFileTimers: Map<Path, number> = new Map();
	private configDirStats: Map<Path, string> = new Map();
	private remoteEditorDispatches: Set<EditorView> = new Set();
	private configDirPollerStarted = false;
	private yjsIndexerStarted = false;
	private startupSyncCompleted = false;
	private bootVaultEntries = new Map<Path, BootVaultEntry>();
	private preStartupLocalEvents = new Map<Path, PreStartupLocalEvent>();
	/** Content hashes of syncable config files on disk before the first startup pull. */
	private bootConfigSha = new Map<Path, string>();
	/** Last config file bytes applied from the server during startup/live pull. */
	private serverConfigBytes = new Map<Path, Uint8Array>();
	private serverConfigSha = new Map<Path, string>();
	private readonly remoteEditorPresences = new Map<string, RemoteEditorPresence>();
	private remotePresenceLayer: PresenceLayer | null = null;
	private presenceRenderFrame: number | null = null;
	private lastSentPresenceKey = "";
	private localPresenceColor = "#7c3aed";
	async onload() {
		await this.loadSettings();
		this.cleanupStalePresenceDom();
		log.info("plugin loading", {
			vaultName: this.app.vault.getName(),
			configDir: this.app.vault.configDir,
			clientId: this.settings.clientId.slice(0, 18),
			clientName: this.settings.clientName,
			lastPulledRevision: this.settings.lastPulledRevision,
		});
		this.db = new JsonlOutboxStore(this.app, this.manifest);
		this.yjsStateStore = new YjsStateStore(this.app, this.manifest);
		this.docs = new Map<Path, DocSync>();
		this.pendingDocs = new Map<Path, Promise<DocSync>>();
		this.editorChangeQueues = new Map<Path, Promise<void>>();
		this.pruningDocs = new Set<Path>();
		this.localPresenceColor = presenceColorForName(this.settings.clientName);
		await this.db.open();
		await this.yjsStateStore.open();
		this.bootstrapStatusBarEl = this.addStatusBarItem();
		this.bootstrapStatusBarEl.addClass("sync-engine-bootstrap-statusbar");
		this.renderBootstrapStatusBar();
		await Promise.all([
			this.captureBootConfigShas(),
			this.captureBootVaultEntries(),
		]);
		this.yjsIndexer = new VaultYjsIndexer(
			this.app,
			this.yjsStateStore,
			(path) => !shouldUseYjs(path, this.app.vault.configDir) || this.isPluginInternalPath(path),
			async (change) => {
				await this.queueIndexedMarkdownChange(change.path, change.content, change.yjsState);
			},
		);
		this.syncClient = new SyncClient(
			this.app,
			this.db,
			this.yjsStateStore,
			this.settings,
			async (clientKey) => {
				this.settings = {
					...this.settings,
					clientKey,
				};
				await this.saveSettings();
			},
			async (revision) => {
				this.settings = {
					...this.settings,
					lastPulledRevision: revision,
				};
				await this.saveSettings();
			},
			(path) => this.docs.get(path),
			(status) => this.setBootstrapStatus(status),
			() => {
				this.startupSyncCompleted = true;
				void this.flushDeferredPreStartupLocalEvents();
				this.startConfigDirPoller();
				if (!Platform.isMobile) {
					this.startYjsIndexer();
				}
			},
			(path, bytes) => {
				void this.recordRemoteConfigApplied(path, bytes);
			},
			() => {
				new Notice("Plugin files updated. Reload Obsidian.");
			},
			(path, content) => this.applyRemoteYjsContentToOpenEditors(path, content),
			(path) => this.flushEditorChangeQueue(path),
			(presence) => this.setRemoteEditorPresence(presence),
			(clientId) => this.removeRemoteEditorPresence(clientId),
			() => this.clearRemoteEditorPresences(),
			this.manifest.id,
		);
		this.app.workspace.onLayoutReady(() => {
			log.info("workspace ready; starting sync client");
			this.syncClient.start();
		});

		this.registerEvent(this.app.workspace.on("layout-change", () => {
			void this.pruneClosedDocs();
			this.scheduleRemotePresenceRender();
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			this.scheduleRemotePresenceRender();
		}));
		this.registerEvent(this.app.vault.on("create", file => {
			log.debug("vault create event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.enqueueLocalCreate(file).catch(error => {
				log.error("failed to enqueue local create", { path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
		}));
		this.registerEvent(this.app.vault.on("modify", file => {
			log.debug("vault modify event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.queueExternalMarkdownChange(file).catch(error => {
				log.error("failed to enqueue markdown modify", { path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.queueNonMarkdownUpsert(file);
		}));
		this.registerEvent(this.app.vault.on("delete", file => {
			log.info("vault delete event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.enqueueLocalDelete(file).catch(error => {
				log.error("failed to enqueue local delete", { path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.yjsIndexer.delete(file);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			log.info("vault rename event", { oldPath, path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.enqueueLocalRename(file, oldPath).catch(error => {
				log.error("failed to enqueue local rename", { oldPath, path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.yjsIndexer.rename(file, oldPath);
		}));

		this.addSettingTab(new SyncEngineSettingTab(this.app, this));
		this.registerEditorExtension(this.makeEditorOutboxExtension());
		this.registerEditorExtension(this.makeEditorPresenceSenderExtension());
		this.registerDomEvent(window, "resize", () => this.scheduleRemotePresenceRender());
	}

	private makeEditorOutboxExtension(){
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (this.remoteEditorDispatches.has(update.view)) {
				return;
			}
			if (!update.docChanged) {
				return;
			}
			const file = fileForEditorView(this.app, update.view);
			if (!file) {
				return;
			}
			const pathID = file.path;
			if (this.syncClient?.isApplyingRemoteChanges(pathID)) {
				return;
			}
			if (!shouldUseYjs(pathID, this.app.vault.configDir)) {
				return;
			}
			this.queueEditorChange(update, pathID);
		});
	}

	private makeEditorPresenceSenderExtension() {
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (this.remoteEditorDispatches.has(update.view)) {
				return;
			}
			if (!update.selectionSet) {
				return;
			}
			this.sendActiveEditorPresence();
		});
	}

	private sendActiveEditorPresence(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) {
			return;
		}
		this.localPresenceColor = presenceColorForName(this.settings.clientName);
		const positions = {
			from: view.editor.getCursor("from"),
			to: view.editor.getCursor("to"),
			head: view.editor.getCursor("head"),
			anchor: view.editor.getCursor("anchor"),
		};
		const presenceKey = JSON.stringify({
			path: view.file.path,
			...positions,
			color: this.localPresenceColor,
		});
		if (presenceKey === this.lastSentPresenceKey) {
			return;
		}
		this.lastSentPresenceKey = presenceKey;
		this.syncClient.sendEditorPresence(
			view.file.path,
			positions,
			this.localPresenceColor,
		);
	}

	private setRemoteEditorPresence(presence: EditorPresence): void {
		this.remoteEditorPresences.set(presence.clientId, {
			...presence,
			updatedAt: Date.now(),
		});
		this.scheduleRemotePresenceRender();
	}

	private removeRemoteEditorPresence(clientId: string): void {
		if (!this.remoteEditorPresences.delete(clientId)) {
			return;
		}
		this.scheduleRemotePresenceRender();
	}

	private clearRemoteEditorPresences(): void {
		this.remoteEditorPresences.clear();
		this.removePresenceLayer();
	}

	private scheduleRemotePresenceRender(): void {
		if (this.presenceRenderFrame !== null) {
			return;
		}
		this.presenceRenderFrame = requestAnimationFrame(() => {
			this.presenceRenderFrame = null;
			this.renderRemoteEditorPresences();
		});
	}

	private renderRemoteEditorPresences(): void {
		this.cleanupStalePresenceDom();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editorView = view ? editorViewFor(view.editor) : null;
		const activePath = view?.file?.path;
		if (!editorView || !activePath) {
			this.removePresenceLayer();
			return;
		}
		const presences = [...this.remoteEditorPresences.values()]
			.filter(presence => presence.path === activePath);
		if (presences.length === 0) {
			this.removePresenceLayer();
			return;
		}
		const layer = this.ensurePresenceLayer(editorView);
		this.sizePresenceLayer(layer, editorView);
		layer.replaceChildren();
		for (const presence of presences) {
			this.renderRemoteSelection(layer, editorView, presence);
			this.renderRemoteCursor(layer, editorView, presence);
		}
	}

	private ensurePresenceLayer(editorView: EditorView): HTMLElement {
		if (
			this.remotePresenceLayer?.view === editorView &&
			this.remotePresenceLayer.el.parentElement === editorView.scrollDOM
		) {
			return this.remotePresenceLayer.el;
		}
		this.removePresenceLayer();
		const layer = document.createElement("div");
		layer.addClass("sync-engine-presence-layer");
		const scrollHandler = () => this.scheduleRemotePresenceRender();
		editorView.scrollDOM.addEventListener("scroll", scrollHandler, { passive: true });
		editorView.scrollDOM.appendChild(layer);
		this.remotePresenceLayer = { el: layer, view: editorView, scrollHandler };
		return layer;
	}

	private sizePresenceLayer(layer: HTMLElement, editorView: EditorView): void {
		layer.style.width = `${Math.max(editorView.scrollDOM.scrollWidth, editorView.scrollDOM.clientWidth)}px`;
		layer.style.height = `${Math.max(editorView.scrollDOM.scrollHeight, editorView.scrollDOM.clientHeight)}px`;
	}

	private cleanupStalePresenceDom(): void {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".sync-engine-presence-layer"))) {
			if (el !== this.remotePresenceLayer?.el) {
				el.remove();
			}
		}
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".sync-engine-remote-cursor, .sync-engine-remote-selection"))) {
			if (!el.closest(".sync-engine-presence-layer")) {
				el.remove();
			}
		}
	}

	private removePresenceLayer(): void {
		if (!this.remotePresenceLayer) {
			return;
		}
		this.remotePresenceLayer.view.scrollDOM.removeEventListener("scroll", this.remotePresenceLayer.scrollHandler);
		this.remotePresenceLayer.el.remove();
		this.remotePresenceLayer = null;
	}

	private renderRemoteSelection(layer: HTMLElement, editorView: EditorView, presence: RemoteEditorPresence): void {
		const from = this.editorOffsetForPosition(editorView, presence.from);
		const to = this.editorOffsetForPosition(editorView, presence.to);
		if (from === to) {
			return;
		}
		const startOffset = Math.min(from, to);
		const endOffset = Math.max(from, to);
		for (const visible of editorView.visibleRanges) {
			const visibleStart = Math.max(startOffset, visible.from);
			const visibleEnd = Math.min(endOffset, visible.to);
			if (visibleStart >= visibleEnd) {
				continue;
			}
			this.renderRemoteSelectionSegment(layer, editorView, presence, visibleStart, visibleEnd);
		}
	}

	private renderRemoteSelectionSegment(
		layer: HTMLElement,
		editorView: EditorView,
		presence: RemoteEditorPresence,
		from: number,
		to: number,
	): void {
		let range: Range;
		try {
			const start = editorView.domAtPos(from);
			const end = editorView.domAtPos(to);
			range = document.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
		} catch {
			return;
		}
		const scrollRect = editorView.scrollDOM.getBoundingClientRect();
		for (const rect of Array.from(range.getClientRects())) {
			if (rect.width <= 0 || rect.height <= 0) {
				continue;
			}
			const highlight = document.createElement("div");
			highlight.addClass("sync-engine-remote-selection");
			highlight.style.setProperty("--sync-engine-presence-color", presence.color);
			highlight.style.left = `${rect.left - scrollRect.left + editorView.scrollDOM.scrollLeft}px`;
			highlight.style.top = `${rect.top - scrollRect.top + editorView.scrollDOM.scrollTop}px`;
			highlight.style.width = `${rect.width}px`;
			highlight.style.height = `${rect.height}px`;
			layer.appendChild(highlight);
		}
	}

	private renderRemoteCursor(layer: HTMLElement, editorView: EditorView, presence: RemoteEditorPresence): void {
		const offset = this.editorOffsetForPosition(editorView, presence.head);
		const coords = editorView.coordsAtPos(offset);
		if (!coords) {
			return;
		}
		const scrollRect = editorView.scrollDOM.getBoundingClientRect();
		const left = coords.left - scrollRect.left + editorView.scrollDOM.scrollLeft;
		const top = coords.top - scrollRect.top + editorView.scrollDOM.scrollTop;
		const cursor = document.createElement("div");
		cursor.addClass("sync-engine-remote-cursor");
		cursor.style.setProperty("--sync-engine-presence-color", presence.color);
		cursor.style.setProperty("--sync-engine-presence-foreground", textColorForBackground(presence.color));
		cursor.style.left = `${left}px`;
		cursor.style.top = `${top}px`;
		cursor.style.height = `${Math.max(14, coords.bottom - coords.top)}px`;
		const tag = document.createElement("div");
		tag.addClass("sync-engine-remote-cursor__tag");
		tag.textContent = presence.clientName || "Peer";
		cursor.appendChild(tag);
		layer.appendChild(cursor);
		this.fitPresenceTag(editorView, cursor, tag, left, top);
	}

	private fitPresenceTag(
		editorView: EditorView,
		cursor: HTMLElement,
		tag: HTMLElement,
		cursorLeft: number,
		cursorTop: number,
	): void {
		const visibleLeft = editorView.scrollDOM.scrollLeft + 6;
		const visibleRight = editorView.scrollDOM.scrollLeft + editorView.scrollDOM.clientWidth - 6;
		const width = tag.offsetWidth;
		let tagLeft = 0;
		if (cursorLeft + width > visibleRight) {
			tagLeft = visibleRight - cursorLeft - width;
		}
		if (cursorLeft + tagLeft < visibleLeft) {
			tagLeft = visibleLeft - cursorLeft;
		}
		tag.style.left = `${tagLeft}px`;
		if (cursorTop - tag.offsetHeight - 2 < editorView.scrollDOM.scrollTop) {
			cursor.addClass("sync-engine-remote-cursor--tag-below");
		}
	}

	private editorOffsetForPosition(editorView: EditorView, position: EditorPresencePosition): number {
		const lineNumber = Math.max(1, Math.min(editorView.state.doc.lines, position.line + 1));
		const lineInfo = editorView.state.doc.line(lineNumber);
		return Math.max(lineInfo.from, Math.min(lineInfo.to, lineInfo.from + position.ch));
	}

	private queueEditorChange(update: ViewUpdate, pathID: Path): void {
		const previous = this.editorChangeQueues.get(pathID) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => this.handleEditorChange(update, pathID))
			.catch(error => {
				log.error("failed to process editor change", { path: pathID, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			})
			.finally(() => {
				if (this.editorChangeQueues.get(pathID) === next) {
					this.editorChangeQueues.delete(pathID);
				}
			});
		this.editorChangeQueues.set(pathID, next);
	}

	private async handleEditorChange(update: ViewUpdate, pathID: Path): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(pathID)) {
			return;
		}
		const doc = await this.getOrCreateDoc(pathID, update.startState.doc.toString());
		const row: outboxData = {
			mutationId: crypto.randomUUID(),
			operation: "YjsUpdate",
			path: pathID,
			data: new Uint8Array(),
			created: Date.now(),
		};
		await doc.applyChanges(update.changes, row, (error) => {
			log.error("failed to enqueue editor Yjs update", { path: pathID, mutationId: row.mutationId, ...errorContext(error) });
			new Notice(`Sync outbox write failed: ${error.message}`);
		}, update.startState.doc.toString(), update.state.doc.toString());
		log.debug("queued editor Yjs update", { path: pathID, mutationId: row.mutationId });
		this.syncClient.wakeSoon();
	}

	private async flushEditorChangeQueue(pathID: Path): Promise<void> {
		await (this.editorChangeQueues.get(pathID) ?? Promise.resolve());
	}

	private getOrCreateDoc(pathID: Path, initialContent: string): Promise<DocSync> {
		const existing = this.docs.get(pathID);
		if (existing) {
			return Promise.resolve(existing);
		}
		const pending = this.pendingDocs.get(pathID);
		if (pending) {
			return pending;
		}
		const created = this.newDoc(pathID, initialContent).finally(() => {
			this.pendingDocs.delete(pathID);
		});
		this.pendingDocs.set(pathID, created);
		return created;
	}

	private async newDoc(pathID: Path, initialContent: string): Promise<DocSync> {
		const contentHash = await sha256Hex(new TextEncoder().encode(initialContent));
		const cachedHash = await this.yjsStateStore.getContentHash(pathID);
		let initialState = await this.yjsStateStore.get(pathID);
		let initialServerSyncedState = false;
		if (!initialState || cachedHash !== contentHash) {
			initialState = docStateFromContent(initialContent, Y);
			await this.yjsStateStore.putWithContentHash(
				pathID,
				initialState,
				contentHash,
			);
			log.debug("seeded Yjs state for open document", { path: pathID, chars: initialContent.length });
		} else {
			const metadata = await this.yjsStateStore.getMetadata?.(pathID);
			initialServerSyncedState = metadata?.serverSynced === true;
		}
		const dsync = new DocSync(this.db, this.yjsStateStore, pathID, initialState, initialServerSyncedState);
		this.docs.set(pathID, dsync);
		log.debug("created DocSync", { path: pathID });
		return dsync;
	}

	private async enqueueLocalDelete(file: TAbstractFile): Promise<void> {
		this.cancelPendingPathUpserts(file.path, file instanceof TFolder);
		if (this.syncClient?.isApplyingRemoteChanges(file.path) || !this.shouldSyncLocalPath(file.path)) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Delete",
			path: file.path,
			isFolder: file instanceof TFolder,
			created: Date.now(),
		});
		log.info("queued local delete", { path: file.path, isFolder: file instanceof TFolder });
		this.syncClient.wakeSoon();
	}

	private async enqueueLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		this.cancelPendingPathUpserts(oldPath, file instanceof TFolder);
		this.cancelPendingPathUpserts(file.path, file instanceof TFolder);
		if (
			(this.syncClient?.isApplyingRemoteChanges(oldPath) || this.syncClient?.isApplyingRemoteChanges(file.path)) ||
			!this.shouldSyncLocalPath(oldPath) ||
			!this.shouldSyncLocalPath(file.path)
		) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Rename",
			path: oldPath,
			toPath: file.path,
			isFolder: file instanceof TFolder,
			created: Date.now(),
		});
		log.info("queued local rename", { oldPath, path: file.path, isFolder: file instanceof TFolder });
		this.syncClient.wakeSoon();
	}

	private async enqueueLocalCreate(file: TAbstractFile): Promise<void> {
		if (
			this.syncClient?.isApplyingRemoteChanges(file.path) ||
			!this.shouldSyncLocalPath(file.path)
		) {
			return;
		}
		if (this.deferPreStartupLocalEvent(file.path, file instanceof TFolder, "create")) {
			return;
		}
		if (file instanceof TFolder) {
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "CreateFolder",
				path: file.path,
				isFolder: true,
				created: Date.now(),
			});
			log.info("queued local folder create", { path: file.path });
			this.syncClient.wakeSoon();
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		if (shouldUseYjs(file.path, this.app.vault.configDir)) {
			const content = await this.app.vault.read(file);
			const yjsState = docStateFromContent(content, Y);
			await this.yjsStateStore.putWithContentHash(
				file.path,
				yjsState,
				await sha256Hex(new TextEncoder().encode(content)),
			);
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "UpsertFile",
				path: file.path,
				content,
				yjsState,
				isFolder: false,
				isYjs: true,
				storageKind: "text",
				created: Date.now(),
			});
			log.info("queued local markdown create", { path: file.path, chars: content.length });
			this.syncClient.wakeSoon();
			return;
		}
		this.queuePathUpsertDebounced(file.path);
	}

	private startConfigDirPoller(): void {
		if (this.configDirPollerStarted) {
			return;
		}
		this.configDirPollerStarted = true;
		void this.scanConfigDirForChanges("baseline");
		this.registerInterval(window.setInterval(() => {
			void this.scanConfigDirForChanges("enqueue");
		}, CONFIG_DIR_POLL_MS));
	}

	private async scanConfigDirForChanges(mode: ConfigDirScanMode): Promise<void> {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return;
		}
		if (this.syncClient?.isApplyingRemoteChanges()) {
			return;
		}
		const seen = new Set<string>();
		for (const path of await this.listConfigDirFiles(this.app.vault.configDir)) {
			if (!this.shouldSyncLocalPath(path) || shouldUseYjs(path, this.app.vault.configDir)) {
				continue;
			}
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat || stat.type !== "file") {
				continue;
			}
			seen.add(path);
			const fingerprint = `${stat.mtime}:${stat.size}`;
			if (this.configDirStats.get(path) === fingerprint) {
				continue;
			}
			this.configDirStats.set(path, fingerprint);
			if (mode === "enqueue") {
				this.queuePathUpsertDebounced(path);
			}
		}

		for (const path of [...this.configDirStats.keys()]) {
			if (seen.has(path)) {
				continue;
			}
			this.configDirStats.delete(path);
			if (mode === "enqueue" && this.shouldSyncLocalPath(path)) {
				void this.enqueueLocalPathDelete(path).catch(error => {
					log.error("failed to enqueue config dir delete", { path, ...errorContext(error) });
					new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
				});
			}
		}
	}

	private async listConfigDirFiles(dir: string): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(dir))) {
			return [];
		}
		const listed = await this.app.vault.adapter.list(dir);
		const files = [...listed.files];
		for (const folder of listed.folders) {
			files.push(...await this.listConfigDirFiles(folder));
		}
		return files;
	}

	private startYjsIndexer(): void {
		if (this.yjsIndexerStarted) {
			return;
		}
		this.yjsIndexerStarted = true;
		this.yjsIndexer.start();
	}

	private async queueExternalMarkdownChange(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		if (this.deferPreStartupLocalEvent(file.path, false, "modify")) {
			return;
		}
		await this.queueMarkdownPathChange(file.path, file);
	}

	private async queueMarkdownPathChange(path: string, file?: TFile): Promise<void> {
		if (this.docs.has(path) || this.pendingDocs.has(path)) {
			return;
		}
		if (
			this.syncClient?.isApplyingRemoteChanges(path) ||
			!this.shouldSyncLocalPath(path)
		) {
			return;
		}
		const previousState = await this.yjsStateStore.get(path);
		const loaded = file ?? this.app.vault.getAbstractFileByPath(path);
		const content = loaded instanceof TFile
			? await this.app.vault.read(loaded)
			: await this.app.vault.adapter.read(path);
		const contentHash = await sha256Hex(new TextEncoder().encode(content));
		if (previousState && await this.yjsStateStore.getContentHash(path) === contentHash) {
			return;
		}
		const nextState = docStateFromContent(content, Y);
		await this.yjsStateStore.putWithContentHash(
			path,
			nextState,
			contentHash,
		);
		await this.queueIndexedMarkdownChange(path, content, nextState, previousState);
	}

	private async queueIndexedMarkdownChange(
		path: string,
		content: string,
		yjsState: Uint8Array,
		previousState: Uint8Array | null = null,
	): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(path) || !this.shouldSyncLocalPath(path)) {
			return;
		}
		if (this.docs.has(path) || this.pendingDocs.has(path)) {
			return;
		}
		if (previousState) {
			const previousVector = Y.encodeStateVectorFromUpdateV2(previousState);
			const changed = Y.diffUpdateV2(yjsState, previousVector).byteLength > 0;
			if (!changed) {
				return;
			}
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "YjsUpdate",
				path,
				data: new Uint8Array(),
				created: Date.now(),
			});
			log.info("queued closed markdown Yjs resync", { path, chars: content.length });
		} else {
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "UpsertFile",
				path,
				content,
				yjsState,
				isFolder: false,
				isYjs: true,
				storageKind: "text",
				created: Date.now(),
			});
			log.info("queued closed markdown upsert", { path, chars: content.length });
		}
		this.syncClient.wakeSoon();
	}

	private async enqueueLocalPathDelete(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(path) || !this.shouldSyncLocalPath(path)) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Delete",
			path,
			isFolder: false,
			created: Date.now(),
		});
		log.info("queued local path delete", { path });
		this.syncClient.wakeSoon();
	}

	private async pruneClosedDocs(): Promise<void> {
		const openPaths = new Set<string>();
		const pruned: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) {
				openPaths.add(view.file.path);
			}
		}
		for (const [path, doc] of this.docs) {
			if (!openPaths.has(path) && !this.pruningDocs.has(path)) {
				this.pruningDocs.add(path);
				pruned.push(this.pruneClosedDoc(path, doc).finally(() => {
					this.pruningDocs.delete(path);
				}));
			}
		}
		await Promise.all(pruned);
	}

	private async pruneClosedDoc(path: Path, doc: DocSync): Promise<void> {
		try {
			await doc.persistState();
		} catch (error) {
			log.error("failed to persist closed Yjs doc", { path, ...errorContext(error) });
			return;
		}
		if (this.docs.get(path) !== doc || this.isMarkdownPathOpen(path)) {
			return;
		}
		doc.destroy();
		this.docs.delete(path);
		log.debug("pruned closed DocSync", { path });
	}

	private isMarkdownPathOpen(path: Path): boolean {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) {
				return true;
			}
		}
		return false;
	}

	private async applyRemoteYjsContentToOpenEditors(path: Path, content: string): Promise<boolean> {
		let applied = false;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== path) {
				continue;
			}
			applied = true;
			const editorView = editorViewFor(view.editor);
			if (!editorView) {
				if (view.editor.getValue() !== content) {
					view.editor.setValue(content);
				}
				continue;
			}
			const before = editorView.state.doc.toString();
			const change = changedRange(before, content);
			if (!change) {
				continue;
			}
			const selection = editorView.state.selection.ranges.map(range => ({
				anchor: mapPositionThroughReplacement(range.anchor, change.from, change.to, change.insert.length),
				head: mapPositionThroughReplacement(range.head, change.from, change.to, change.insert.length),
			}));
			this.remoteEditorDispatches.add(editorView);
			try {
				editorView.dispatch({
					changes: change,
					selection: EditorSelection.create(selection.map(range => EditorSelection.range(range.anchor, range.head))),
				});
			} finally {
				this.remoteEditorDispatches.delete(editorView);
			}
		}
		return applied;
	}

	private queueNonMarkdownUpsert(file: TAbstractFile): void {
		if (
			this.syncClient?.isApplyingRemoteChanges(file.path) ||
			!(file instanceof TFile) ||
			this.isConfigDirPath(file.path) ||
			shouldUseYjs(file.path, this.app.vault.configDir) ||
			!this.shouldSyncLocalPath(file.path)
		) {
			return;
		}
		if (this.deferPreStartupLocalEvent(file.path, false, "modify")) {
			return;
		}
		this.queuePathUpsertDebounced(file.path);
	}

	private queuePathUpsertDebounced(path: string): void {
		const existing = this.pendingFileTimers.get(path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		const timer = window.setTimeout(() => {
			this.pendingFileTimers.delete(path);
			void this.queuePathUpsert(path).catch(error => {
				log.error("failed to enqueue file upsert", { path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
		}, 500);
		this.pendingFileTimers.set(path, timer);
	}

	private cancelPendingPathUpserts(path: string, includeDescendants = false): void {
		const prefix = `${path}/`;
		for (const [pendingPath, timer] of this.pendingFileTimers) {
			if (pendingPath === path || (includeDescendants && pendingPath.startsWith(prefix))) {
				window.clearTimeout(timer);
				this.pendingFileTimers.delete(pendingPath);
			}
		}
	}

	private async captureBootConfigShas(): Promise<void> {
		for (const path of await this.listConfigDirFiles(this.app.vault.configDir)) {
			if (!this.isSyncableConfigPath(path)) {
				continue;
			}
			try {
				const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
				this.bootConfigSha.set(path, await sha256Hex(bytes));
			} catch (error) {
				log.debug("failed to capture boot config hash", { path, ...errorContext(error) });
			}
		}
	}

	private async captureBootVaultEntries(): Promise<void> {
		this.bootVaultEntries.clear();
		await this.addBootVaultEntries("");
		await this.addBootVaultEntries(this.app.vault.configDir);
		log.debug("captured boot vault entries", { entries: this.bootVaultEntries.size });
	}

	private async addBootVaultEntries(dir: string): Promise<void> {
		if (dir && !(await this.app.vault.adapter.exists(dir))) {
			return;
		}
		const listed = await this.app.vault.adapter.list(dir);
		for (const folder of listed.folders) {
			if (!this.shouldSyncLocalPath(folder)) {
				continue;
			}
			this.bootVaultEntries.set(folder, { isFolder: true, fingerprint: null });
			await this.addBootVaultEntries(folder);
		}
		for (const file of listed.files) {
			if (!this.shouldSyncLocalPath(file)) {
				continue;
			}
			const stat = await this.app.vault.adapter.stat(file);
			if (stat?.type === "file") {
				this.bootVaultEntries.set(file, { isFolder: false, fingerprint: `${stat.mtime}:${stat.size}` });
			}
		}
	}

	private async recordRemoteConfigApplied(path: string, bytes: Uint8Array): Promise<void> {
		if (!this.isSyncableConfigPath(path)) {
			return;
		}
		const snapshot = new Uint8Array(bytes);
		this.serverConfigBytes.set(path, snapshot);
		this.serverConfigSha.set(path, await sha256Hex(snapshot));
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type === "file") {
			this.configDirStats.set(path, `${stat.mtime}:${stat.size}`);
		}
	}

	private async restoreServerConfig(path: string): Promise<boolean> {
		const bytes = this.serverConfigBytes.get(path);
		if (!bytes) {
			return false;
		}
		await this.app.vault.adapter.writeBinary(path, exactArrayBuffer(bytes));
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type === "file") {
			this.configDirStats.set(path, `${stat.mtime}:${stat.size}`);
		}
		log.info("restored config file from last server version", { path });
		return true;
	}

	private isSyncableConfigPath(path: string): boolean {
		return this.isConfigDirPath(path)
			&& shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)
			&& !shouldUseYjs(path, this.app.vault.configDir);
	}

	private async queuePathUpsert(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(path) || !this.shouldSyncLocalPath(path)) {
			return;
		}
		const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
		let localSha: string | undefined;
		if (this.isSyncableConfigPath(path)) {
			localSha = await sha256Hex(bytes);
			const serverSha = this.serverConfigSha.get(path);
			if (serverSha && localSha === serverSha) {
				log.debug("skip config upsert; matches last server version", { path });
				return;
			}
			const bootSha = this.bootConfigSha.get(path);
			if (serverSha && bootSha && localSha === bootSha && localSha !== serverSha) {
				if (await this.restoreServerConfig(path)) {
					log.warn("ignored obsidian config rewrite that reverted a synced change", { path });
					return;
				}
			}
		}
		if (bytes.byteLength > INLINE_BYTES_LIMIT) {
			const metadata = await this.syncClient.uploadBlob(path, bytes);
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "UpsertFile",
				path,
				isFolder: false,
				isYjs: false,
				storageKind: "lo",
				blobUploadId: metadata.blobUploadId,
				byteSize: metadata.byteSize,
				contentSha256: metadata.contentSha256,
				created: Date.now(),
			});
			log.info("queued large file upsert", { path, byteSize: metadata.byteSize, contentSha256: metadata.contentSha256 });
			this.syncClient.wakeSoon();
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "UpsertFile",
			path,
			contentBytes: bytes,
			isFolder: false,
			isYjs: false,
			storageKind: "bytea",
			byteSize: bytes.byteLength,
			created: Date.now(),
		});
		log.info("queued file upsert", { path, byteSize: bytes.byteLength });
		if (this.isSyncableConfigPath(path)) {
			const appliedSha = localSha ?? await sha256Hex(bytes);
			this.bootConfigSha.set(path, appliedSha);
			this.serverConfigSha.set(path, appliedSha);
			this.serverConfigBytes.set(path, new Uint8Array(bytes));
		}
		this.syncClient.wakeSoon();
	}

	private isPluginInternalPath(path: string): boolean {
		return isPluginInternalPath(path, this.app.vault.configDir, this.manifest.id);
	}

	private isConfigDirPath(path: string): boolean {
		const configDir = this.app.vault.configDir.replace(/^\/+|\/+$/g, "");
		return path === configDir || path.startsWith(`${configDir}/`);
	}

	private shouldSyncLocalPath(path: string): boolean {
		return shouldSyncPath(path, this.app.vault.configDir, this.manifest.id);
	}

	private deferPreStartupLocalEvent(path: string, isFolder: boolean, kind: PreStartupLocalEvent["kind"]): boolean {
		if (this.startupSyncCompleted || !this.hasServerBaseline()) {
			return false;
		}
		this.preStartupLocalEvents.set(path, { path, isFolder, kind });
		log.debug("deferred pre-startup local vault event for synced baseline", { path, kind });
		return true;
	}

	private async flushDeferredPreStartupLocalEvents(): Promise<void> {
		const events = [...this.preStartupLocalEvents.values()]
			.sort((a, b) => {
				if (a.isFolder !== b.isFolder) {
					return a.isFolder ? -1 : 1;
				}
				return a.path.localeCompare(b.path);
			});
		this.preStartupLocalEvents.clear();
		for (const event of events) {
			try {
				if (!(await this.shouldReplayDeferredPreStartupEvent(event))) {
					continue;
				}
				if (event.isFolder) {
					await this.db.putInOutbox({
						mutationId: crypto.randomUUID(),
						operation: "CreateFolder",
						path: event.path,
						isFolder: true,
						created: Date.now(),
					});
					log.info("queued deferred pre-startup folder create", { path: event.path });
					this.syncClient.wakeSoon();
				} else if (shouldUseYjs(event.path, this.app.vault.configDir)) {
					await this.queueMarkdownPathChange(event.path);
				} else if (!this.isConfigDirPath(event.path)) {
					this.queuePathUpsertDebounced(event.path);
				}
			} catch (error) {
				log.error("failed to replay deferred pre-startup local event", {
					path: event.path,
					kind: event.kind,
					...errorContext(error),
				});
			}
		}
	}

	private async shouldReplayDeferredPreStartupEvent(event: PreStartupLocalEvent): Promise<boolean> {
		if (!this.shouldSyncLocalPath(event.path)) {
			return false;
		}
		const stat = await this.app.vault.adapter.stat(event.path);
		if (!stat) {
			return false;
		}
		const current: BootVaultEntry = {
			isFolder: stat.type === "folder",
			fingerprint: stat.type === "file" ? `${stat.mtime}:${stat.size}` : null,
		};
		const boot = this.bootVaultEntries.get(event.path);
		if (!boot) {
			return true;
		}
		return boot.isFolder !== current.isFolder || boot.fingerprint !== current.fingerprint;
	}

	private hasServerBaseline(): boolean {
		try {
			return BigInt(this.settings.lastPulledRevision || "0") > BigInt(0);
		} catch {
			return false;
		}
	}

	onunload() {
		log.info("plugin unloading");
		for (const timer of this.pendingFileTimers.values()) {
			window.clearTimeout(timer);
		}
		this.pendingFileTimers.clear();
		if (this.presenceRenderFrame !== null) {
			cancelAnimationFrame(this.presenceRenderFrame);
			this.presenceRenderFrame = null;
		}
		for (const [path, doc] of this.docs) {
			void doc.persistState().catch(error => {
				log.error("failed to persist open Yjs doc on unload", { path, ...errorContext(error) });
			});
		}
		this.syncClient?.stop();
		this.yjsIndexer?.stop();
		this.clearRemoteEditorPresences();
		void this.db.close().catch(error => {
			log.error("failed to close outbox store", errorContext(error));
		});
	}

	async loadSettings() {
		const loaded = await this.loadData() as (Partial<SyncEngineSettings> & { syncConfigDir?: unknown }) | null;
		const { syncConfigDir: removedSyncConfigDir, ...persistedSettings } = loaded ?? {};
		let shouldSave = removedSyncConfigDir !== undefined;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, persistedSettings);
		if (!this.settings.clientId.trim()) {
			this.settings = {
				...this.settings,
				clientId: generateClientId(),
			};
			shouldSave = true;
		}
		if (!this.settings.lastPulledRevision.trim()) {
			this.settings = {
				...this.settings,
				lastPulledRevision: "0",
			};
			shouldSave = true;
		}
		if (shouldSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateSyncSettings() {
		this.syncClient?.updateSettings(this.settings);
	}

	subscribeBootstrapStatus(listener: () => void): () => void {
		this.bootstrapStatusListeners.add(listener);
		return () => this.bootstrapStatusListeners.delete(listener);
	}

	private setBootstrapStatus(status: BootstrapStatus): void {
		this.bootstrapStatus = status;
		this.renderBootstrapStatusBar();
		for (const listener of this.bootstrapStatusListeners) {
			listener();
		}
	}

	private renderBootstrapStatusBar(): void {
		if (!this.bootstrapStatusBarEl) {
			return;
		}
		const status = this.bootstrapStatus;
		if (!status || !["building", "uploading", "complete", "failed"].includes(status.status)) {
			this.bootstrapStatusBarEl.setText("");
			this.bootstrapStatusBarEl.hide();
			return;
		}
		this.bootstrapStatusBarEl.show();
		if (status.status === "failed") {
			this.bootstrapStatusBarEl.setText(`Sync bootstrap failed: ${status.message ?? "Unknown error"}`);
			return;
		}
		if (status.status === "complete") {
			this.bootstrapStatusBarEl.setText("Sync bootstrap complete");
			return;
		}
		const total = status.progressTotal ?? 0;
		const current = status.progressCurrent ?? 0;
		const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
		this.bootstrapStatusBarEl.setText(`Sync bootstrap ${percent}%`);
	}

	async generateVaultLink(): Promise<void> {
		await this.syncClient.generateBootstrapLink(
			this.app.vault.getName(),
			this.app.vault.configDir,
			this.manifest.id,
		);
	}
}
