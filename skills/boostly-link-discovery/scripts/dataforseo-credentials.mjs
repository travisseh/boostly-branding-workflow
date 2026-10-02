import { execFileSync } from "node:child_process";

export const DATAFORSEO_ACCOUNT = process.env.DATAFORSEO_LOGIN || "travisse@boostly.com";
export const DATAFORSEO_KEYCHAIN_SERVICE = "boostly-link-discovery.dataforseo";

function keychainPassword() {
  if (process.env.DATAFORSEO_PASSWORD) return process.env.DATAFORSEO_PASSWORD;
  try {
    return execFileSync("/usr/bin/security", [
      "find-generic-password", "-s", DATAFORSEO_KEYCHAIN_SERVICE,
      "-a", DATAFORSEO_ACCOUNT, "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    throw new Error("Boostly DataForSEO credential unavailable in macOS Keychain; no fallback account will be used.");
  }
}

export function dataForSeoCredentials(args = {}, readPassword = keychainPassword) {
  const password = readPassword();
  if (!password) throw new Error("Boostly DataForSEO credential is empty");
  const suppliedLogin = args.dataForSeoLogin || args["dataforseo-login"];
  const suppliedPassword = args.dataForSeoPassword || args["dataforseo-password"];
  if ((suppliedLogin && suppliedLogin !== DATAFORSEO_ACCOUNT) || (suppliedPassword && suppliedPassword !== password)) {
    throw new Error("DataForSEO override differs from the configured Boostly account; refusing alternate credentials.");
  }
  // Do not inherit unrelated DATAFORSEO_* shell variables from another project.
  return { login: DATAFORSEO_ACCOUNT, password };
}
