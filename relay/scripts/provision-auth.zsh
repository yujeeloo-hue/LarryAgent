#!/bin/zsh
# One-off: provision console credential on the relay server and restart.
set -euo pipefail
PW="relay-$(openssl rand -hex 4)"
SALT="$(openssl rand -base64 16 | tr -d '\n')"
HASH="$(node -e 'const c=require("crypto");console.log(c.scryptSync(process.argv[1],Buffer.from(process.argv[2],"base64"),64,{N:16384,r:8,p:1}).toString("base64"))' "$PW" "$SALT")"
ssh jnote-tencent "mkdir -p /opt/jellybot-relay/data && printf '{\n  \"username\": \"joji\",\n  \"salt\": \"$SALT\",\n  \"hash\": \"$HASH\"\n}\n' > /opt/jellybot-relay/data/auth.json && chmod 600 /opt/jellybot-relay/data/auth.json && systemctl restart jellybot-relay && sleep 1.5 && systemctl is-active jellybot-relay && curl -s http://127.0.0.1:8788/relay/api/health && echo && ls /opt/jellybot-relay/data/"
echo "PASSWORD=$PW"
