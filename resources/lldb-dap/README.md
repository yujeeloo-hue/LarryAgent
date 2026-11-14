# Larry lldb-dap (Windows)

The Windows installer ships the custom Larry `lldb-dap` (`23.1.1-larry.5`,
`pdbModuleAllowlist` + `loadModuleSymbols` + `deferredDebugEvents`) from
`lldb-dap-*-win-x64.zip`. Source and the tag live in the `llvm-project` fork
on branch `larry/pdb-module-allowlist`. Debug startup turns off LLDB's GDB JIT
loader so a GPU driver's shader JIT does not stop the process on every
compiled PSO. Since `23.1.1-larry.4` the Windows async-break injection is
reported as a `pause` stop instead of `exception`; `23.1.1-larry.5` also
attributes that pause to the process's initial (main) thread instead of the
transient injection thread.

`bin/` also contains the app-local VC++ runtime (`msvcp140.dll`,
`vcruntime140.dll`, `vcruntime140_1.dll`) so the adapter loads without a
separate Visual Studio redistributable. `bin/` and `lib/` are extracted at
`npm run dist:win` (and on first Debug start in unpackaged Windows builds).
Do not commit the extracted runtime.
