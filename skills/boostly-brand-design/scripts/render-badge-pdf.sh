#!/bin/zsh
# BADGE PDF PROOF: render the physical tap-card badge exactly as the app's download route does, from a
# `boostly-links branding get --json` readback (or an apply's `readback`), and rasterize page 1 at 300 dpi.
# usage: render-badge-pdf.sh --readback <readback.json> --out <proof.png> [--short-id <touchpoint short id>]
#        [--logo-url <url>] [--worktree <boostly worktree>]
# Catches what the web proof cannot: print text drawn on the print primary (QR + label invisible) and logo
# encodings react-pdf corrupts (palette PNG with bit depth < 8, 2026-09-10 Swine Dining / Wok the Line).
set -e
readback=""; out=""; short="PROOF"; logo=""; wt=""
while [[ $# -gt 0 ]]; do case "$1" in
  --readback) readback="$2"; shift 2;; --out) out="$2"; shift 2;; --short-id) short="$2"; shift 2;;
  --logo-url) logo="$2"; shift 2;; --worktree) wt="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
[[ -f "$readback" && -n "$out" ]] || { sed -n 2,8p "$0"; exit 2; }
if [[ -z "$wt" ]]; then
  for d in "${BOOSTLY_REPO_DIR:-$HOME/Programming/boostly}/" "$HOME/Programming/boostly-worktrees"/*/; do
    [[ -f "$d/src/app/api/touchpoints/badges/pdf/route.ts" && -d "$d/node_modules/@react-pdf" ]] && { wt="$d"; break; }
  done
fi
[[ -n "$wt" ]] || { echo "no Boostly worktree with the badge PDF route + node_modules found; pass --worktree" >&2; exit 3; }
vals=$(python3 - "$readback" "$logo" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); eb = r.get('effective_branding') or r.get('account_branding') or r
logo = sys.argv[2] or eb.get('logo_url') or ''
if eb.get('logo_attachment_id') and not logo:
    sys.stderr.write('readback has a logo_attachment_id but no logo_url; pass --logo-url (CDN url) or use the apply readback\n'); sys.exit(4)
p = eb.get('print_primary_color') or eb.get('web_primary_color') or '#6b7280'
s = eb.get('print_secondary_color') or eb.get('web_secondary_color') or p
t = eb.get('print_text_color') or eb.get('web_text_color') or '#ffffff'
ts = eb.get('print_text_secondary_color') or t
print('\n'.join([logo, p, s, t, ts]))
PY
)
lines=("${(@f)vals}")
tmp="$wt/scripts/.render-badge-pdf.$$.tsx"; cp "${0:A:h}/render-badge-pdf.tsx" "$tmp"
pdf="${out%.png}.pdf"
node22=$(ls -d ~/.nvm/versions/node/v22*/bin 2>/dev/null | tail -1)
( cd "$wt" && PATH="$node22:$PATH" npx tsx "scripts/.render-badge-pdf.$$.tsx" "$pdf" "https://boostly.app/t/$short" "${lines[1]}" "${lines[2]}" "${lines[3]}" "${lines[4]}" "${lines[5]}" ) || { rm -f "$tmp"; exit 5; }
rm -f "$tmp"
pdftoppm -r 300 -png -f 1 -l 1 "$pdf" "${out%.png}" >/dev/null && mv "${out%.png}-1.png" "$out"
echo "{\"proof\":\"$out\",\"pdf\":\"$pdf\",\"print_primary\":\"${lines[2]}\",\"print_text\":\"${lines[4]}\",\"logo\":\"${lines[1]}\"}"
PY_CONTRAST=$(python3 - "${lines[2]}" "${lines[4]}" <<'PY'
import sys
def lum(h):
    h=h.lstrip('#'); c=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    f=lambda v: v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
    return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])
a,b=lum(sys.argv[1]),lum(sys.argv[2]); print(round((max(a,b)+0.05)/(min(a,b)+0.05),2))
PY
)
echo "print text vs print primary contrast: $PY_CONTRAST (QR modules are drawn in the print text color on the print primary; require >= 3.0)"
