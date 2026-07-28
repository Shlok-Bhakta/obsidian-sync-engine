import { mkdir, rm, writeFile, cp, access } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const REPO_ROOT = join(import.meta.dir, "../..");
const PLUGIN_DIR = join(REPO_ROOT, "plugin");

/** 1x1 PNG (binary fixture). */
function tinyPng(): Uint8Array {
	// Precomputed minimal PNG
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
		0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
		0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	]);
}

export async function clearVault(vaultDir: string): Promise<void> {
	await rm(vaultDir, { recursive: true, force: true });
	await mkdir(vaultDir, { recursive: true });
}

/**
 * Sample vault covering the PoC surface: root md, nested md, empty folder,
 * binary image, and non-md text (html).
 */
export async function sampleVault(vaultDir: string): Promise<void> {
	await clearVault(vaultDir);
	await mkdir(join(vaultDir, "Notes"), { recursive: true });
	await mkdir(join(vaultDir, "empty-folder"), { recursive: true });
	await writeFile(join(vaultDir, "Welcome.md"), "# Hello\n\nSample note.\n");
	await writeFile(join(vaultDir, "Notes", "Ideas.md"), "# Ideas\n\n- one\n");
	await writeFile(join(vaultDir, "page.html"), "<html><body>hi</body></html>\n");
	await writeFile(join(vaultDir, "pixel.png"), tinyPng());
}

export async function ensurePluginBuilt(): Promise<void> {
	await $`npm run build`.cwd(PLUGIN_DIR);
}

export async function installPlugin(vaultDir: string): Promise<void> {
	await ensurePluginBuilt();
	const pluginId = "obsidian-sync-engine";
	const dest = join(vaultDir, ".obsidian", "plugins", pluginId);
	await mkdir(dest, { recursive: true });
	await cp(join(PLUGIN_DIR, "main.js"), join(dest, "main.js"));
	await cp(join(PLUGIN_DIR, "manifest.json"), join(dest, "manifest.json"));
	try {
		await access(join(PLUGIN_DIR, "styles.css"));
		await cp(join(PLUGIN_DIR, "styles.css"), join(dest, "styles.css"));
	} catch {
		/* optional */
	}
	await mkdir(join(vaultDir, ".obsidian"), { recursive: true });
	await writeFile(
		join(vaultDir, ".obsidian", "community-plugins.json"),
		JSON.stringify([pluginId]),
	);
	await writeFile(
		join(vaultDir, ".obsidian", "app.json"),
		JSON.stringify({ legacyEditor: false, livePreview: true }),
	);
}

export async function writeObsidianConfig(
	configDir: string,
	vaultContainerPath: string,
	vaultName: string,
): Promise<void> {
	const obsidianDir = join(configDir, ".config", "obsidian");
	await mkdir(obsidianDir, { recursive: true });
	await writeFile(
		join(obsidianDir, "obsidian.json"),
		JSON.stringify(
			{
				cli: true,
				vaults: {
					[vaultName]: {
						path: vaultContainerPath,
						ts: Date.now(),
						open: true,
					},
				},
			},
			null,
			2,
		),
	);
}

/** Paths the sample fixture creates (excluding .obsidian). */
export const SAMPLE_CONTENT_PATHS = [
	"Welcome.md",
	"Notes/Ideas.md",
	"page.html",
	"pixel.png",
] as const;
