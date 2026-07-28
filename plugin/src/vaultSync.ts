import { normalizePath, requestUrl, type TAbstractFile } from 'obsidian';
import type MyPlugin from './main';
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
function getPluginDir(plugin: MyPlugin): string {
	return normalizePath(
		plugin.manifest.dir ??
			`${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`,
	);
}

function getOutboxPath(plugin: MyPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/outbox.jsonl`);
}

function getInboxPath(plugin: MyPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/inbox.jsonl`);
}

function getDataJsonPath(plugin: MyPlugin): string {
	return normalizePath(`${getPluginDir(plugin)}/data.json`);
}

/**
 * True for the sync engine's own bookkeeping files. These must never be
 * enqueued for sync themselves, or writing them (to record a sync) would
 * itself trigger another sync, forever.
 */
function isSyncEngineOwnedPath(plugin: MyPlugin, path: string): boolean {
	const normalized = normalizePath(path);
	return (
		normalized === getOutboxPath(plugin) ||
		normalized === getInboxPath(plugin) ||
		normalized === getDataJsonPath(plugin)
	);
}

function isConfigPath(plugin: MyPlugin, path: string): boolean {
	const normalizedPath = normalizePath(path);
	const configDir = normalizePath(plugin.app.vault.configDir);
	return (
		normalizedPath === configDir || normalizedPath.startsWith(`${configDir}/`)
	);
}

/**
 * Wraps `adapter.write`/`writeBinary` so that config-directory writes (theme
 * files, other plugins' settings, etc.) flow into the sync engine the same
 * way vault note edits do. Mirrors the plugin's previous direct-upload
 * behavior, just routed through `engine.enqueuePut` instead of a bespoke
 * POST.
 */
function hookAdapterWrites(
	plugin: MyPlugin,
	engine: SyncEngine,
	isExcluded: (path: string) => boolean,
): void {
	const adapter = plugin.app.vault.adapter;
	const write = adapter.write.bind(adapter);
	const writeBinary = adapter.writeBinary.bind(adapter);

	const maybeEnqueue = (path: string) => {
		if (isConfigPath(plugin, path) && !isExcluded(path)) {
			engine.enqueuePut(path);
		}
	};

	adapter.write = async (path, data, options) => {
		await write(path, data, options);
		maybeEnqueue(path);
	};
	adapter.writeBinary = async (path, data, options) => {
		await writeBinary(path, data, options);
		maybeEnqueue(path);
	};

	plugin.register(() => {
		adapter.write = write;
		adapter.writeBinary = writeBinary;
	});
}

/**
 * Builds the SyncEngine for this plugin instance and wires it up to vault
 * events (editor edits, deletes, config writes) and a periodic tick. Called
 * once from `onload`.
 */
export function registerVaultSync(plugin: MyPlugin): VaultSync {
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

	const isExcluded = (path: string) => isSyncEngineOwnedPath(plugin, path);

	plugin.registerEvent(
		plugin.app.workspace.on('editor-change', (_editor, info) => {
			const file = info.file;
			if (!file || isExcluded(file.path)) {
				return;
			}
			engine.enqueuePut(file.path);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on('delete', (file: TAbstractFile) => {
			if (isExcluded(file.path)) {
				return;
			}
			engine.enqueueDelete(file.path);
		}),
	);

	hookAdapterWrites(plugin, engine, isExcluded);

	plugin.registerInterval(
		window.setInterval(() => {
			void engine.tick().then(
				() => {
					status.lastTickAt = Date.now();
					status.lastError = null;
				},
				(error: unknown) => {
					status.lastError =
						error instanceof Error ? error.message : String(error);
				},
			);
		}, TICK_INTERVAL_MS),
	);

	return { engine, fs, outboxPath, status };
}

/** Enqueues every current vault file (minus the engine's own bookkeeping files) and pushes them out. */
export async function seedServerFromVault(
	plugin: MyPlugin,
	sync: VaultSync,
): Promise<void> {
	const files = (await sync.fs.listAllFiles()).filter(
		(path) => !isSyncEngineOwnedPath(plugin, path),
	);
	await sync.engine.seedFromVault(() => files);
	await sync.engine.tick();
}
