# Bundled cwRsync (Windows x64)

The Windows installer ships cwRsync **6.5.0** (rsync **3.5.1**) as a private `upload_files`
runtime. It is not added to the system `PATH` and does not require Chocolatey,
Scoop, WSL, or MSYS2. The tool probes the bundled executable first, then a
system `rsync`, and finally retains the Windows `scp` fallback.

- Upstream archive: <https://itefix.net/download/free/cwrsync_6.5.0_x64_free.zip>
- Archive SHA-256: `8dc20afec889908c05c2abaa21d37f3fcad3e7ea5f3f37e95b25e6178f6b983a`
- rsync source and license: <https://github.com/RsyncProject/rsync>
- cwRsync distribution: <https://www.itefix.net/cwrsync/client>

The upstream zip is the source of truth. `npm run dist:win` verifies its hash
and extracts `bin/`, `etc/`, `README.rsync.txt`, and `VERSION.json`; those
extracted files are intentionally not committed. electron-builder packages
them only under `win.extraResources`, excluding the source zip and this README.
`LICENSE.cwRsync.txt` and `LICENSE.rsync.txt` are included in the installer.
