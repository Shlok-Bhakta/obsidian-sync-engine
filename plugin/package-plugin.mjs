import { cp, mkdir, rm } from 'node:fs/promises';

const outputDirectory = 'obsidian-sync-engine';
const artifacts = ['main.js', 'manifest.json', 'styles.css'];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory);

await Promise.all(
	artifacts.map((artifact) =>
		cp(artifact, `${outputDirectory}/${artifact}`),
	),
);
