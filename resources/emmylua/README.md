# Bundled emmylua_ls

Dev Mode Lua completion, hover, signature help and go-to-definition run
emmylua_ls **0.25.1** (emmylua-analyzer-rust) as a private helper. It is not
added to the system `PATH`, and the runtime never falls back to another server:
a packaged app uses `resources/emmylua/` only; development uses the extracted
`win32-x64/` or `darwin-arm64/` folder in this directory.

| Platform | Upstream archive | SHA-256 |
| --- | --- | --- |
| Windows x64 | `emmylua_ls-win32-x64.zip` | `82efa133287f67be09e1a624d8efecd8063832ec2b9bf9279c37afc5f42118bd` |
| macOS arm64 | `emmylua_ls-darwin-arm64.tar.gz` | `335023043cbc9ad683a13b24eb79f709a370215daf53673276b9a9663df96504` |

- Release page: <https://github.com/EmmyLuaLs/emmylua-analyzer-rust/releases/tag/0.25.1>
- License: MIT (`LICENSE`, taken from the same tag, is copied beside each binary).

The upstream archives are the source of truth. `prepare-emmylua.mjs` (run by
`predev` / `prebuild`) verifies both hashes and extracts `emmylua_ls` /
`emmylua_ls.exe` plus the license into `win32-x64/` and `darwin-arm64/`; those
extracted folders are intentionally not committed. electron-builder packages
only the matching platform folder as `emmylua/` (`mac.extraResources` /
`win.extraResources`).
