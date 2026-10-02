// render-badge-pdf.tsx: render ONE badge through the app's real react-pdf document (front page only matters).
// Copied into a Boostly worktree's scripts/ dir by render-badge-pdf.sh; do not run from the skill dir.
// args: <out.pdf> <touchpointUrl> <logoUrl|''> <printPrimary> <printSecondary> <printText> <printTextSecondary>
import { BadgePdfDocument } from '@/app/(main)/(protected)/in-store/badges/_shared/_components/badge-pdf-document';
import { BADGE_QR_PRINT_WIDTH } from '@/lib/constants/badge';
import { renderToBuffer } from '@react-pdf/renderer';
import fs from 'node:fs';
import qrcode from 'qrcode';

async function main() {
  const [, , out, url, logoUrl, primary, secondary, text, textSecondary] = process.argv;
  const qrDataUrl = await qrcode.toDataURL(url, {
    errorCorrectionLevel: 'M', margin: 1, width: BADGE_QR_PRINT_WIDTH, color: { dark: text, light: '#0000' },
  });
  const buf = Buffer.from(await renderToBuffer(BadgePdfDocument({ badges: [{
    id: 'proof', issue_id: 1, logoUrl: logoUrl || null, qrDataUrl,
    primaryColor: primary, secondaryColor: secondary, textColor: text, textSecondaryColor: textSecondary,
  }] })));
  fs.writeFileSync(out, buf);
  console.log(JSON.stringify({ wrote: out, bytes: buf.length }));
}
main().catch((e) => { console.error(e); process.exit(1); });
