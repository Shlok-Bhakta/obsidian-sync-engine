import {
	normalizePath,
	requestUrl,
	TFile,
	type TAbstractFile,
} from 'obsidian';
import type ObsidianSyncPlugin from './main';
import { SyncEngine } from './sync/engine';
import { HttpTransport } from './sync/httpTransport';
import { ObsidianFs } from './sync/obsidianFs';

const TICK_INTERVAL_MS = 3000;
const DEBOUNCE_MS = 1000;

export type SyncStatus = {
	lastTickAt: number | null;
	lastError: string | null;
};

export type VaultSync = {
	engine: SyncEngine;
	fs: ObsidianFs;
	outboxPath: string;
	status: SyncStatus;
};

/** Directory the plugin's own files (main.js, data.json, ...) live in. */
function getPluginDir(plugin: ObsidianSyncPlugin): string {
	return normalizePath(
		plugin.manifest.dir ??
			`${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`,
	);
}

function getOutboxPath(plugin: ObsidianSyncPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/outbox.jsonl`);
}

function getInboxPath(plugin: ObsidianSyncPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/inbox.jsonl`);
}

function getDataJsonPath(plugin: ObsidianSyncPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/data.json`);
}

/**
 * True for the sync engine's own bookkeeping files. These must never be
 * enqueued for sync themselves, or writing them (to record a sync) would
 * itself trigger another sync, forever.
 */
function isSyncEngineOwnedPath(plugin: ObsidianSyncPlugin, path: string): boolean {
	const normalized = normalizePath(path);
	return (
		normalized === getOutboxPath(plugin) ||
		normalized === getInboxPath(plugin) ||
		normalized === getDataJsonPath(plugin)
	);
}

/**
 * Builds the SyncEngine for this plugin instance and wires it up to vault
 * events (note modify/create, delete, rename) and a periodic tick.
 * Called once from `onload`.
 */
export function registerVaultSync(plugin: ObsidianSyncPlugin): VaultSync {
	const fs = new ObsidianFs(plugin.app.vault.adapter);
	const outboxPath = getOutboxPath(plugin);
	const inboxPath = getInboxPath(plugin);
	const status: SyncStatus = { lastTickAt: null, lastError: null };

	const transport = new HttpTransport({
		getServerUrl: () => plugin.settings.serverUrl,
		getAuthorization: () => plugin.settings.clientSecret,
		request: requestUrl,
	});

	const engine = new SyncEngine({
		fs,
		transport,
		outboxPath,
		inboxPath,
		getRevision: () => plugin.settings.revision,
		setRevision: (revision) => {
			plugin.settings.revision = revision;
			return plugin.saveSettings();
		},
		debounceMs: DEBOUNCE_MS,
	});

	// Suppressed whenever the write/delete originated from *this* fs instance
	// (e.g. the engine applying a remote put/delete) rather than from the
	// user editing the vault, so applying an inbound change can never
	// re-enqueue itself as an outbound one.
	const isLocallyOriginated = (path: string) =>
		!fs.isWriting && !isSyncEngineOwnedPath(plugin, path);

	const enqueuePutIfLocal = (path: string) => {
		if (isLocallyOriginated(path)) {
			engine.enqueuePut(path);
		}
	};
	const enqueueDeleteIfLocal = (path: string) => {
		if (isLocallyOriginated(path)) {
			engine.enqueueDelete(path);
		}
	};

	// Notes: rely on the vault's `modify`/`create` events (fired once Obsidian
	// has flushed to disk) rather than `editor-change`, so the engine always
	// reads back what was actually written rather than a stale/half-typed
	// buffer.
	plugin.registerEvent(
		plugin.app.vault.on('modify', (file: TAbstractFile) => {
			if (file instanceof TFile) {
				enqueuePutIfLocal(file.path);
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('create', (file: TAbstractFile) => {
			if (file instanceof TFile) {
				enqueuePutIfLocal(file.path);
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			// Folders have no content to sync — only their (already-deleted)
			// child files matter, and those get their own 'delete' events.
			if (file instanceof TFile) {
				enqueueDeleteIfLocal(file.path);
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) {
				enqueueDeleteIfLocal(oldPath);
				enqueuePutIfLocal(file.path);
			}
		}),
	);

	void engine.hydrate();

	plugin.register(() => {
		void engine.flush();
	});

	plugin.registerInterval(
		window.setInterval(() => {
			void engine.tick().then((result) => {
				status.lastTickAt = Date.now();
				if (result.ok) {
					status.lastError = null;
				} else {
					status.lastError = result.error;
				}
			});
		}, TICK_INTERVAL_MS),
	);

	return { engine, fs, outboxPath, status };
}

/** Enqueues every current vault file (minus the engine's own bookkeeping files) and pushes them out. */
export async function seedServerFromVault(
	plugin: ObsidianSyncPlugin,
	sync: VaultSync,
): Promise<void> {
	const files = (await sync.fs.listAllFiles()).filter(
		(path) => !isSyncEngineOwnedPath(plugin, path),
	);
	await sync.engine.seedFromVault(() => files);
	await sync.engine.flush();
	await sync.engine.tick();
}
