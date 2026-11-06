#!/bin/sh
# jellybot-agentd launcher — runs the release's vendored Node binary.
# The vendored runtime guarantees node:sqlite and the exact Node major the
# bundle was built for; this script never falls back to a system node.
# --disable-warning=ExperimentalWarning: keep journald free of the node:sqlite
# experimental notice (the store has used it since v1 on every platform).
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/../lib/node/bin/node" --disable-warning=ExperimentalWarning "$HERE/../lib/agentd.mjs" "$@"
