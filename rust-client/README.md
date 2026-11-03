# Rust client

Runs the plugin's sync engine without Obsidian. It keeps a vault directory in
two-way sync with the server, using the same HTTP protocol, `data.json` and
journal files as `plugin/`. Linux only.

## Install as a service

The unit in `systemd/` is a user unit, so run this as the vault's owner:

```sh
cargo build --release --locked
install -m 755 target/release/obsidian-sync-client ~/.local/bin/
install -m 644 systemd/obsidian-sync-client.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now obsidian-sync-client
```

The unit assumes the vault is at `~/obsidian-notes`, so edit `ExecStart` if yours
is elsewhere. A user unit only starts at boot with lingering on. Check with
`loginctl show-user $USER | grep Linger`, and turn it on with
`loginctl enable-linger $USER`.

The client reads its server URL, name and secret from
`.obsidian/plugins/obsidian-sync-engine/data.json` in the vault. The secret never
goes in the unit file or on a command line. Keep that file at mode 600.

## Commands

```sh
journalctl --user -u obsidian-sync-client -f    # watch it work
obsidian-sync-client status --vault ~/obsidian-notes
obsidian-sync-client verify --vault ~/obsidian-notes
obsidian-sync-client verify --vault ~/obsidian-notes --path "Some/Note.md"
```

`status` and `verify` only read from the server. `verify` downloads every file and
compares it with the disk, so it takes a while on a large vault.

## Using it alongside Obsidian

Don't run the two at once on the same vault. They share `data.json` and the
journals in `state/<server>/`, and each rewrites those files assuming it is alone.
Two writers would lose queued operations.

The client handles this for you. It checks for an Obsidian process every second
and pauses while one runs, so you can open the vault in Obsidian as usual. When
Obsidian exits, the client picks up the plugin's revision and journals and carries
on. Anything that changed on disk during that time was the plugin's to sync, so
the client records it and pushes nothing.

The check matches any Obsidian process owned by your user, including one that has
a different vault open. The client can take up to about a second to notice Obsidian
has started. The tests cover this with a stand-in process named `obsidian`, not a
real Obsidian install.

## How local changes are detected

Obsidian tells the plugin that a user edited a file. A filesystem watcher only
reports that bytes changed, and that includes the client's own writes. So the client
keeps a manifest, `state/<server>/rust-client-manifest.json`, with the hash of each
file as last synced or queued. A file is a local change only if its bytes differ
from the manifest.

- Inbound writes update the manifest, so their watcher events compare equal and do
  not echo.
- On restart, a stat pass finds what changed while the client was stopped. Each
  candidate is compared with the server first, so nothing the server already has is
  pushed again.
- Before applying an inbox line, the client compares that path with the manifest. An
  edit whose watcher event has not arrived yet gets queued, and the line waits.

## First run on an existing vault

With no manifest and a nonzero revision, the client records the disk as the baseline
and pushes nothing. It then applies the inbox from the revision in `data.json`, like
the plugin does. A file that is stale or missing locally is never read as a local
edit or delete. Files that are out of date but have no newer server revision stay as
they are, which `verify` will show.

At revision 0 the plugin uploads the whole vault automatically. This client refuses
unless you pass `--allow-seed`.

## Mass-push guard

More than 50 deletes or 300 changes within 10 minutes stops all network work, with
the queue left intact. A bad unmount or `rm -rf` then cannot reach your other devices.
The log shows `mass_push.halted`. Check the vault, and if the change is what you meant:

```sh
obsidian-sync-client approve-mass-push --vault ~/obsidian-notes
```

If it was a mistake, stop the service and restore the files before approving.
Change the limits with `--max-deletes` and `--max-puts`.

## Renaming the client

`clientName` is half of the `/auth` credential. The server looks up the name and
secret together, so editing the name in `data.json` alone makes auth fail. Rename it
on both sides with Obsidian closed:

```sh
obsidian-sync-client rename-client crabcake --vault ~/obsidian-notes
```

This calls `POST /reset-client-name`, the same endpoint as the plugin's settings
page. The name must be unique on the server.

## Conflicts

The policy matches the plugin. The last upload wins, a pending local edit is never
overwritten by an inbound change, and a delete carries a base revision so it cannot
remove a newer server copy.

One addition: if a file changed both locally and on the server while the client was
stopped, the local copy wins and the server's copy goes to
`state/<server>/conflicts/<timestamp>/<path>`. These copies do not sync. Nothing
cleans them up, so delete them when you're done.

## Differences from the plugin

There is no live connection in either client. The server has no websocket route, so
both poll: every 3 seconds, or 1 second after a local change.

Not ported, because they need Obsidian's UI or don't apply here:

- The settings page, status view, notices and client invite creation.
- Changing `serverUrl` at runtime. The client refuses to start if `serverIdentity`
  does not match `serverUrl`, where the plugin would reset the credentials.
- Migrating journals from the legacy 32-bit `serverIdentity`. The client refuses to
  start and asks you to open the vault in Obsidian once.
- The mutexes and in-flight tracking in `engine.ts`. All journal access here is on one
  thread.
- Obsidian's `normalizePath` Unicode changes (NFC, non-breaking spaces). Paths are
  used exactly as the filesystem and server report them.
- The `.bak` step in journal writes. POSIX rename already replaces atomically. A
  `.bak` left by the plugin is still recovered.

Changed on purpose:

- Failed ticks back off to 30 seconds instead of retrying every 3.
- Inbound writes skip the disk when the bytes already match, which covers the echo of
  our own uploads.
- Inbound paths inside the client's own state, or deletes that would remove it, are
  skipped. The plugin relies on the server never sending those.
- Dot-paths other than `.obsidian` are ignored as local changes, matching what
  Obsidian's vault index can see. Inbound changes to them still apply.
- A bare `404` in an error message does not count as a missing file. Only a real 404
  status does.

If you start the service after editing files with nothing running, those edits are
detected at startup. The exception is when `data.json` has moved past the manifest,
which means the plugin ran or the client crashed. The client then rebuilds the
manifest and pushes nothing, so such an edit stays local until the file changes again.

## Tests

```sh
cargo test
```

The interop suite runs the compiled client against the real server, with the plugin's
own `SyncEngine` and `HttpTransport` as the second device. It wipes `test_db`:

```sh
cargo build
podman compose up -d test-db    # from the repo root
cd e2e && bun install && bun test tests/rust-client
```
