---
name: record-obsidian-demo
description: Record short, cursor-free demos of this repository's Obsidian plugin with the disposable Podman E2E client, obsidian-cli, xdotool, and FFmpeg. Use for feature demos or issue/PR acceptance evidence. Always upload the verified MP4 to Planista by invoking $plan-tool, return the permalink, and remove local recording artifacts.
---

# Record an Obsidian Demo

## Rules

- Use a disposable vault from `e2e/src/obsidian-client.ts` and only a database URL containing `test_db`.
- Never record real vaults, credentials, tokens, or private data. Treat Planista links as public and unlisted.
- Keep the take around 10–20 seconds: initial state → interaction → obvious success.
- Capture only the Obsidian window with the cursor disabled. Do not create a poster.
- Always invoke `$plan-tool` after recording and verification, upload the MP4, and return its direct permalink.
- Do not commit media. Remove containers, temporary files, and invalidated demo credentials when done.

## Workflow

1. Start `test-db` from `compose.yaml` and wipe it with `wipeTestDatabase` from `e2e/src/stack.ts`.
2. Start `server/src/index.ts` in a managed terminal session with `HOST=0.0.0.0`, an unused port, and the `test_db` URL.
3. Create a unique `/tmp/obsidian-sync-demo.XXXXXX` directory. Use `ObsidianClient.prepareEmptyVaultWithPlugin()` and `.start()` to build the current plugin and launch a disposable client.
4. Resolve `host.containers.internal` inside the client container; never reuse an IP from another run.
5. Install FFmpeg inside the disposable container if absent:

   ```bash
   podman exec -u root "$DEMO_CONTAINER" sh -lc \
     'command -v ffmpeg >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg; }'
   ```

6. Open and drive the UI with `/opt/obsidian/obsidian-cli`. Focus controls through DOM evaluation and type with `xdotool`; avoid coordinate-based mouse actions.
7. Record immediately before the first action and stop a few seconds after success is visible.

## Capture

The usable display is `:0`, even if the container says otherwise. Run X tools as `abc` with `XAUTHORITY=/config/.Xauthority`.

Start FFmpeg detached. Root-window capture may be black, so capture the visible Obsidian window:

```bash
podman exec -d -u abc -e DISPLAY=:0 -e XAUTHORITY=/config/.Xauthority \
  "$DEMO_CONTAINER" sh -lc '
    window_id=$(xdotool search --onlyvisible --name Obsidian | head -n 1)
    test -n "$window_id"
    exec ffmpeg -y -loglevel warning \
      -f x11grab -framerate 15 -draw_mouse 0 -window_id "$window_id" -i :0.0 \
      -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
      -movflags +faststart /tmp/demo.mp4 >/tmp/demo-ffmpeg.log 2>&1
  '
```

`-draw_mouse 0` is mandatory. Stop FFmpeg inside the container with `SIGINT` and wait for MP4 finalization:

```bash
podman exec "$DEMO_CONTAINER" pkill -INT -x ffmpeg
while podman exec "$DEMO_CONTAINER" pgrep -x ffmpeg >/dev/null 2>&1; do sleep 1; done
```

Do not interrupt a foreground `podman exec ... ffmpeg`; that can produce an MP4 without a `moov` atom.

## Verify and publish

1. Run `ffprobe` on `/tmp/demo.mp4`, then `podman cp` it to a unique host path.
2. Inspect frames from the beginning, transition, and end. Re-record if the cursor appears, content is obscured, the take drags, success is unclear, or private data is visible.
3. Query the plugin through `obsidian-cli eval` to confirm the underlying state matches the video.
4. Stop the demo server and remove only the exact demo container.
5. Run `wipeTestDatabase` again before upload to invalidate any secret visible in the recording.
6. Invoke `$plan-tool`, follow its media-upload instructions, and upload the MP4 with `Content-Type: video/mp4`. Do this for every completed demo, without waiting for a separate upload request.
7. Verify the returned permalink serves `video/mp4`, return the link, and attach it to the authorized issue or PR when applicable.
8. Delete the local MP4 and frames after the upload succeeds. Remove the exact config directory with `podman unshare rm -rf` only after confirming it matches `/tmp/obsidian-sync-demo.*`.
9. Confirm no demo process, container, or artifact remains, then run `git status --short --branch`.

## Known failures

- Black video: capture the Obsidian `window_id`, not the X root.
- X connection error: force `DISPLAY=:0` and `XAUTHORITY=/config/.Xauthority`.
- Tiny or invalid MP4: re-record detached and stop FFmpeg with `pkill -INT` inside the container.
- Long idle lead-in: start capture and interactions in the same short sequence.
