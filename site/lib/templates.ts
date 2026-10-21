// The shared preview templates, imported from the skill (never copied): one file drives the review
// canvas, the variant sheet raster, Figma checks and this site. UMD/CommonJS; module.exports is the API.
// @ts-ignore: plain JS module outside the site root, typed below
import raw from "../../skills/boostly-brand-design/templates/sheet-templates.js";

type Src = (rel: string) => string;
export type Templates = {
  SHEET_CSS: string;
  FONT_LINK_HTML: string;
  sheetHtml: (view: unknown, opts: { src?: Src; focus?: { letter: string } | null; selectable?: boolean }) => string;
  compareHtml: (view: unknown, letters: string[], opts: { src?: Src; colW?: number }) => string;
  signagePreviewHtml: (opts: { logoUrl: string | null; logoLightUrl: string | null; primary: string; accent: string; offer?: string; bathroomCopy?: string | null }) => string;
};

export const templates: Templates = ((raw as { default?: Templates }).default ?? raw) as Templates;
