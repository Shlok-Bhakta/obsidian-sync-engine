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
import { isStaleFileDeletion } from "./sync/vaultEvents";
import { isSyncExcludedPath } from "./sync/excludedPaths";
import type { DataAdapter, DataWriteOptions } from "obsidian";

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

/**
 * True for the sync engine's own bookkeeping files. These must never be
 * enqueued for sync themselves, or writing them (to record a sync) would
 * itself trigger another sync, forever.
 */
function isSyncEngineOwnedPath(plugin: ObsidianSyncPlugin, path: string): boolean {
	const normalized = normalizePath(path);
	const pluginDir = getPluginDir(plugin);
	const configDir = normalizePath(plugin.app.vault.configDir);
	return isSyncExcludedPath({
		path: normalized,
		configDir,
		pluginDir,
	});
}

function registerConfigAdapterSync(
	plugin: ObsidianSyncPlugin,
	fs: ObsidianFs,
	engine: SyncEngine,
): void {
	const logger = plugin.logger.child("config_events");
	const adapter: DataAdapter = plugin.app.vault.adapter;
	const configDir = normalizePath(plugin.app.vault.configDir);
	const isConfigPath = (path: string) => {
		const normalized = normalizePath(path);
		return (
			normalized === configDir ||
			normalized.startsWith(`${configDir}/`)
		);
	};
	const enqueuePut = (path: string) => {
		const normalized = normalizePath(path);
		if (!isConfigPath(normalized)) {
			return;
		}
		if (fs.consumeInboundAdapterChange(normalized)) {
			logger.debug("change.skipped", {
				path: normalized,
				operation: "put",
				reason: "inbound_change",
			});
			return;
		}
		if (isSyncEngineOwnedPath(plugin, normalized)) {
			logger.debug("change.skipped", {
				path: normalized,
				operation: "put",
				reason: "sync_owned_path",
			});
			return;
		}
		logger.info("change.enqueued", {
			path: normalized,
			operation: "put",
		});
		engine.enqueuePut(normalized);
	};
	const enqueueDelete = (path: string) => {
		const normalized = normalizePath(path);
		if (!isConfigPath(normalized)) {
			return;
		}
		if (fs.consumeInboundAdapterChange(normalized)) {
			logger.debug("change.skipped", {
				path: normalized,
				operation: "delete",
				reason: "inbound_change",
			});
			return;
		}
		if (isSyncEngineOwnedPath(plugin, normalized)) {
			logger.debug("change.skipped", {
				path: normalized,
				operation: "delete",
				reason: "sync_owned_path",
			});
			return;
		}
		logger.info("change.enqueued", {
			path: normalized,
			operation: "delete",
		});
		engine.enqueueDelete(normalized);
	};

	const write = adapter.write.bind(adapter);
	const writeBinary = adapter.writeBinary.bind(adapter);
	const append = adapter.append.bind(adapter);
	const appendBinary = adapter.appendBinary.bind(adapter);
	const process = adapter.process.bind(adapter);
	const remove = adapter.remove.bind(adapter);
	const rename = adapter.rename.bind(adapter);
	const copy = adapter.copy.bind(adapter);

	adapter.write = async (
		path: string,
		data: string,
		options?: DataWriteOptions,
	) => {
		await write(path, data, options);
		enqueuePut(path);
	};
	adapter.writeBinary = async (
		path: string,
		data: ArrayBuffer,
		options?: DataWriteOptions,
	) => {
		await writeBinary(path, data, options);
		enqueuePut(path);
	};
	adapter.append = async (
		path: string,
		data: string,
		options?: DataWriteOptions,
	) => {
		await append(path, data, options);
		enqueuePut(path);
	};
	adapter.appendBinary = async (
		path: string,
		data: ArrayBuffer,
		options?: DataWriteOptions,
	) => {
		await appendBinary(path, data, options);
		enqueuePut(path);
	};
	adapter.process = async (
		path: string,
		fn: (data: string) => string,
		options?: DataWriteOptions,
	) => {
		const result = await process(path, fn, options);
		enqueuePut(path);
		return result;
	};
	adapter.remove = async (path: string) => {
		await remove(path);
		enqueueDelete(path);
	};
	adapter.rename = async (path: string, newPath: string) => {
		await rename(path, newPath);
		enqueueDelete(path);
		enqueuePut(newPath);
	};
	adapter.copy = async (path: string, newPath: string) => {
		await copy(path, newPath);
		enqueuePut(newPath);
	};

	plugin.register(() => {
		adapter.write = write;
		adapter.writeBinary = writeBinary;
		adapter.append = append;
		adapter.appendBinary = appendBinary;
		adapter.process = process;
		adapter.remove = remove;
		adapter.rename = rename;
		adapter.copy = copy;
	});
}

/**
 * Builds the SyncEngine for this plugin instance and wires it up to vault
 * events (note modify/create, delete, rename) and a periodic tick.
 * Called once from `onload`.
 */
export function registerVaultSync(plugin: ObsidianSyncPlugin): VaultSync {
	const logger = plugin.logger.child("vault_sync");
	const fs = new ObsidianFs(
		plugin.app.vault.adapter,
		plugin.app.vault,
		logger,
	);
	const outboxPath = getOutboxPath(plugin);
	const inboxPath = getInboxPath(plugin);
	const deadLetterPath = getDeadLetterPath(plugin);
	const status: SyncStatus = { lastTickAt: null, lastError: null };
	const runtimeIdentity = plugin.settings.serverIdentity;
	const runtimeServerUrl = plugin.settings.serverUrl;
	logger.info("registering", {
		serverUrl: runtimeServerUrl,
		serverIdentity: runtimeIdentity,
		outboxPath,
		inboxPath,
		deadLetterPath,
	});
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
		logger,
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
			logger.error("permanent_failure", {
				path: op.path,
				operation: op.op,
				error,
			});
		},
		onEnqueueFailure: (error, op) => {
			status.lastError = `Could not persist ${op.path}: ${error.message}`;
			logger.error("enqueue_failure", {
				path: op.path,
				operation: op.op,
				error,
			});
		},
		isSuspended: () =>
			plugin.isSyncSuspended() ||
			plugin.settings.serverIdentity !== runtimeIdentity,
		logger,
	});
	registerConfigAdapterSync(plugin, fs, engine);

	// Suppressed whenever the write/delete originated from *this* fs instance
	// (e.g. the engine applying a remote put/delete) rather than from the
	// user editing the vault, so applying an inbound change can never
	// re-enqueue itself as an outbound one.
	const isLocallyOriginated = (
		file: TAbstractFile,
		path: string,
		event: "create" | "modify" | "delete" | "rename-delete",
	) => {
		if (plugin.isSyncSuspended()) {
			logger.debug("vault_event.skipped", {
				path,
				event,
				reason: "suspended",
			});
			return false;
		}
		if (fs.consumeInboundEvent(file, path, event)) {
			logger.debug("vault_event.skipped", {
				path,
				event,
				reason: "inbound_change",
			});
			return false;
		}
		if (isSyncEngineOwnedPath(plugin, path)) {
			logger.debug("vault_event.skipped", {
				path,
				event,
				reason: "sync_owned_path",
			});
			return false;
		}
		return true;
	};

	const enqueuePutIfLocal = (
		file: TAbstractFile,
		event: "create" | "modify",
	) => {
		if (isLocallyOriginated(file, file.path, event)) {
			logger.info("vault_event.enqueued", {
				path: file.path,
				event,
				operation: "put",
			});
			engine.enqueuePut(file.path);
		}
	};
	const enqueueDeleteIfLocal = (
		file: TAbstractFile,
		path: string,
		event: "delete" | "rename-delete",
	) => {
		if (fs.consumeInboundEvent(file, path, event)) {
			logger.debug("vault_event.skipped", {
				path,
				event,
				reason: "inbound_change",
			});
			return;
		}
		const current = plugin.app.vault.getAbstractFileByPath(path);
		if (
			file instanceof TFile &&
			current instanceof TFile &&
			isStaleFileDeletion(file, current)
		) {
			// Obsidian can deliver the old file's delete notification after a
			// replacement already exists at the same path. The replacement is
			// the desired final state; emitting this stale tombstone would
			// erase it on every client.
			logger.warn("vault_event.skipped", {
				path,
				event,
				reason: "stale_delete",
			});
			return;
		}
		if (
			!plugin.isSyncSuspended() &&
			!isSyncEngineOwnedPath(plugin, path)
		) {
			logger.info("vault_event.enqueued", {
				path,
				event,
				operation: "delete",
			});
			engine.enqueueDelete(path);
		} else {
			logger.debug("vault_event.skipped", {
				path,
				event,
				reason: plugin.isSyncSuspended()
					? "suspended"
					: "sync_owned_path",
			});
		}
	};

	// Notes: rely on the vault's `modify`/`create` events (fired once Obsidian
	// has flushed to disk) rather than `editor-change`, so the engine always
	// reads back what was actually written rather than a stale/half-typed
	// buffer.
	// A plugin loaded during Obsidian startup can otherwise observe the initial
	// vault index as a burst of user-created files. Bootstrap archives already
	// carry a tip revision, so replaying those unchanged files needlessly
	// advances the server and makes every newly-opened client echo the vault.
	// The workspace is not editable before layout-ready, making it the natural
	// boundary between index construction and genuine user Vault events.
	let acceptVaultEvents = true;
	plugin.register(() => {
		acceptVaultEvents = false;
	});
	plugin.app.workspace.onLayoutReady(() => {
		if (!acceptVaultEvents) {
			logger.debug("vault_events.not_registered", {
				reason: "plugin_unloaded",
			});
			return;
		}
		logger.info("vault_events.registered");
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
	});

	void engine.hydrate().catch((error) => {
		logger.error("hydrate.failed", { error });
	});

	plugin.register(() => {
		void engine.flush().catch((error) => {
			status.lastError =
				error instanceof Error ? error.message : String(error);
			logger.error("unload_flush.failed", { error });
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
				logger.debug("interval_tick.status_updated", {
					ok: result.ok,
					pushed: result.pushed,
					applied: result.applied,
					deadLettered: result.deadLettered,
					lastError: status.lastError,
				});
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
	const logger = plugin.logger.child("seed");
	logger.info("vault_scan.started");
	const allFiles = await sync.fs.listAllFiles();
	const files = allFiles.filter(
		(path) => !isSyncEngineOwnedPath(plugin, path),
	);
	const includedPaths = new Set(files);
	logger.info("vault_scan.completed", {
		discoveredFiles: allFiles.length,
		includedFiles: files.length,
		excludedFiles: allFiles.length - files.length,
	});
	for (const path of files) {
		logger.debug("vault_scan.file_included", { path });
	}
	for (const path of allFiles) {
		if (!includedPaths.has(path)) {
			logger.debug("vault_scan.file_excluded", {
				path,
				reason: "sync_owned_path",
			});
		}
	}
	await sync.engine.seedFromVault(() => files);
	logger.info("flush.started", { fileCount: files.length });
	await sync.engine.flush();
	logger.info("final_tick.started", { fileCount: files.length });
	const result = await sync.engine.tick();
	logger.info("final_tick.completed", {
		ok: result.ok,
		pushed: result.pushed,
		applied: result.applied,
		deadLettered: result.deadLettered,
		...(result.ok ? {} : { error: result.error }),
	});
	return result;
}
