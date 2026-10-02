#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const DEFAULT_ENV_FILES = [
  `${process.env.HOME}/.config/boostly-branding/.env`,
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function usage() {
  console.error(`Usage:
  fetch-google-place-photos.mjs --place-id <id> --out-dir <dir> [--limit 10] [--max-width 1600] [--metadata <file>]

Loads GOOGLE_PLACES_API_KEY from the environment or the standard Boostly env files.
The command never prints the API key.`);
}

async function loadEnvValue(name) {
  if (process.env[name]) return process.env[name];
  for (const file of DEFAULT_ENV_FILES) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    const line = text
      .split(/\r?\n/)
      .find((candidate) => candidate.match(new RegExp(`^\\s*${name}=`)));
    if (!line) continue;
    return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function boundedInteger(raw, name, minimum, maximum, fallback) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} through ${maximum}`);
  }
  return value;
}

async function googleJson(url, apiKey, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      ...headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Google Places request failed with HTTP ${response.status}`);
  return body;
}

function extensionFor(contentType) {
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  return ".jpg";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const placeId = options["place-id"];
  const outDir = options["out-dir"];
  if (!placeId || !outDir) {
    usage();
    process.exitCode = 2;
    return;
  }

  const limit = boundedInteger(options.limit, "limit", 1, 10, 10);
  const maxWidth = boundedInteger(options["max-width"], "max-width", 1, 4800, 1600);
  const apiKey = await loadEnvValue("GOOGLE_PLACES_API_KEY");
  if (!apiKey) throw new Error("Missing GOOGLE_PLACES_API_KEY");

  const details = await googleJson(
    `${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`,
    apiKey,
    {
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,businessStatus,photos",
    },
  );
  if (details.id !== placeId) throw new Error("Google Places returned a different place ID");
  if (details.businessStatus === "CLOSED_PERMANENTLY") {
    throw new Error("Google Places reports this location permanently closed");
  }

  await mkdir(outDir, { recursive: true });
  const selected = (details.photos ?? []).slice(0, limit);
  const photos = [];

  for (let index = 0; index < selected.length; index += 1) {
    const photo = selected[index];
    const media = await googleJson(
      `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=${maxWidth}&skipHttpRedirect=true`,
      apiKey,
    );
    const response = await fetch(media.photoUri, { redirect: "follow" });
    if (!response.ok) throw new Error(`Photo ${index + 1} download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = extensionFor(response.headers.get("content-type") ?? "");
    const filename = `gbp-photo-${String(index + 1).padStart(2, "0")}${extension}`;
    const output = path.join(outDir, filename);
    await writeFile(output, bytes);
    photos.push({
      index: index + 1,
      file: output,
      width_px: photo.widthPx ?? null,
      height_px: photo.heightPx ?? null,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      author_attributions: photo.authorAttributions ?? [],
      google_photo_resource: photo.name,
      fetched_at: new Date().toISOString(),
    });
  }

  const metadataPath = options.metadata ?? path.join(outDir, "gbp-photos.json");
  const metadata = {
    schema_version: 1,
    source: "google_places_api_new",
    place_id: placeId,
    display_name: details.displayName?.text ?? null,
    formatted_address: details.formattedAddress ?? null,
    business_status: details.businessStatus ?? null,
    requested_limit: limit,
    returned_count: photos.length,
    photos,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    place_id: placeId,
    photo_count: photos.length,
    metadata: metadataPath,
    files: photos.map((photo) => photo.file),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
