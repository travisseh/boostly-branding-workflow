import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertPdfSafeLogoEncoding } from "./execute-fulfillment-plan.ts";

test("indexed PNGs are rejected before production branding writes", () => {
  const file = writePngHeader(3);
  assert.throws(() => assertPdfSafeLogoEncoding(file), /indexed\/palette PNG/);
});

test("truecolor RGBA PNGs pass the PDF encoding gate", () => {
  const file = writePngHeader(6);
  assert.doesNotThrow(() => assertPdfSafeLogoEncoding(file));
});

function writePngHeader(colorType: number): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-logo-encoding-"));
  const file = path.join(directory, "logo.png");
  const header = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  Buffer.from("IHDR").copy(header, 12);
  header[24] = 8;
  header[25] = colorType;
  fs.writeFileSync(file, header);
  return file;
}
