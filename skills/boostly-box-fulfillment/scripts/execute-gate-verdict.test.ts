import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertBrandingAssetSafe, type GateVerdict } from "./execute-fulfillment-plan.ts";
import type { WriteOperation } from "./fulfillment-plan.ts";

function pngFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-verdict-"));
  const file = path.join(dir, "final.png");
  // minimal PNG signature + IHDR header with color type 6 (truecolor RGBA); the gate battery is injected below
  const header = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "ascii"),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ]);
  fs.writeFileSync(file, header);
  return file;
}

function op(logo: string): WriteOperation {
  return { sequence: 1, kind: "branding", scope: "account", payload: { logo_file: logo, web_primary_color: "#C93B18" } } as unknown as WriteOperation;
}

test("branding write is refused on a HOLD verdict and proceeds on SHIP / SHIP-WITH-OVERRIDE, recording the verdict", () => {
  const logo = pngFile();
  const calls: string[][] = [];
  const stub = (verdict: GateVerdict) => (args: string[]) => { calls.push(args); return verdict; };

  assert.throws(
    () => assertBrandingAssetSafe(op(logo), { gateVerdict: stub({ verdict: "HOLD", reasons: ["render-legibility failed on final.png (illegible_at_product_size) with no override record"] }) }),
    /HOLD: render-legibility failed .* Record an override/,
  );
  const shipped = assertBrandingAssetSafe(op(logo), { runDir: "/tmp/run", gateVerdict: stub({ verdict: "SHIP", reasons: [] }) });
  assert.equal(shipped?.verdict, "SHIP");
  const withOverride = assertBrandingAssetSafe(op(logo), { gateVerdict: stub({ verdict: "SHIP-WITH-OVERRIDE", reasons: ["text-legibility failed; overridden by travisse"] }) });
  assert.equal(withOverride?.verdict, "SHIP-WITH-OVERRIDE");
  // the battery is asked with the exact asset, the primary, and the run dir when known
  assert.deepEqual(calls[1].slice(0, 7), ["check", "--asset", logo, "--color", "#C93B18", "--run", "/tmp/run"]);
  // no logo in the payload: nothing to gate
  assert.equal(assertBrandingAssetSafe({ ...op(logo), payload: { web_primary_color: "#C93B18" } } as unknown as WriteOperation, { gateVerdict: stub({ verdict: "HOLD", reasons: [] }) }), null);
});
