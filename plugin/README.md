# Obsidian Sync Engine (plugin)

HTTP-polling sync client for a self-hosted vault sync server.

## Develop

```sh
npm ci
npm run dev    # watch build → main.js
npm run build  # typecheck + production bundle
npm run lint
bun test src/sync
```

The production build also creates an install-ready `obsidian-sync-engine/`
folder containing `main.js`, `manifest.json`, and `styles.css`.

## Install into a vault

Copy the generated `obsidian-sync-engine/` folder to:

```text
<Vault>/.obsidian/plugins/
```

Reload Obsidian and enable the plugin.

## Onboarding

1. Set the server URL and client name. An empty server enrolls this first client automatically.
2. Select **Seed server** once for a fresh server.
3. Select **Create client package** to add another device, then send it the copied five-minute link.
4. On the other device, open the link and select **Download ZIP**. The download works once.

See the [repository README](../README.md) for limits, conflict policy, and privacy notes.
