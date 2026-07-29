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

1. Set server URL + client name in settings
2. **Pair now** (or run the Authenticate command)
3. **Seed server** once for a fresh server
4. Second clients should use a bootstrap zip protected by the server's `BOOTSTRAP_TOKEN`

See the [repository README](../README.md) for limits, conflict policy, and privacy notes.
