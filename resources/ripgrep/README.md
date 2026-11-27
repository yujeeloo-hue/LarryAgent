# Bundled ripgrep

Dev Mode text search (Quick Open) runs ripgrep **14.1.1** as a private helper.
It is not added to the system `PATH`. The runtime probes the bundled binary
first and falls back to an `rg` on `PATH`.

| Platform | Upstream archive | SHA-256 |
| --- | --- | --- |
| Windows x64 | `ripgrep-14.1.1-x86_64-pc-windows-msvc.zip` | `d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1` |
| macOS arm64 | `ripgrep-14.1.1-aarch64-apple-darwin.tar.gz` | `24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be` |

- Release page: <https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1>
- License: MIT or Unlicense (`LICENSE-MIT` is extracted beside each binary).

The upstream archives are the source of truth. `prepare-ripgrep.mjs` (run by
`predev` / `prebuild`) verifies both hashes and extracts `rg` / `rg.exe` and
the license into `win32-x64/` and `darwin-arm64/`; those extracted folders are
intentionally not committed. electron-builder packages only the matching
platform folder as `ripgrep/` (`mac.extraResources` / `win.extraResources`).
