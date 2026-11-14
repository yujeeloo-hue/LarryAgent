#!/bin/sh
# JellyBot Relay — self-host installer / upgrader.
#
# One-line install (latest release):
#   curl -fsSL https://larryagent.online/download/relay-install.sh | sudo bash -s --
#
# Manual install from a downloaded tarball:
#   tar -xzf jellybot-relay-<version>.tar.gz
#   cd jellybot-relay-<version> && sudo sh install.sh
#
# Re-running the same command upgrades in place. The data directory
# (<prefix>/data) is never touched; every replaced file is first moved aside
# as <name>.bak-<timestamp>. This script never deletes anything (its own
# scratch directory under /tmp excepted).
#
# Requirements: Linux, root, Node.js >= 22, curl, sha256sum, tar and systemd
# (or --no-systemd for a plain background process). The bundle is pure
# JavaScript — x64 and arm64 machines both work from the same tarball.
set -eu

MANIFEST_URLS="https://larryagent.online/download/downloads.json https://jellybot.cloud/download/downloads.json"
SERVICE_NAME=jellybot-relay
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PREFIX_DEFAULT=/opt/jellybot-relay
PORT="${JELLYBOT_RELAY_PORT:-8788}"
BASE_PATH="${JELLYBOT_RELAY_BASE_PATH:-/relay}"
VERSION=""
PREFIX=""
NO_SYSTEMD=0
FORCE=0

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
JellyBot Relay installer

  --version=X.Y.Z   install a specific release (default: latest from the manifest)
  --prefix=DIR      install directory (default /opt/jellybot-relay)
  --no-systemd      run the server as a background process without systemd (dev)
  --force           reinstall even when the installed version already matches
  --help            show this text

Environment overrides: JELLYBOT_RELAY_PORT (default 8788),
JELLYBOT_RELAY_BASE_PATH (default /relay).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#--version=}" ;;
    --prefix=*) PREFIX="${arg#--prefix=}" ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Linux" ] || die "this installer targets Linux (found $(uname -s))"
[ "$(id -u)" = "0" ] || die "please re-run as root, e.g.: curl -fsSL … | sudo bash -s --"
command -v node >/dev/null 2>&1 || die "Node.js >= 22 not found — install it from https://nodejs.org first"
NODE_BIN="$(command -v node)"
node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
case "$node_major" in
  ''|*[!0-9]*) die "cannot parse node version: $("$NODE_BIN" --version)" ;;
esac
[ "$node_major" -ge 22 ] || die "Node.js >= 22 required, found $("$NODE_BIN" --version)"
log "node $("$NODE_BIN" --version) ($("$NODE_BIN" -p 'process.arch'))"
for tool in curl sha256sum tar; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
if [ "$NO_SYSTEMD" != 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (use --no-systemd for a systemd-less setup)"
fi

# ------------------------------------------------- local (tarball) vs remote
unset CDPATH
SCRIPT_DIR="$(cd "$(dirname -- "$0")" && pwd)"
SRC=""
if [ -f "$SCRIPT_DIR/VERSION" ] && [ -d "$SCRIPT_DIR/dist" ]; then
  SRC="$SCRIPT_DIR"
  VERSION="$(cat "$SRC/VERSION")"
  log "local mode: installing from extracted tarball (v$VERSION)"
else
  # Remote mode: resolve the latest release from the download manifest.
  meta=""
  base_url=""
  for url in $MANIFEST_URLS; do
    manifest="$(curl -fsSL --max-time 20 "$url" 2>/dev/null)" || continue
    meta="$(printf '%s' "$manifest" | "$NODE_BIN" -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const relay = JSON.parse(raw).relay;
        if (!relay) process.exit(1);
        const safe = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
        if (!safe(relay.version) || !safe(relay.file) || !/^[0-9a-f]{64}$/.test(relay.sha256 || "")) process.exit(1);
        console.log(relay.version + "\t" + relay.file + "\t" + relay.sha256.toLowerCase());
      });
    ')" || continue
    base_url="${url%/download/downloads.json}"
    break
  done
  [ -n "$meta" ] || die "cannot read the release manifest (tried: $MANIFEST_URLS) — is the network up?"
  manifest_version="$(printf '%s' "$meta" | cut -f1)"
  manifest_file="$(printf '%s' "$meta" | cut -f2)"
  manifest_sha="$(printf '%s' "$meta" | cut -f3)"
  if [ -z "$VERSION" ]; then
    VERSION="$manifest_version"
    FILE="$manifest_file"
    EXPECTED_SHA="$manifest_sha"
  else
    FILE="jellybot-relay-${VERSION}.tar.gz"
    EXPECTED_SHA=""
    if [ "$VERSION" = "$manifest_version" ]; then
      EXPECTED_SHA="$manifest_sha"
    else
      sidecar="$(curl -fsSL --max-time 20 "${base_url}/download/${FILE}.sha256" 2>/dev/null)" \
        || die "version $VERSION is not the latest and has no .sha256 sidecar on the server"
      EXPECTED_SHA="$(printf '%s' "$sidecar" | awk 'NR==1 {print $1}')"
      case "$EXPECTED_SHA" in
        *[!0-9a-f]*|'') die "invalid .sha256 sidecar for $FILE" ;;
        ????????????????????????????????????????) ;; # 64 hex chars
        *) die "invalid .sha256 sidecar for $FILE" ;;
      esac
    fi
  fi
  log "remote mode: latest relay release is v$manifest_version, installing v$VERSION"
fi

[ "${PREFIX:-}" ] || PREFIX="$PREFIX_DEFAULT"

# ----------------------------------------------------------------- download
if [ -n "$SRC" ]; then
  tmpdir=""
else
  tmpdir="$(mktemp -d "/tmp/${SERVICE_NAME}-install.XXXXXX")"
  # Scratch only: this dir was created by us, seconds ago, in /tmp.
  trap '[ -n "$tmpdir" ] && rm -rf "$tmpdir"' EXIT
  log "downloading ${FILE} from ${base_url}/download/"
  curl -fL --retry 3 --max-time 300 -o "$tmpdir/$FILE" "${base_url}/download/${FILE}" \
    || die "download failed: ${base_url}/download/${FILE}"
  printf '%s  %s\n' "$EXPECTED_SHA" "$tmpdir/$FILE" | sha256sum -c - >/dev/null \
    || die "sha256 mismatch for $FILE — the download is corrupted or the manifest is stale"
  log "sha256 verified"
  tar -xzf "$tmpdir/$FILE" -C "$tmpdir" || die "tar extraction failed"
  for d in "$tmpdir"/jellybot-relay-*/; do
    [ -d "$d" ] && SRC="$d"
  done
  [ -n "$SRC" ] || die "tarball did not contain a jellybot-relay-<version>/ directory"
fi

# ------------------------------------------------------------------ install
ts="$(date +%Y%m%d-%H%M%S)"
already_current=0
if [ -f "$PREFIX/VERSION" ] && [ "$(cat "$PREFIX/VERSION" 2>/dev/null || true)" = "$VERSION" ] && [ "$FORCE" != 1 ]; then
  already_current=1
  log "v$VERSION already installed at $PREFIX (use --force to reinstall)"
else
  mkdir -p "$PREFIX"
  for item in dist public node_modules package.json package-lock.json install.sh jellybot-relay.service VERSION; do
    [ -e "$SRC/$item" ] || continue
    if [ -e "$PREFIX/$item" ]; then
      mv "$PREFIX/$item" "$PREFIX/$item.bak-$ts"
      log "backed up $item -> $item.bak-$ts"
    fi
    cp -a "$SRC/$item" "$PREFIX/$item"
  done
  log "installed v$VERSION -> $PREFIX (data dir untouched)"
fi

# ------------------------------------------------------------------ runtime
health_url="http://127.0.0.1:${PORT}${BASE_PATH}/api/health"
poll_health() {
  i=0
  while [ "$i" -lt 30 ]; do
    out="$(curl -fsS --max-time 3 "$health_url" 2>/dev/null || true)"
    case "$out" in
      *'"ok":true'*) printf '%s' "$out"; return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if [ "$NO_SYSTEMD" = 1 ]; then
  if [ -f "$PREFIX/relay.pid" ] && kill -0 "$(cat "$PREFIX/relay.pid" 2>/dev/null)" 2>/dev/null; then
    die "a no-systemd instance is already running (pid $(cat "$PREFIX/relay.pid")) — stop it before reinstalling"
  fi
  if [ "$already_current" != 1 ]; then
    :  # files were just replaced; fall through and (re)start below
  fi
  log "starting without systemd (dev mode; logs -> $PREFIX/relay.log)"
  (
    cd "$PREFIX"
    nohup env RELAY_HOST=127.0.0.1 RELAY_PORT="$PORT" RELAY_BASE_PATH="$BASE_PATH" \
      RELAY_DATA_DIR="$PREFIX/data" RELAY_PUBLIC_DIR="$PREFIX/public" \
      "$NODE_BIN" dist/index.js >> "$PREFIX/relay.log" 2>&1 &
    echo $! > "$PREFIX/relay.pid"
  )
  poll_health >/dev/null || die "server did not become healthy within 30s — check $PREFIX/relay.log"
  log "healthy: $(curl -fsS --max-time 3 "$health_url")"
  log_hint_creds="grep 'web console login' $PREFIX/relay.log"
else
  unit_new="$(mktemp "/tmp/${SERVICE_NAME}-unit.XXXXXX")"
  sed -e "s|__PREFIX__|$PREFIX|g" -e "s|__PORT__|$PORT|g" \
      -e "s|__BASE_PATH__|$BASE_PATH|g" -e "s|__NODE__|$NODE_BIN|g" \
      "$PREFIX/jellybot-relay.service" > "$unit_new"
  if [ -f "$UNIT_PATH" ] && ! cmp -s "$unit_new" "$UNIT_PATH"; then
    cp -a "$UNIT_PATH" "${UNIT_PATH}.bak-$ts"
    log "backed up unit -> ${SERVICE_NAME}.service.bak-$ts"
  fi
  if ! cmp -s "$unit_new" "$UNIT_PATH"; then
    # Scratch only: our own mktemp file from seconds ago.
    install -m 0644 "$unit_new" "$UNIT_PATH" && rm -f "$unit_new"
    log "wrote $UNIT_PATH"
  else
    rm -f "$unit_new"
    log "systemd unit unchanged"
  fi
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME" || die "systemctl restart failed — see: journalctl -u $SERVICE_NAME -n 50"
  poll_health >/dev/null || die "service did not become healthy within 30s — see: journalctl -u $SERVICE_NAME -n 50"
  log "healthy: $(curl -fsS --max-time 3 "$health_url")"
  log_hint_creds="journalctl -u $SERVICE_NAME | grep 'web console login'"
fi

# ------------------------------------------------------------------ summary
cat <<EOF

JellyBot Relay v$VERSION is running.

  Console (local):        http://127.0.0.1:$PORT$BASE_PATH/
  Console (via proxy):    https://<your-domain>$BASE_PATH/
  First-run login:        $log_hint_creds
                          (username: admin; the password was printed once on
                          first boot and stored hashed in $PREFIX/data/auth.json)
  Upgrade:                re-run this installer; data in $PREFIX/data is kept.

TLS is expected from a reverse proxy in front (the relay binds 127.0.0.1 only), e.g. Caddy:

  your-domain.example {
      reverse_proxy 127.0.0.1:$PORT
  }

EOF
