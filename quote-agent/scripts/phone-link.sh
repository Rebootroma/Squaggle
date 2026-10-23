#!/bin/sh
# Makes a one-tap video-call link to the agent for a phone browser (camera + mic), for when
# FaceTime caller video is not available. Copies the link to the clipboard (Universal Clipboard
# pastes it on an iPhone signed in to the same Apple ID).
set -e
cd "$(dirname "$0")/.."
env_get() { grep "^$1=" .env.local | cut -d= -f2-; }
export LIVEKIT_URL="$(env_get LIVEKIT_URL)" LIVEKIT_API_KEY="$(env_get LIVEKIT_API_KEY)" LIVEKIT_API_SECRET="$(env_get LIVEKIT_API_SECRET)"
AGENT_NAME="$(env_get AGENT_NAME)"
LK="${LK:-$HOME/.local/bin/lk}"
ROOM="phone-$(date +%H%M%S)"

"$LK" room create "$ROOM" >/dev/null 2>&1
# Same signal chert dev sets at bridge_ready, so the agent greets when the caller joins.
"$LK" room update --metadata '{"chert_bridge_ready":true}' "$ROOM" >/dev/null 2>&1
"$LK" dispatch create --room "$ROOM" --agent-name "$AGENT_NAME" >/dev/null 2>&1
TOKEN="$("$LK" token create --join --room "$ROOM" --identity homeowner --valid-for 2h 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9._-]+' | head -1)"

URL="https://meet.livekit.io/custom?liveKitUrl=$LIVEKIT_URL&token=$TOKEN"
printf '%s' "$URL" | pbcopy
echo "Room: $ROOM (link valid 2 hours, copied to clipboard)"
echo "$URL"
