#!/bin/sh
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/../lib/node/bin/node" --disable-warning=ExperimentalWarning "$HERE/../lib/agentd.mjs" "$@"
