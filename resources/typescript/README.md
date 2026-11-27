# Bundled TypeScript language server

Dev Mode JavaScript / TypeScript completion, hover, signature help,
go-to-definition and Find Usages run the native TypeScript **7.0.2** compiler
(`tsc --lsp --stdio`) as a private helper. It is not added to the system
`PATH`, and the runtime never falls back to another server or to a project's
own `node_modules/typescript`: a packaged app uses `resources/typescript/` only;
development uses the extracted `win32-x64/` or `darwin-arm64/` folder in this
directory.

| Platform | npm package | Archive | SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `@typescript/typescript-win32-x64@7.0.2` | `typescript-win32-x64-7.0.2.tgz` | `61fc4e141d2bc687db580e71bbfa63b9c209f0310645d82ca1b457eb3a24fd19` |
| macOS arm64 | `@typescript/typescript-darwin-arm64@7.0.2` | `typescript-darwin-arm64-7.0.2.tgz` | `902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd` |

- Source: the npm registry tarballs above (`npm pack`), verified against the registry integrity.
- License: Apache-2.0 (`LICENSE` and `NOTICE.txt` from each archive are copied beside the binary).

The archives are the source of truth. `prepare-typescript-ls.mjs` (run by
`predev` / `prebuild`) verifies both hashes and extracts `tsc` / `tsc.exe`, the
`lib.*.d.ts` files it loads from its own folder, `LICENSE` and `NOTICE.txt` into
`win32-x64/` and `darwin-arm64/`; those extracted folders are intentionally not
committed. electron-builder packages only the matching platform folder as
`typescript/` (`mac.extraResources` / `win.extraResources`).
