import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { upsertSummarySheet, stampSummaryOrderDate, orderDate, ORDER_PLACED_HEADER } from "./drive.mjs";

// Fail closed if a regression accidentally bypasses the injected local API.
globalThis.fetch = async () => { throw new Error("Network is forbidden in these tests"); };

const name = "Print order summary";
const header = ["Location", "Drive folder", "Offer", "Tables (promo + review sticker per table)", "Bathroom stalls (promo + review strip per stall)", "To-go label rolls", "POP sign sets", "Ship to name", "Address line 1", "Address line 2", "City", "State", "Zip"];
const rowFor = (zip, key = "Example Restaurant - request1") => ["Example Restaurant", key, "20% Off", 15, 2, 2, 1, "Example Recipient", "123 Test Street", "", "Madison", "NJ", zip];

function fixture(initialRows = [], { title = name, rowCount = 1000, corruptReadback = false } = {}) {
  const rows = structuredClone(initialRows);
  const calls = [];
  const metadata = { sheetId: 7, title, index: 0, sheetType: "GRID", gridProperties: { rowCount, columnCount: 26 } };
  const request = async (method, address, options = {}) => {
    const url = new URL(address);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, url, body });
    if (method === "POST" && url.hostname === "www.googleapis.com") {
      assert.equal(url.pathname, "/drive/v3/files");
      assert.deepEqual(body, { name, mimeType: "application/vnd.google-apps.spreadsheet", parents: ["parent"] });
      return { id: "sheet" };
    }
    assert.equal(url.hostname, "sheets.googleapis.com");
    if (method === "GET" && url.searchParams.get("fields") === "sheets.properties") {
      return { sheets: [{ properties: { ...metadata, title: "Unrelated tab", index: 1 } }, { properties: metadata }] };
    }
    const decoded = decodeURIComponent(url.pathname);
    const tabPrefix = `'${title.replace(/'/g, "''")}'`;
    if (method === "GET") {
      assert.equal(url.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE");
      const width = decoded.endsWith(`${tabPrefix}!A:N`) ? 14 : 13;
      if (width === 13) assert.ok(decoded.endsWith(`${tabPrefix}!A:M`));
      return { values: rows.map((r) => r.slice(0, width)) };
    }
    if (method === "POST" && decoded.endsWith("/values:batchUpdate")) {
      // The order-date stamp: single cells in column N only, RAW, verified readback.
      assert.equal(body.valueInputOption, "RAW");
      assert.equal(body.includeValuesInResponse, true);
      assert.equal(body.responseValueRenderOption, "UNFORMATTED_VALUE");
      const responses = [];
      for (const d of body.data) {
        assert.ok(d.range.startsWith(`${tabPrefix}!N`), `stamp range ${d.range} is in column N of the right tab`);
        const rowNumber = d.range.slice(tabPrefix.length + 2);
        assert.match(rowNumber, /^\d+$/);
        assert.equal(d.values.length, 1); assert.equal(d.values[0].length, 1);
        const index = Number(rowNumber) - 1;
        rows[index] = rows[index] || [];
        while (rows[index].length < 13) rows[index].push("");
        rows[index][13] = d.values[0][0];
        responses.push({ updatedData: { values: [[d.values[0][0]]] } });
      }
      return { responses };
    }
    if (method === "POST") {
      assert.ok(decoded.endsWith(":batchUpdate"));
      assert.equal(body.requests.length, 1);
      const append = body.requests[0].appendDimension;
      assert.deepEqual(append, { sheetId: metadata.sheetId, dimension: "ROWS", length: 1 });
      metadata.gridProperties.rowCount += append.length;
      return {};
    }
    assert.equal(method, "PUT"); // Never re-import a CSV or replace the file.
    assert.equal(url.searchParams.get("valueInputOption"), "RAW");
    assert.equal(url.searchParams.get("includeValuesInResponse"), "true");
    assert.equal(url.searchParams.get("responseValueRenderOption"), "UNFORMATTED_VALUE");
    assert.deepEqual(Object.keys(body).sort(), ["majorDimension", "range", "values"]);
    assert.equal(body.majorDimension, "ROWS");
    const [, first, last] = body.range.match(/!A(\d+):M(\d+)$/);
    assert.equal(body.values.length, Number(last) - Number(first) + 1);
    const actual = structuredClone(body.values);
    if (corruptReadback) actual.at(-1)[12] = Number(actual.at(-1)[12]);
    for (let i = 0; i < actual.length; i++) {
      const index = Number(first) - 1 + i;
      rows[index] = [...actual[i], ...(rows[index]?.slice(13) || [])];
    }
    // Google omits trailing blank cells in its response.
    return { updatedData: { values: actual.map((r) => {
      while (r.at(-1) === "") r.pop();
      return r;
    }) } };
  };
  return { rows, calls, request };
}

for (const zip of ["07940", "00501", "84043", "07940-1234", "SW1A 1AA"]) {
  for (const mode of ["create", "update"]) {
    test(`${mode}: stores postal ${zip} as text and quantities as numbers`, async () => {
      const untouched = [...rowFor("00501", "another-order"), "=SUM(D2:G2)"];
      const before = mode === "create" ? [] : [header, untouched, [...rowFor("7940"), "=SUM(D3:G3)"]];
      const f = fixture(before);
      const expected = rowFor(zip);
      const result = await upsertSummarySheet("parent", name, header, expected, mode === "update" ? "sheet" : undefined, f.request);
      const saved = f.rows[mode === "create" ? 1 : 2];
      assert.equal(saved[12], zip);
      assert.equal(typeof saved[12], "string");
      assert.deepEqual(saved.slice(3, 7), [15, 2, 2, 1]);
      assert.ok(saved.slice(3, 7).every((n) => typeof n === "number"));
      assert.equal(result.row_action, mode === "create" ? "appended" : "updated");
      assert.equal(result.rows, mode === "create" ? 1 : 2);
      assert.ok(result.webViewLink.endsWith("#gid=7"));
      if (mode === "update") {
        assert.deepEqual(f.rows[1], untouched);
        assert.equal(saved[13], "=SUM(D3:G3)");
        assert.equal(f.calls.filter((c) => c.method !== "GET").length, 1);
        assert.ok(f.calls.at(-1).body.range.endsWith("!A3:M3"));
      } else {
        assert.deepEqual(f.rows[0], header);
      }
    });
  }
}

test("append and retry update the same keyed row without rewriting earlier ZIPs", async () => {
  const oldRow = rowFor("00501", "old-order");
  const f = fixture([header, oldRow]);
  const first = await upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request);
  const second = await upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request);
  assert.equal(first.row_action, "appended");
  assert.equal(second.row_action, "updated");
  assert.equal(f.rows.length, 3);
  assert.deepEqual(f.rows[1], oldRow);
});

test("blank existing sheet is initialized; apostrophes in tab names are escaped", async () => {
  const f = fixture([], { title: "Vendor's summary" });
  await upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request);
  assert.deepEqual(f.rows, [header, rowFor("07940")]);
  assert.ok(f.calls.at(-1).body.range.startsWith("'Vendor''s summary'!"));
});

test("appends grid space only when needed, without formatting updates", async () => {
  const f = fixture([header, rowFor("00501", "old-order")], { rowCount: 2 });
  await upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request);
  assert.equal(f.rows.length, 3);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
});

test("missing postal code remains blank, without padding or invention", async () => {
  const f = fixture([header]);
  await upsertSummarySheet("parent", name, header, rowFor(""), "sheet", f.request);
  assert.equal(f.rows[1][12], "");
});

test("already numeric postal input fails before any request", async () => {
  const f = fixture();
  await assert.rejects(upsertSummarySheet("parent", name, header, rowFor(7940), undefined, f.request), /text postal code/);
  assert.equal(f.calls.length, 0);
});

test("coerced readback stops the handoff instead of silently reporting success", async () => {
  const f = fixture([header], { corruptReadback: true });
  await assert.rejects(upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request), /readback differs/);
});

for (const scenario of ["header", "duplicate"]) {
  test(`${scenario} ambiguity refuses to write`, async () => {
    const rows = scenario === "header" ? [["Other data"]] : [header, rowFor("07940"), rowFor("07940")];
    const f = fixture(rows);
    await assert.rejects(upsertSummarySheet("parent", name, header, rowFor("07940"), "sheet", f.request), /header changed|Duplicate/);
    assert.ok(f.calls.every((c) => c.method === "GET"));
  });
}

test("active upload entrypoint uses the typed writer, with no CSV conversion", () => {
  const source = readFileSync(new URL("../drive-upload.mjs", import.meta.url), "utf8");
  assert.match(source, /await upsertSummarySheet\(/);
  assert.doesNotMatch(source, /uploadCsvAsSheet|exportSheetCsv|toCsv\(|parseCsv\(/);
});

test("orderDate is the Mountain-time calendar date of the send", () => {
  assert.equal(orderDate("2026-10-14T21:38:36.255Z"), "2026-10-14");
  assert.equal(orderDate("2026-10-15T05:30:00.000Z"), "2026-10-14"); // 23:30 in Denver
  assert.equal(orderDate("2026-10-15T06:30:00.000Z"), "2026-10-15");
  assert.throws(() => orderDate("nope"), /Invalid send timestamp/);
});

test("order-date stamp writes the header once and the keyed row's N cell, leaving A:M alone", async () => {
  const other = rowFor("00501", "other-order");
  const mine = rowFor("07940");
  const f = fixture([header, other, mine]);
  const first = await stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "2026-10-14", f.request);
  assert.deepEqual({ action: first.action, header_action: first.header_action, row: first.row, previous: first.previous }, { action: "stamped", header_action: "written", row: 3, previous: null });
  assert.equal(f.rows[0][13], ORDER_PLACED_HEADER);
  assert.deepEqual(f.rows[0].slice(0, 13), header);
  assert.deepEqual(f.rows[1], other);
  assert.deepEqual(f.rows[2].slice(0, 13), mine);
  assert.equal(f.rows[2][13], "2026-10-14");
  const writes = f.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.data.map((d) => d.range), ["'Print order summary'!N1", "'Print order summary'!N3"]);
  // Second stamp with the same date is a no-op; a later date updates and reports the previous one.
  const again = await stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "2026-10-14", f.request);
  assert.equal(again.action, "unchanged");
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 1);
  const later = await stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "2026-10-20", f.request);
  assert.deepEqual({ action: later.action, previous: later.previous, header_action: later.header_action }, { action: "updated", previous: "2026-10-14", header_action: "existing" });
  assert.deepEqual(f.calls.at(-1).body.data.map((d) => d.range), ["'Print order summary'!N3"]);
});

test("order-date stamp refuses a missing row, a duplicate row, a foreign N header, or a bad date", async () => {
  const f = fixture([header, rowFor("07940")]);
  await assert.rejects(stampSummaryOrderDate("sheet", name, "nope - x", "2026-10-14", f.request), /No print order summary row/);
  await assert.rejects(stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "10/14/2026", f.request), /YYYY-MM-DD/);
  await assert.rejects(stampSummaryOrderDate(undefined, name, "Example Restaurant - request1", "2026-10-14", f.request), /No spreadsheet id/);
  const dup = fixture([header, rowFor("07940"), rowFor("07940")]);
  await assert.rejects(stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "2026-10-14", dup.request), /Duplicate/);
  const foreign = fixture([[...header, "Notes"], [...rowFor("07940"), "keep"]]);
  await assert.rejects(stampSummaryOrderDate("sheet", name, "Example Restaurant - request1", "2026-10-14", foreign.request), /column N header/);
  assert.equal(foreign.rows[1][13], "keep");
  for (const x of [f, dup, foreign]) assert.ok(x.calls.every((c) => c.method === "GET"));
});

test("the A:M row writer never touches column N and the email script stamps after the send", async () => {
  const f = fixture([[...header, ORDER_PLACED_HEADER], [...rowFor("07940"), "2026-10-14"]]);
  await upsertSummarySheet("parent", name, header, rowFor("07940-1234"), "sheet", f.request);
  assert.equal(f.rows[1][13], "2026-10-14");
  assert.equal(f.rows[1][12], "07940-1234");
  const email = readFileSync(new URL("../draft-email.mjs", import.meta.url), "utf8");
  assert.match(email, /await stampOrderDate\(\)/);
  assert.ok(email.indexOf("drafts\", \"send\"") < email.indexOf("await stampOrderDate()"), "stamp runs after drafts send");
  const upload = readFileSync(new URL("../drive-upload.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(upload, /stampSummaryOrderDate|ORDER_PLACED/);
});
