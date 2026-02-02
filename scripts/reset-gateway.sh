#!/bin/bash
# Reset OpenClaw gateway - clears sessions and restarts

set -e

echo "🧹 Clearing sessions..."
rm -rf ~/.openclaw/sessions/*
echo "✓ Sessions cleared"

echo ""
echo "🔄 Restarting gateway..."

# Kill existing gateway process
pkill -9 -f "openclaw.*gateway" 2>/dev/null || true
sleep 1

# Check if running as macOS app or standalone
if pgrep -f "OpenClaw.app" > /dev/null 2>&1; then
    echo "Detected macOS app - please restart from menubar"
    echo "Or run: open -a OpenClaw"
else
    # Standalone gateway - restart in background
    echo "Starting gateway..."
    nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
    sleep 2
    echo "✓ Gateway restarted"
fi

echo ""
echo "✅ Done! Gateway should be ready."
echo ""
echo "Check status with: openclaw channels status --probe"
