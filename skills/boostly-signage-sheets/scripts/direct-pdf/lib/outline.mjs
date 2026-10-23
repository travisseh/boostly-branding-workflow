// Text-to-outlines for the vendor PDFs (2026-10-22). The renderer sets real text in an embedded
// Figtree subset, which is a valid print PDF, but the vendor's prepress flow (customstickers.com)
// treats a live font as "text not embedded" and asked for outlined text, which is what Figma's
// exports carried (Type 3 glyph outlines). Ghostscript's pdfwrite with -dNoOutputFonts converts
// every glyph to paths; images stay lossless (Flate, no downsampling, colour untouched), page
// boxes and page count are unchanged. Verified pixel-identical outside glyph edges at 150 dpi.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const GS_ARGS = ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=pdfwrite', '-dNoOutputFonts',
  '-dColorConversionStrategy=/LeaveColorUnchanged', '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false',
  '-dDownsampleMonoImages=false', '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false',
  '-dColorImageFilter=/FlateEncode', '-dGrayImageFilter=/FlateEncode', '-dPreserveAnnots=true'];

export function ghostscript() {
  try { return execFileSync('gs', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

const fontLines = (p) => { try { return execFileSync('pdffonts', [p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').slice(2).filter(Boolean); } catch { return null; } };
const pageCount = (p) => { try { const m = execFileSync('pdfinfo', [p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/Pages:\s+(\d+)/); return m ? Number(m[1]) : null; } catch { return null; } };

// Outline src into dst (dst may equal src). Returns { outlined, gs, fonts_before, fonts_after, pages, bytes }
// or { outlined: false, reason } when Ghostscript is missing or the result fails its checks (src is left as is).
export function outlinePdf(src, dst = src) {
  const gs = ghostscript();
  if (!gs) return { outlined: false, reason: 'ghostscript missing (brew install ghostscript)' };
  const before = fontLines(src);
  const pagesBefore = pageCount(src);
  const tmp = path.join(path.dirname(dst), `.outline-${process.pid}-${path.basename(dst)}`);
  try {
    execFileSync('gs', [...GS_ARGS, `-sOutputFile=${tmp}`, src], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return { outlined: false, reason: `ghostscript failed: ${String(e.stderr || e.message).slice(0, 300)}` };
  }
  const after = fontLines(tmp);
  const pagesAfter = pageCount(tmp);
  if ((after && after.length) || (pagesBefore !== null && pagesAfter !== pagesBefore)) {
    fs.rmSync(tmp, { force: true });
    return { outlined: false, reason: `outline check failed (fonts left: ${after ? after.length : '?'}, pages ${pagesBefore} -> ${pagesAfter})` };
  }
  fs.renameSync(tmp, dst);
  return { outlined: true, gs, fonts_before: before ? before.length : null, fonts_after: 0, pages: pagesAfter, bytes: fs.statSync(dst).size };
}
