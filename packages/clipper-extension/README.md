# Synaipse Web Clipper

A minimal Chrome MV3 extension that clips the current page (or selection) into your local Synaipse vault.

## Install (developer mode)

1. Make sure the Synaipse web server is running on `http://localhost:3001` (or wherever your `WEB_API_PORT` points).
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and pick the `packages/clipper-extension/` folder.
5. Pin the extension to the toolbar.

## Use it

1. Open any page.
2. Click the Synaipse icon → adjust the title, add comma-separated tags.
3. Optionally tick **Clip selection only** to clip just the highlighted text.
4. Hit **Clip page** → a note lands in your vault under `Clipped/YYYY-MM-DD-<slug>.md` with frontmatter (`title`, `source_url`, `tags: [clipped, ...]`).

Re-clipping the same URL updates the existing note instead of creating a duplicate.

## Settings

Right-click the extension icon → **Options** to point at a different server URL (e.g. `http://192.168.1.10:3001` for a vault hosted on another machine in your LAN).