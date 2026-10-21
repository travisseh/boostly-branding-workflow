import path from "node:path";
import type { NextConfig } from "next";

// The site imports the shared templates from ../skills/boostly-brand-design/templates (never copied),
// so the build root is the package repo, one level up.
const repoRoot = path.resolve(process.cwd(), "..");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  images: { unoptimized: true },
};

export default config;
