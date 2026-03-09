#!/bin/bash
# start-pipeline.sh
# Starts the Vedic Journeys pipeline server + ngrok tunnel.
# Static ngrok domain — URL never changes.
#
# Usage:
#   ./start-pipeline.sh          — start
#   ./start-pipeline.sh stop     — stop
#   ./start-pipeline.sh status   — check what's running
#   ./start-pipeline.sh restart  — restart

PIPELINE_PORT=18791
NGROK_DOMAIN="carolin-uncrannied-connaturally.ngrok-free.dev"
PIPELINE_URL="https://${NGROK_DOMAIN}"

LOG_DIR="$HOME/travel-agent/logs"
PIPELINE_PID_FILE="$LOG_DIR/pipeline.pid"
NGROK_PID_FILE="$LOG_DIR/ngrok.pid"
PIPELINE_LOG="$LOG_DIR/pipeline.log"
NGROK_LOG="$LOG_DIR/ngrok.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$LOG_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }

# ─── Status ───────────────────────────────────────────────────────────────────
status() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "   Vedic Journeys Pipeline Status"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ -f "$PIPELINE_PID_FILE" ]; then
    PID=$(cat "$PIPELINE_PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      ok "Pipeline running (PID $PID) on port $PIPELINE_PORT"
    else
      warn "Pipeline dead — run: ./start-pipeline.sh restart"
      rm -f "$PIPELINE_PID_FILE"
    fi
  else
    err "Pipeline not running"
  fi

  if [ -f "$NGROK_PID_FILE" ]; then
    PID=$(cat "$NGROK_PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      ok "ngrok tunnel active"
      echo ""
      echo "   🌐 $PIPELINE_URL"
      echo "   → Vercel: PIPELINE_WEBHOOK_URL=$PIPELINE_URL"
    else
      warn "ngrok dead — run: ./start-pipeline.sh restart"
      rm -f "$NGROK_PID_FILE"
    fi
  else
    err "ngrok not running"
  fi

  echo ""
}

# ─── Stop ─────────────────────────────────────────────────────────────────────
stop() {
  echo "Stopping services..."

  if [ -f "$PIPELINE_PID_FILE" ]; then
    PID=$(cat "$PIPELINE_PID_FILE")
    kill "$PID" 2>/dev/null && ok "Pipeline stopped" || warn "Pipeline already stopped"
    rm -f "$PIPELINE_PID_FILE"
  fi

  if [ -f "$NGROK_PID_FILE" ]; then
    PID=$(cat "$NGROK_PID_FILE")
    kill "$PID" 2>/dev/null && ok "ngrok stopped" || warn "ngrok already stopped"
    rm -f "$NGROK_PID_FILE"
  fi

  lsof -ti:$PIPELINE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  echo ""
}

# ─── Start ────────────────────────────────────────────────────────────────────
start() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "   Starting Vedic Journeys Pipeline"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if ! command -v node &>/dev/null; then
    err "Node.js not found."; exit 1
  fi
  if ! command -v ngrok &>/dev/null; then
    err "ngrok not found. Install: https://ngrok.com/download"; exit 1
  fi

  # Kill anything on the port
  lsof -ti:$PIPELINE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1

  # ── Start pipeline ──────────────────────────────────────────────────────────
  echo -n "  Starting pipeline server..."
  cd "$SCRIPT_DIR"
  nohup node watcher/pipelineWebhook.js > "$PIPELINE_LOG" 2>&1 &
  PIPELINE_PID=$!
  echo $PIPELINE_PID > "$PIPELINE_PID_FILE"

  for i in {1..10}; do
    sleep 1
    if curl -s -o /dev/null \
         -H "x-pipeline-secret: ${PIPELINE_SECRET:-vj-pipeline-secret}" \
         http://127.0.0.1:$PIPELINE_PORT/health 2>/dev/null; then
      echo ""; ok "Pipeline server ready"; break
    fi
    echo -n "."
    if [ $i -eq 10 ]; then
      echo ""; err "Pipeline failed to start:"; tail -20 "$PIPELINE_LOG"
      rm -f "$PIPELINE_PID_FILE"; exit 1
    fi
  done

  # ── Start ngrok ─────────────────────────────────────────────────────────────
  echo -n "  Starting ngrok tunnel..."
  nohup ngrok http \
    --domain="$NGROK_DOMAIN" \
    $PIPELINE_PORT > "$NGROK_LOG" 2>&1 &
  NGROK_PID=$!
  echo $NGROK_PID > "$NGROK_PID_FILE"

  # Wait for tunnel
  for i in {1..15}; do
    sleep 1
    if curl -s "https://${NGROK_DOMAIN}" -o /dev/null 2>/dev/null; then
      echo ""; ok "ngrok tunnel active"; break
    fi
    echo -n "."
    if [ $i -eq 15 ]; then
      echo ""; warn "ngrok slow to start — check: tail -f $NGROK_LOG"
    fi
  done

  # ── Summary ─────────────────────────────────────────────────────────────────
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "   ✅ Ready!"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "   🌐 Pipeline URL:  $PIPELINE_URL"
  echo ""
  echo "   → Vercel env (set once, never changes):"
  echo "     PIPELINE_WEBHOOK_URL = $PIPELINE_URL"
  echo ""
  echo "   📋 Pipeline log: $PIPELINE_LOG"
  echo "   📋 ngrok log:    $NGROK_LOG"
  echo "   🛑 Stop:         ./start-pipeline.sh stop"
  echo ""
}

# ─── Entry point ──────────────────────────────────────────────────────────────
case "${1:-start}" in
  stop)    stop ;;
  status)  status ;;
  start)   start ;;
  restart) stop; sleep 1; start ;;
  *)
    err "Unknown command: $1"
    echo "Usage: $0 [start|stop|status|restart]"
    exit 1
    ;;
esac