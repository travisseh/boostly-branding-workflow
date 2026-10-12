#!/usr/bin/env bash
# Installs the gmail-tools, google-tools and google-calendar-tools CLIs into ~/.config (code only).
# Secrets are never in this repo: the OAuth client keys file and your own account token are added afterwards
# (see docs/BOOTSTRAP.md step 3 item 9).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for d in gmail-tools google-tools google-calendar-tools; do
  mkdir -p "$HOME/.config/$d"
  for f in "$here/$d"/*; do
    base="$(basename "$f")"
    if [ -e "$HOME/.config/$d/$base" ] && ! cmp -s "$f" "$HOME/.config/$d/$base"; then
      cp "$HOME/.config/$d/$base" "$HOME/.config/$d/$base.bak-$(date +%Y%m%d)"
    fi
    cp "$f" "$HOME/.config/$d/$base"
  done
done
chmod +x "$HOME/.config/google-tools/google.js" "$HOME/.config/google-calendar-tools/calendar.js"
(cd "$HOME/.config/gmail-tools" && npm install --silent)
mkdir -p "$HOME/.config/google-calendar-mcp"
if [ ! -f "$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json" ]; then
  echo "MISSING: ~/.config/google-calendar-mcp/gcp-oauth.keys.json (OAuth client keys; Travisse sends this file out of band, mode 600)"
fi
echo "Then authorize your Boostly account once (prints a Google sign-in URL, callback on 127.0.0.1:3995):"
echo "  BOOSTLY_GOOGLE_EMAIL=you@boostly.com node ~/.config/google-tools/google.js add boostly"
echo "Check: node ~/.config/gmail-tools/gmail.js drafts list boostly 3"
