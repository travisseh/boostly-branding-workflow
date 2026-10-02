# Gate parity fixtures

Exact shipped uploads and the gate JSON recorded in their run dirs at ship time, copied verbatim:

- `gregorios-reston-1B/`: runs-prod-2026-09-14/gregorios-trattoria-reston, applied 2026-09-15 (cell 1B, primary #C93B18, expected text "Gregorio's Trattoria"). Shipped under a recorded override: render-legibility (tiny text on TRATTORIA) and text-legibility OCR fail.
- `toscanos-winchester-S/`: runs-prod-2026-09-15/toscanos-winchester, applied 2026-09-15 (letter S, primary #8B2C1D, expected text "TOSCANO'S"). All recorded gates pass.

`scripts/gates.test.ts` reruns the registry-driven gates on these files and asserts every recorded field matches, so a threshold moved out of code into `references/gates.json` cannot silently change a result.
