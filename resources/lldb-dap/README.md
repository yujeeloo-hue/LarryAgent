# Larry lldb-dap (Windows)

The Windows installer ships the custom Larry `lldb-dap` (`23.1.1-larry.2`,
`pdbModuleAllowlist` + `loadModuleSymbols`) from `lldb-dap-*-win-x64.zip`.

`bin/` and `lib/` are extracted at `npm run dist:win` (and on first Debug
start in unpackaged Windows builds). Do not commit the extracted runtime.
