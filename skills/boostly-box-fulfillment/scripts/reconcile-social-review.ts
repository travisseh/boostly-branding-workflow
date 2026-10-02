import { parseFulfillmentResult } from "./fulfillment-artifacts.ts";
import { generateFulfillmentArtifacts } from "./generate-fulfillment-artifacts.ts";
import { normalizedLines, type ContentUpdate } from "./notion-review-refresh.ts";

const obsolete = /social_writer_replays_logo_and_color_fields; URL-only writer required|Social URL-only endpoint is not deployed; engineering must deploy it before this verified URL can be saved\./;
const technical = "Social URL-only endpoint is not deployed; verified social writes await engineering deployment.";

// Reconcile only known obsolete machine-generated reasons, against current typed evidence.
export function reconcileSocialReview(markdown: string, values: unknown[]): ContentUpdate[] {
  const results = values.map(parseFulfillmentResult);
  const byRequest = new Map(results.map(result => [result.plan.request.fulfillment_request_id, result]));
  const lines = markdown.split("\n");
  const updates: ContentUpdate[] = [];
  let request: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const identity = lines[i].match(/^(?:- Fulfillment request: |Request: )([a-z0-9]+)$/);
    if (identity) request = identity[1];
    const result = byRequest.get(request);
    if (!result) continue;
    if (lines[i] === `- [ ] ${technical}` || lines[i] === `- [ ] Technical blocker: ${technical}`) {
      if (result.operational_blockers?.some(reason => reason.includes(technical))) continue;
      const end = lines[i + 1] === "Next action: resolve the tooling failure, rerun verification, and confirm production readback." ? i + 2 : i + 1;
      updates.push({ old_str: lines.slice(i, end).join("\n"), new_str: "" });
      continue;
    }
    if (!lines[i].startsWith("- [ ] ")) continue;
    const single = obsolete.test(lines[i]);
    const batch = /^Reason: /.test(lines[i + 1] ?? "") && obsolete.test(lines[i + 1]);
    if (!single && !batch) continue;
    const url = normalizedLines(lines[i])[0]?.match(/^- \[ \] [^:]+: (https?:\/\/\S+)/)?.[1];
    if (!url) throw new Error("Unrecognized obsolete social checklist row");
    const current = String(generateFulfillmentArtifacts(result).notion_checklist).split("\n")
      .find(line => (line.startsWith("- [x] ") || line.startsWith("- [ ] ")) && (line.endsWith(`: ${url}`) || line.includes(`: ${url} - `)) && !obsolete.test(line));
    if (!current) throw new Error(`No verified current replacement for obsolete social row in ${request}`);
    if (batch && !lines[i + 2]?.startsWith("Next action: ")) throw new Error("Obsolete social review structure changed");
    updates.push({ old_str: lines.slice(i, i + (batch ? 3 : 1)).join("\n"), new_str: current });
  }
  // Refuse a context-dependent replacement that would also affect another request.
  const unique = [...new Map(updates.map(update => [update.old_str, update])).values()];
  for (const update of unique) {
    if (updates.some(other => other.old_str === update.old_str && other.new_str !== update.new_str)) throw new Error("Conflicting review replacement across locations");
    const actual = markdown.split(update.old_str).length - 1;
    const expected = updates.filter(other => other.old_str === update.old_str).length;
    if (actual !== expected) throw new Error("Obsolete text also appears outside validated request context");
    update.replace_all_matches = actual > 1;
  }
  return unique;
}
