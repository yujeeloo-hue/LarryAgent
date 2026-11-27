# Larry Agent

A local-first AI agent workspace for macOS and Windows — multi-session agent
runs with tools, MCP servers, skills and a plan/execute FSM, plus a
self-hostable relay that mirrors the workspace to a web console reachable from
any device.

> This repository is a **source snapshot** of the current release. It carries
> no development history; it is replaced at each release.

## Downloads

Prebuilt installers (macOS dmg/zip, Windows exe) and the self-host relay
package live on the download sites:

- <https://larryagent.online/download/downloads.json>

## Build from source

Node.js 20+ required.

```sh
npm ci
npm run dev          # dev mode
npm run dist:mac     # macOS dmg + zip
npm run dist:win     # Windows NSIS exe
npm run build:relay  # relay web console payload (relay/public)
```

Release/deploy tooling is maintainer-only and not part of this snapshot.

## Self-hosting the relay

```sh
curl -fsSL https://larryagent.online/download/relay-install.sh | sudo bash -s --
```

The relay sources ship in `relay/` (including `relay/install.sh` and the
systemd unit).

## License

MIT — see [LICENSE](LICENSE).
