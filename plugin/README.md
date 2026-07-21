# Revision Sync for Obsidian

Revision Sync is an eventually consistent Obsidian plugin. Markdown documents merge through Yjs; other vault files use immutable SHA-256 objects with explicit conflict choices. Durable content travels over authenticated HTTP. WebSockets carry revision hints, authentication state, bootstrap status, and cursor presence only.

The plugin stores its revision metadata, retry outbox, cached payloads, and Yjs state inside its own plugin directory. Those files and `data.json` are excluded from vault synchronization. Ordinary editing has no telemetry or notices.

## Development

```sh
npm install
npm run build
npm run lint
npm test
```

For a manual installation, copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/obsidian-sync-engine/`, reload Obsidian, and enable **Revision Sync**. Configure an HTTPS server URL outside a trusted private network.
