#!/bin/bash
# Start the game server + serve the frontend from a simple HTTP server
echo "Starting Conquest server on :3000..."
node server.js &
SERVER_PID=$!

echo "Serving frontend on :8080..."
cd ../frontend
python3 -m http.server 8080 &
FRONT_PID=$!

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║  Open TWO browser tabs:               ║"
echo "  ║  http://localhost:8080                 ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $SERVER_PID $FRONT_PID 2>/dev/null; exit" INT TERM
wait
