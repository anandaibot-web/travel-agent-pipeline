#!/bin/bash
# run.sh — Start all Vedic Journeys processes
#
# Starts:
#   1. OpenClaw gateway (WhatsApp bridge) — foreground mode for WSL
#   2. mediaWatcher.js (image detection + pipeline trigger)
#   3. senderWebhook.js (sender identification HTTP server)
#
# Usage: bash run.sh
# Stop:  Ctrl+C

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load env (handles inline comments and blank lines)
if [ -f .env ]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    clean="${line%%#*}"
    clean="${clean%"${clean##*[![:space:]]}"}"
    [[ -n "$clean" ]] && export "$clean" 2>/dev/null || true
  done < .env
fi

OPENCLAW_BIN="${OPENCLAW_BIN:-$(which openclaw 2>/dev/null || echo /home/anandixit/.npm-global/bin/openclaw)}"

if [ ! -f "$OPENCLAW_BIN" ] && ! command -v openclaw &>/dev/null; then
  echo "❌ openclaw not found. Set OPENCLAW_BIN in .env or ensure it's on PATH."
  exit 1
fi

cleanup() {
  echo ""
  echo "🛑 Stopping all processes..."
  kill "$OPENCLAW_PID" "$WATCHER_PID" "$WEBHOOK_PID" 2>/dev/null || true
  wait "$OPENCLAW_PID" "$WATCHER_PID" "$WEBHOOK_PID" 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

# ── Start OpenClaw gateway in foreground (WSL-compatible, no systemd) ──
echo "🦞 Starting OpenClaw gateway (foreground)..."
"$OPENCLAW_BIN" gateway run --force &
OPENCLAW_PID=$!

# Wait for gateway to be ready before starting watchers
echo "   Waiting for gateway to initialise..."
sleep 6

# Verify gateway came up
if ! kill -0 "$OPENCLAW_PID" 2>/dev/null; then
  echo "❌ OpenClaw gateway failed to start. Check output above."
  exit 1
fi
echo "   ✅ Gateway running (PID $OPENCLAW_PID)"

# ── Start Node services ──
echo "👀 Starting mediaWatcher..."
node watcher/mediaWatcher.js &
WATCHER_PID=$!

# In ~/travel-agent/run.sh, add this alongside mediaWatcher:
node watcher/pipelineWebhook.js &
WEBHOOK_PID=$!
echo "🌐 Pipeline webhook PID: $WEBHOOK_PID"

# Add to the cleanup trap:
kill $WEBHOOK_PID 2>/dev/null


echo "🔌 Starting senderWebhook..."
node watcher/senderWebhook.js &
WEBHOOK_PID=$!

echo ""
echo "✅ All processes running."
echo "   OpenClaw PID  : $OPENCLAW_PID"
echo "   Watcher PID   : $WATCHER_PID"
echo "   Webhook PID   : $WEBHOOK_PID"
echo ""
echo "Press Ctrl+C to stop all."
echo ""

wait