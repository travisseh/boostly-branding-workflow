import { ensureProtocol, normalizeUrlForCompare } from "../../boostly-link-verifier/lib/verify-core.mjs";

const HARMLESS_QUERY_PARAMS = new Set([
  "diningOption",
  "fbclid",
  "gclid",
  "hl",
  "ls",
  "mibextid",
  "mode",
  "rwg_token",
  "dialogState"
]);

function canonicalEvalUrl(value) {
  if (!value) return "";
  try {
    const u = new URL(ensureProtocol(value));
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    u.hash = "";
    stripHarmlessParams(u);

    const social = canonicalSocialUrl(u);
    if (social) return social;

    if (u.hostname === "play.google.com" && u.pathname === "/store/apps/details") {
      const appId = cleanQueryValue(u.searchParams.get("id"));
      return appId ? `play.google.com/store/apps/details?id=${appId}` : normalizeUrlForCompare(u.toString());
    }

    if (u.hostname === "apps.apple.com") {
      const appId = u.pathname.match(/\/id(\d+)/i)?.[1];
      if (appId) return `apps.apple.com/app/id${appId}`;
    }

    if (u.hostname === "order.spoton.com") {
      const orderId = u.pathname.split("/").filter(Boolean).at(-1);
      if (/^[a-z0-9]{16,}$/i.test(orderId || "")) return `order.spoton.com/${orderId}`;
    }

    if (u.hostname === "order.toasttab.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "online" && parts[1]) return `order.toasttab.com/online/${parts[1]}`;
    }

    if (u.hostname === "toasttab.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0]) return `order.toasttab.com/online/${parts[0]}`;
    }

    if (u.hostname === "order.online") {
      const storeId = orderOnlineStoreId(u);
      if (storeId) return `order.online/store/${storeId}`;
    }

    if (u.hostname === "online.skytab.com") {
      const [id] = u.pathname.split("/").filter(Boolean);
      if (id) return `online.skytab.com/${id}`;
    }

    if (u.hostname.endsWith("ordercounter.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      return `${u.hostname}/${parts[0] || ""}`.replace(/\/$/, "");
    }

    if (u.hostname.endsWith("zenpepper.com")) {
      return u.hostname;
    }

    return normalizeUrlForCompare(u.toString());
  } catch {
    return normalizeUrlForCompare(value);
  }
}

function sameEvalUrl(a, b) {
  const left = canonicalEvalUrl(a);
  const right = canonicalEvalUrl(b);
  return Boolean(left && right && left === right);
}

function stripHarmlessParams(u) {
  for (const key of [...u.searchParams.keys()]) {
    if (HARMLESS_QUERY_PARAMS.has(key) || /^(utm_|mc_)/i.test(key)) u.searchParams.delete(key);
  }
  for (const [key, value] of [...u.searchParams.entries()]) {
    u.searchParams.set(key, cleanQueryValue(value));
  }
}

function canonicalSocialUrl(u) {
  if (u.hostname === "instagram.com") {
    const [handle] = u.pathname.split("/").filter(Boolean);
    if (handle && !["p", "reel", "reels", "stories", "explore", "accounts"].includes(handle.toLowerCase())) {
      return `instagram.com/${handle.toLowerCase()}`;
    }
  }

  if (u.hostname === "tiktok.com") {
    const [handle] = u.pathname.split("/").filter(Boolean);
    if (handle?.startsWith("@")) return `tiktok.com/${handle.toLowerCase()}`;
  }

  if (u.hostname === "x.com" || u.hostname === "twitter.com") {
    const [handle] = u.pathname.split("/").filter(Boolean);
    if (handle && !["i", "intent", "share", "search"].includes(handle.toLowerCase())) return `x.com/${handle.toLowerCase()}`;
  }

  if (u.hostname === "facebook.com") {
    const id = facebookNumericId(u);
    if (id) return `facebook.com/id/${id}`;
    const [handle] = u.pathname.split("/").filter(Boolean);
    if (handle && !["profile.php", "posts", "videos", "watch", "reel", "groups", "share"].includes(handle.toLowerCase())) {
      return `facebook.com/${handle.toLowerCase()}`;
    }
  }

  if (u.hostname === "youtube.com") {
    const [prefix, identifier] = u.pathname.split("/").filter(Boolean);
    if (prefix?.startsWith("@")) return `youtube.com/${prefix.toLowerCase()}`;
    if (["channel", "c", "user"].includes(prefix?.toLowerCase()) && identifier) return `youtube.com/${prefix.toLowerCase()}/${identifier.toLowerCase()}`;
  }

  return null;
}

function facebookNumericId(u) {
  if (u.pathname === "/profile.php") return cleanQueryValue(u.searchParams.get("id"));
  const parts = u.pathname.split("/").filter(Boolean);
  const pIndex = parts.findIndex((part) => part.toLowerCase() === "p");
  const candidate = pIndex >= 0 ? parts[pIndex + 1] : parts.at(-1);
  return candidate?.match(/(?:^|-)(\d{8,})(?:\/)?$/)?.[1] || "";
}

function orderOnlineStoreId(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const storeIndex = parts.findIndex((part) => part.toLowerCase() === "store");
  if (storeIndex < 0) return "";
  const candidate = cleanQueryValue(parts[storeIndex + 1]);
  return candidate?.match(/^\d+$/) ? candidate : "";
}

function cleanQueryValue(value) {
  return String(value || "").trim().replace(/^"+|"+$/g, "");
}

export { canonicalEvalUrl, sameEvalUrl };
