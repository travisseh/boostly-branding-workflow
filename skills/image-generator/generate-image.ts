import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

const SIZE_ALIASES: Record<string, AspectRatio> = {
  square: "1:1",
  wide: "16:9",
  ultrawide: "21:9",
  tall: "9:16",
  portrait: "3:4",
  landscape: "4:3",
};

const RESOLUTIONS = ["1K", "2K", "4K"] as const;

// OpenAI image model. Default is GPT-Image-2.5 Sunburst (announced 2026-09-08).
// Override with --model <id> or OPENAI_IMAGE_MODEL. Previous default kept as a fallback option.
const OPENAI_DEFAULT_MODEL = "gpt-image-2.5-sunburst-2026-09-08";
const OPENAI_FALLBACK_MODEL = "gpt-image-2-2026-04-21";

const OPENAI_SIZE_MAP: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
};

const OPENAI_QUALITY_MAP: Record<string, "low" | "medium" | "high"> = {
  "1K": "medium",
  "2K": "high",
  "4K": "high",
};

function printUsage() {
  console.log(`
Usage: npx tsx generate-image.ts <prompt> [options]

Options:
  --ratio <ratio>    Aspect ratio (default: 1:1)
                     Values: ${ASPECT_RATIOS.join(", ")}
                     Aliases: ${Object.entries(SIZE_ALIASES).map(([k, v]) => `${k}=${v}`).join(", ")}
  --res <resolution> Image resolution: 1K, 2K, 4K (default: 1K)
  --ref <file>       Reference image path (for editing/context)
  --out <dir>        Output directory (default: ./generated)
  --name <name>      Output filename without extension (default: timestamp)
  --provider <p>     Force provider: openai or gemini (default: openai with gemini fallback)
  --model <id>       OpenAI image model id (default: ${OPENAI_DEFAULT_MODEL}; env OPENAI_IMAGE_MODEL)
                     Previous model: ${OPENAI_FALLBACK_MODEL}
  --quality <q>      OpenAI quality override: low, medium, high, xhigh, max, auto (default: from --res)
  --size <WxH>       OpenAI custom size, e.g. 2048x2048 (multiples of 16, 1:3..3:1, max edge 3840; overrides --ratio)
  --background <b>   OpenAI background: transparent, opaque, auto (png/webp only for transparent)
  --n <count>        OpenAI: number of images to return (default 1)
`);
}

function parseArgs(args: string[]) {
  const positional: string[] = [];
  let ratio: AspectRatio = "1:1";
  let resolution: string = "1K";
  let refImage: string | null = null;
  let outDir = "./generated";
  let name: string | null = null;
  let provider: "openai" | "gemini" | null = null;
  let model: string = process.env.OPENAI_IMAGE_MODEL || OPENAI_DEFAULT_MODEL;
  let quality: string | null = null;
  let size: string | null = null;
  let background: string | null = null;
  let n: number = 1;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--ratio" || arg === "-r") {
      const val = args[++i];
      ratio = (SIZE_ALIASES[val] ?? val) as AspectRatio;
      if (!ASPECT_RATIOS.includes(ratio)) {
        console.error(`Invalid ratio: ${val}. Use: ${ASPECT_RATIOS.join(", ")} or ${Object.keys(SIZE_ALIASES).join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "--res") {
      resolution = args[++i]?.toUpperCase();
      if (!RESOLUTIONS.includes(resolution as any)) {
        console.error(`Invalid resolution: ${resolution}. Use: ${RESOLUTIONS.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "--ref") {
      refImage = args[++i];
      if (!refImage || !fs.existsSync(refImage)) {
        console.error(`Reference image not found: ${refImage}`);
        process.exit(1);
      }
    } else if (arg === "--out") {
      outDir = args[++i];
    } else if (arg === "--name") {
      name = args[++i];
    } else if (arg === "--provider") {
      provider = args[++i] as "openai" | "gemini";
      if (!["openai", "gemini"].includes(provider)) {
        console.error(`Invalid provider: ${provider}. Use: openai, gemini`);
        process.exit(1);
      }
    } else if (arg === "--model") {
      model = args[++i];
      if (!model) {
        console.error("--model requires a model id.");
        process.exit(1);
      }
    } else if (arg === "--quality") {
      quality = args[++i];
      if (!["low", "medium", "high", "xhigh", "max", "auto"].includes(quality)) {
        console.error(`Invalid quality: ${quality}. Use: low, medium, high, xhigh, max, auto`);
        process.exit(1);
      }
    } else if (arg === "--size") {
      size = args[++i];
      if (!/^\d+x\d+$/.test(size ?? "")) {
        console.error(`Invalid size: ${size}. Use WIDTHxHEIGHT, e.g. 2048x2048`);
        process.exit(1);
      }
    } else if (arg === "--background") {
      background = args[++i];
      if (!["transparent", "opaque", "auto"].includes(background)) {
        console.error(`Invalid background: ${background}. Use: transparent, opaque, auto`);
        process.exit(1);
      }
    } else if (arg === "--n") {
      n = parseInt(args[++i], 10);
      if (!Number.isInteger(n) || n < 1) {
        console.error("--n requires a positive integer.");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
    i++;
  }

  const prompt = positional.join(" ");
  if (!prompt) {
    console.error("Error: prompt is required.\n");
    printUsage();
    process.exit(1);
  }

  return { prompt, ratio, resolution, refImage, outDir, name, provider, model, quality, size, background, n };
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return types[ext] ?? "image/png";
}

function getOutputPath(outDir: string, name: string | null, imageCount: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = name
    ? `${name}${imageCount > 1 ? `-${imageCount}` : ""}.png`
    : `${timestamp}.png`;
  return path.join(outDir, filename);
}

async function generateWithOpenAI(opts: {
  prompt: string;
  ratio: AspectRatio;
  resolution: string;
  refImage: string | null;
  outDir: string;
  name: string | null;
  model: string;
  quality?: string | null;
  size?: string | null;
  background?: string | null;
  n?: number;
}): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set, skipping OpenAI.");
    return false;
  }

  const openai = new OpenAI({ apiKey });

  const size = opts.size ?? OPENAI_SIZE_MAP[opts.ratio];
  if (!size) {
    console.error(`OpenAI doesn't support ratio ${opts.ratio}, falling back to Gemini.`);
    return false;
  }

  const quality = opts.quality ?? OPENAI_QUALITY_MAP[opts.resolution] ?? "medium";

  console.log(`Provider: OpenAI (${opts.model})`);
  console.log(`Prompt: "${opts.prompt}"`);
  console.log(`Size: ${size} | Quality: ${quality}`);

  const requestParams: any = {
    model: opts.model,
    prompt: opts.prompt,
    size,
    quality,
  };
  if (opts.background) requestParams.background = opts.background;
  if (opts.n && opts.n > 1) requestParams.n = opts.n;

  console.log("Generating...\n");

  const startedAt = Date.now();
  let response;
  try {
    if (opts.refImage) {
      // References go through the edits endpoint; generations rejects `image`.
      console.log(`Reference image: ${opts.refImage}`);
      const { toFile } = await import("openai");
      const refFile = await toFile(fs.createReadStream(opts.refImage), path.basename(opts.refImage), {
        type: getMimeType(opts.refImage),
      });
      response = await openai.images.edit({ ...requestParams, image: refFile });
    } else {
      response = await openai.images.generate(requestParams);
    }
  } catch (err: any) {
    console.error(`OpenAI error: ${err.message ?? err}`);
    return false;
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Elapsed: ${elapsedSec}s`);
  if ((response as any).usage) console.log(`Usage: ${JSON.stringify((response as any).usage)}`);

  fs.mkdirSync(opts.outDir, { recursive: true });

  let imageCount = 0;
  for (const image of response.data ?? []) {
    imageCount++;
    const outPath = getOutputPath(opts.outDir, opts.name, imageCount);
    if (image.b64_json) {
      const buffer = Buffer.from(image.b64_json, "base64");
      fs.writeFileSync(outPath, buffer);
      console.log(`Saved: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
    } else if (image.url) {
      console.log(`Image URL: ${image.url}`);
      const res = await fetch(image.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buffer);
      console.log(`Saved: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
    }
  }

  if (imageCount === 0) {
    console.error("Warning: No images returned from OpenAI.");
    return false;
  }

  return true;
}

async function generateWithGemini(opts: {
  prompt: string;
  ratio: AspectRatio;
  resolution: string;
  refImage: string | null;
  outDir: string;
  name: string | null;
}): Promise<boolean> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set.");
    return false;
  }

  const ai = new GoogleGenAI({ apiKey });

  const parts: any[] = [{ text: opts.prompt }];

  if (opts.refImage) {
    const imageData = fs.readFileSync(opts.refImage).toString("base64");
    parts.push({
      inlineData: {
        mimeType: getMimeType(opts.refImage),
        data: imageData,
      },
    });
    console.log(`Reference image: ${opts.refImage}`);
  }

  console.log(`Provider: Gemini (gemini-3-pro-image-preview)`);
  console.log(`Prompt: "${opts.prompt}"`);
  console.log(`Ratio: ${opts.ratio} | Resolution: ${opts.resolution}`);
  console.log("Generating...\n");

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-image-preview",
    contents: parts,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: opts.ratio,
      },
    },
  });

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    console.error("Error: No response from Gemini.");
    console.error(JSON.stringify(response, null, 2));
    return false;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });

  let imageCount = 0;
  for (const part of candidate.content.parts) {
    if (part.text) {
      console.log(part.text);
    }
    if (part.inlineData) {
      imageCount++;
      const outPath = getOutputPath(opts.outDir, opts.name, imageCount);
      const buffer = Buffer.from(part.inlineData.data!, "base64");
      fs.writeFileSync(outPath, buffer);
      console.log(`Saved: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
    }
  }

  if (imageCount === 0) {
    console.error("Warning: No images were returned from Gemini.");
    return false;
  }

  return true;
}

async function main() {
  const { prompt, ratio, resolution, refImage, outDir, name, provider, model, quality, size, background, n } = parseArgs(process.argv.slice(2));

  const opts = { prompt, ratio, resolution, refImage, outDir, name, model, quality, size, background, n };

  if (provider === "gemini") {
    const ok = await generateWithGemini(opts);
    if (!ok) process.exit(1);
    return;
  }

  if (provider === "openai") {
    const ok = await generateWithOpenAI(opts);
    if (!ok) process.exit(1);
    return;
  }

  // Default: try OpenAI first, fall back to Gemini
  const openaiOk = await generateWithOpenAI(opts);
  if (openaiOk) return;

  console.log("\nOpenAI failed or unavailable. Falling back to Gemini...\n");
  const geminiOk = await generateWithGemini(opts);
  if (!geminiOk) {
    console.error("Both providers failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
