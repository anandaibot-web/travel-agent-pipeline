#!/bin/bash
echo "🚀 Starting Vedic Journeys pipeline..."
node watcher/senderWebhook.js &
node watcher/mediaWatcher.js &
node watcher/pipelineWebhook.js &
echo "✅ All services running"
wait
