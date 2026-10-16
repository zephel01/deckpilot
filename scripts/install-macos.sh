#!/bin/bash
# Installs agent-meter into ~/.agent-meter and registers it as a LaunchAgent.
# Does NOT touch ~/.claude/settings.json — merge hooks/claude-settings.hooks.json yourself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.agent-meter"
LABEL="com.deckpilot.agent-meter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
	echo "node not found in PATH (Node.js 22.18+ required)" >&2
	exit 1
fi

(cd "$ROOT/agent-meter" && npm install --no-audit --no-fund && npm run build)

mkdir -p "$DEST"
chmod 700 "$DEST"
cp "$ROOT/agent-meter/dist/agent-meter.js" "$DEST/agent-meter.js"
cp "$ROOT/agent-meter/dist/agent-meter-hook.js" "$DEST/agent-meter-hook.js"
printf '{"type":"module"}\n' > "$DEST/package.json"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array><string>$NODE</string><string>$DEST/agent-meter.js</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$DEST/agent-meter.log</string>
	<key>StandardErrorPath</key><string>$DEST/agent-meter.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
echo "agent-meter installed. Token: $DEST/token (0600)"
tail -n 3 "$DEST/agent-meter.log" || true
