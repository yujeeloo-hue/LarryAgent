# jellybot-agentd — headless JellyBot device node (linux-arm64)

Self-contained release: bundled agent runtime + vendored Node.js. Installs
under `/opt/jellybot-agentd/<version>` with a `current` symlink; systemd unit
`jellybot-agentd.service` runs it as the `jellybot-agent` user.

## Layout

```
/opt/jellybot-agentd/<version>/   release tree (this tarball's root)
/opt/jellybot-agentd/current      symlink → active release (systemd target)
/opt/jellybot-agentd/previous     symlink → one-step rollback target
/etc/jellybot-agent/settings.json     node config (0600, service user)
/var/lib/jellybot-agent/              sessions.sqlite, credentials, logs
/srv/jellybot-agent/workspaces/       workspace root (console folder picker)
```

## First run

```sh
sudo /opt/jellybot-agentd/current/bin/agentd setup   # relay URL + keys
sudo systemctl enable --now jellybot-agentd
journalctl -u jellybot-agentd -f
```

`agentd setup` asks for:

- **Relay server URL** — e.g. `https://remote.jellybot.cloud`
- **Relay API key** — create the device entry in the web console first
  (Devices → Add device → copy the key it shows once)
- **LLM provider** — base URL / model id / API key for console-started turns
  (same provider schema as the Mac app; empty key can be added later)

Secrets are read without echo and stored 0600 in
`/var/lib/jellybot-agent/llm-api-keys.json`; they never appear in logs.

## Operations

```sh
systemctl status jellybot-agentd         # service state
journalctl -u jellybot-agentd -n 50      # recent logs
sudo /opt/jellybot-agentd/current/bin/agentd version
# update (sha256 required for URLs):
agentd update https://…/jellybot-agentd-<v>-linux-arm64.tar.gz --sha256 <hex>
sudo /opt/jellybot-agentd/current/bin/agentd rollback
```

After it connects, the device appears in the web console (Devices) and can be
driven from the console: workspaces, sessions, live streams, approvals.

## Remote maintenance (console-driven, agentd ≥ 1.3.1)

One-time bootstrap on the device (SSH):

```sh
sudo /opt/jellybot-agentd/current/bin/agentd install-updater
```

This installs the root updater and the root reboot watcher
(`jellybot-agentd-update.path` + `jellybot-agentd-reboot.path`). Reboot does
not use sudoers: the agent service sets `NoNewPrivileges`, so sudo cannot
raise privileges. `--with-reboot` is accepted for older runbooks and changes
nothing. From then on the web console's **Devices → Maintenance** card can,
without SSH:

- **Restart** the agent service (graceful stop; systemd `Restart=always`
  revives it in seconds)
- **Update / Reinstall** — installs any release tarball (https URL must pin a
  sha256; `Fetch latest` reads the downloads manifest through the device).
  The device only queues the request when the updater path unit is active.
  A same-version force reinstall keeps the existing `previous` rollback
  target. If progress goes quiet and the updater is not running, the phase
  becomes failed and the card unlocks.
- **Reboot** the host — writes `reboot.json`; the root oneshot deletes it
  and runs `systemctl reboot`

Flow: console → relay (signaling only) → device writes a request file → root
updater downloads/installs from the origin directly → status file streams the
phase back. The relay never proxies release bytes.

