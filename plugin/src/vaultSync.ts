import {
	normalizePath,
	requestUrl,
	TFile,
	type TAbstractFile,
} from 'obsidian';
import type ObsidianSyncPlugin from './main';
import { SyncEngine, type SyncTickResult } from './sync/engine';
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
	deadLetterPath: string;
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
	return normalizePath(`${getPluginDir(plugin)}/state/${plugin.settings.serverIdentity}/outbox.jsonl`);
}

function getInboxPath(plugin: ObsidianSyncPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/state/${plugin.settings.serverIdentity}/inbox.jsonl`);
}

function getDeadLetterPath(plugin: ObsidianSyncPlugin): string {
	return normalizePath(
		`${getPluginDir(plugin)}/state/${plugin.settings.serverIdentity}/dead-letter.jsonl`,
	);
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
	const pluginDir = getPluginDir(plugin);
	const configDir = normalizePath(plugin.app.vault.configDir);
	if (normalized === configDir || normalized.startsWith(`${configDir}/`)) {
		return true;
	}
	if (
		normalized === getOutboxPath(plugin) ||
		normalized === getInboxPath(plugin) ||
		normalized === getDataJsonPath(plugin)
	) {
		return true;
	}
	// Queue sidecars written during recovery / dead-lettering.
	if (
		normalized.startsWith(`${pluginDir}/`) &&
		(normalized.endsWith(".jsonl") ||
			normalized.endsWith(".jsonl.corrupt") ||
			normalized.endsWith(".jsonl.tmp") ||
			normalized.endsWith("dead-letter.jsonl"))
	) {
		return true;
	}
	return false;
}

/**
 * Builds the SyncEngine for this plugin instance and wires it up to vault
 * events (note modify/create, delete, rename) and a periodic tick.
 * Called once from `onload`.
 */
export function registerVaultSync(plugin: ObsidianSyncPlugin): VaultSync {
	const fs = new ObsidianFs(
		plugin.app.vault.adapter,
		plugin.app.vault,
	);
	const outboxPath = getOutboxPath(plugin);
	const inboxPath = getInboxPath(plugin);
	const deadLetterPath = getDeadLetterPath(plugin);
	const status: SyncStatus = { lastTickAt: null, lastError: null };
	const runtimeIdentity = plugin.settings.serverIdentity;
	const runtimeServerUrl = plugin.settings.serverUrl;
	const assertRuntimeIdentity = () => {
		if (
			plugin.isSyncSuspended() ||
			plugin.settings.serverIdentity !== runtimeIdentity
		) {
			throw new Error("Sync runtime belongs to a different server; reload Obsidian");
		}
	};

	const transport = new HttpTransport({
		getServerUrl: () => {
			assertRuntimeIdentity();
			return runtimeServerUrl;
		},
		getAuthorization: () => {
			assertRuntimeIdentity();
			return plugin.settings.clientSecret;
		},
		request: requestUrl,
	});

	const engine = new SyncEngine({
		fs,
		transport,
		outboxPath,
		inboxPath,
		deadLetterPath,
		getRevision: () => {
			assertRuntimeIdentity();
			return plugin.settings.revision;
		},
		setRevision: (revision) => {
			assertRuntimeIdentity();
			plugin.settings.revision = revision;
			return plugin.saveSettings();
		},
		debounceMs: DEBOUNCE_MS,
		onPermanentFailure: ({ op, error }) => {
			status.lastError = `${op.path}: ${error}`;
		},
		onEnqueueFailure: (error, op) => {
			status.lastError = `Could not persist ${op.path}: ${error.message}`;
		},
		isSuspended: () =>
			plugin.isSyncSuspended() ||
			plugin.settings.serverIdentity !== runtimeIdentity,
	});

	// Suppressed whenever the write/delete originated from *this* fs instance
	// (e.g. the engine applying a remote put/delete) rather than from the
	// user editing the vault, so applying an inbound change can never
	// re-enqueue itself as an outbound one.
	const isLocallyOriginated = (
		file: TAbstractFile,
		path: string,
		event: "create" | "modify" | "delete" | "rename-delete",
	) =>
		!plugin.isSyncSuspended() &&
		!fs.consumeInboundEvent(file, path, event) &&
		!isSyncEngineOwnedPath(plugin, path);

	const enqueuePutIfLocal = (
		file: TAbstractFile,
		event: "create" | "modify",
	) => {
		if (isLocallyOriginated(file, file.path, event)) {
			engine.enqueuePut(file.path);
		}
	};
	const enqueueDeleteIfLocal = (
		file: TAbstractFile,
		path: string,
		event: "delete" | "rename-delete",
	) => {
		if (isLocallyOriginated(file, path, event)) {
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
				enqueuePutIfLocal(file, "modify");
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('create', (file: TAbstractFile) => {
			if (file instanceof TFile) {
				enqueuePutIfLocal(file, "create");
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			// Folders have no content to sync — only their (already-deleted)
			// child files matter, and those get their own 'delete' events.
			if (file instanceof TFile) {
				enqueueDeleteIfLocal(file, file.path, "delete");
			}
		}),
	);
	plugin.registerEvent(
		plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) {
				enqueueDeleteIfLocal(file, oldPath, "rename-delete");
				enqueuePutIfLocal(file, "create");
			}
		}),
	);

	void engine.hydrate();

	plugin.register(() => {
		void engine.flush().catch((error) => {
			status.lastError =
				error instanceof Error ? error.message : String(error);
			console.error("Could not flush sync state during unload", error);
		});
	});

	plugin.registerInterval(
		window.setInterval(() => {
			void engine.tick().then(async (result) => {
				status.lastTickAt = Date.now();
				if (result.ok) {
					status.lastError = (await fs.exists(deadLetterPath))
						? "Some files require attention; see the dead-letter journal"
						: null;
				} else {
					status.lastError = result.error;
				}
			});
		}, TICK_INTERVAL_MS),
	);

	return { engine, fs, outboxPath, deadLetterPath, status };
}

/** Enqueues every current vault file (minus the engine's own bookkeeping files) and pushes them out. */
export async function seedServerFromVault(
	plugin: ObsidianSyncPlugin,
	sync: VaultSync,
): Promise<SyncTickResult> {
	const files = (await sync.fs.listAllFiles()).filter(
		(path) => !isSyncEngineOwnedPath(plugin, path),
	);
	await sync.engine.seedFromVault(() => files);
	await sync.engine.flush();
	return sync.engine.tick();
}
