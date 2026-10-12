---
name: image-generator
description: Generate images from text prompts using OpenAI gpt-image-2.5-sunburst (primary) with Google Nano Banana 2.1 fallback. Use Nano Banana directly when the user says "nano banana", "nanobanana", or "use Gemini". Use whenever the user wants to create, make, or generate an image, hero banner, illustration, screenshot mockup, blog header, logo concept, or any visual asset. Also supports editing/remixing a reference image.
---

# Image Generator

Generates images with exactly two models:

1. **ChatGPT / OpenAI `gpt-image-2.5-sunburst-2026-09-08`** (GPT-Image-2.5 Sunburst): primary.
2. **Google Nano Banana 2.1 `gemini-nano-banana-2.1`** (released 2026-10-06): fallback, or primary when the user asks for Nano Banana.

**Never use older models** (gpt-image-2, gpt-image-1, Nano Banana Pro / gemini-3-pro-image, Nano Banana 2 / gemini-3.1-flash-image, gemini-2.5-flash-image, etc.). The script hardcodes both model IDs and rejects `--model`.

**Routing:** if the user says "nano banana", "nanobanana", or "Gemini", pass `--provider nanobanana`. Otherwise use the default (OpenAI, then Nano Banana 2.1 on failure or unsupported ratio).

Script and API keys live alongside this SKILL.md.

## How to run

```bash
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts "<prompt>" [options]
```

By default images save to `./generated/` relative to cwd. Override with `--out <dir>` to write to the current project (pass an absolute path to avoid confusion).

## Options

- `--ratio <r>` — `1:1`, `16:9`, `9:16`, `3:4`, `4:3`, `21:9`, `2:3`, `3:2`, `4:5`, `5:4`. Aliases: `square`, `wide`, `ultrawide`, `tall`, `portrait`, `landscape`. Default `1:1`.
- `--res <1K|2K|4K>` — default `1K`. OpenAI: maps to quality (1K=medium, 2K/4K=high). Nano Banana 2.1: native output size.
- `--ref <file>` — reference image for editing/remixing.
- `--out <dir>` — output directory (default `./generated`).
- `--name <name>` — filename without extension (default: timestamp).
- `--provider <p>` — `openai`/`chatgpt` or `nanobanana`/`nano-banana`/`gemini`. Default: OpenAI first, Nano Banana 2.1 fallback.
- `--quality <q>` — OpenAI quality override: `low`, `medium`, `high`, `xhigh`, `max`, `auto` (2.5 models). Overrides the `--res` mapping. Output cost scales with quality (`max` is roughly 4x `high` output tokens and ~2.5x the latency).
- `--size <WxH>` — OpenAI custom size, e.g. `2304x1600`. Multiples of 16, aspect between 1:3 and 3:1, max edge 3840, 655,360 to 8,294,400 total pixels. Overrides `--ratio` for OpenAI.
- `--background <b>` — OpenAI `transparent`, `opaque`, or `auto`. Transparent output needs png/webp. Note: 2.5 returns alpha in the 0..254 range with 1-2 unit noise; snap alpha before running binary gates.
- `--n <count>` — OpenAI: images per request.
- 2.5 models reject `input_fidelity`; do not pass it.

## Provider notes

- **OpenAI (gpt-image-2.5-sunburst)** — `--ratio` supports `1:1`, `16:9`, `9:16` only (other ratios auto-fallback to Nano Banana 2.1); use `--size WxH` for any other shape. The script prints `Elapsed:` and the `usage` token counts for cost tracking ($5/M text in, $8/M image in, $30/M out).
- **Nano Banana 2.1** — supports all aspect ratios plus `--ref` editing. Strong at visual design, mask-based editing, and subject consistency. OpenAI-only flags (`--quality`, `--size`, `--background`, `--n`) are ignored.

## Examples

```bash
# Hero banner (OpenAI primary)
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts \
  "moody dark SaaS hero banner, abstract gradient mesh" \
  --ratio wide --res 2K \
  --out /Users/travisse/Programming/personal-master/personal/artifacts/image-generator \
  --name hero

# Nano Banana 2.1 on request
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts \
  "portrait photo style headshot" \
  --ratio 3:4 --provider nanobanana \
  --out /Users/travisse/Programming/personal-master/personal/artifacts/image-generator

# Edit a reference image
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts \
  "make the background midnight blue and add soft bokeh" \
  --ref ./input.png --ratio wide
```

## Notes

- First run may need `npm i -g tsx` or install locally in the skill dir if tsx isn't available.
- If a provider declines a prompt, the script logs details so you can iterate.
- Per workspace convention, prefer writing output to `./artifacts/image-generator/` in the active project.
