---
name: image-generator
description: Generate images from text prompts using OpenAI gpt-image-2.5-sunburst (primary) with Gemini fallback. Use whenever the user wants to create, make, or generate an image, hero banner, illustration, screenshot mockup, blog header, logo concept, or any visual asset. Also supports editing/remixing a reference image.
---

# Image Generator

Generates images via OpenAI's `gpt-image-2.5-sunburst-2026-09-08` (GPT-Image-2.5 Sunburst, primary) with Google Gemini `gemini-3-pro-image-preview` as fallback. Script and API keys live alongside this SKILL.md.

## How to run

```bash
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts "<prompt>" [options]
```

By default images save to `./generated/` relative to cwd. Override with `--out <dir>` to write to the current project (pass an absolute path to avoid confusion).

## Options

- `--ratio <r>` — `1:1`, `16:9`, `9:16`, `3:4`, `4:3`, `21:9`, `2:3`, `3:2`, `4:5`, `5:4`. Aliases: `square`, `wide`, `ultrawide`, `tall`, `portrait`, `landscape`. Default `1:1`.
- `--res <1K|2K|4K>` — default `1K`. Maps to OpenAI quality: 1K=medium, 2K/4K=high.
- `--ref <file>` — reference image for editing/remixing.
- `--out <dir>` — output directory (default `./generated`).
- `--name <name>` — filename without extension (default: timestamp).
- `--provider <openai|gemini>` — force a specific provider. Default: tries OpenAI first, falls back to Gemini.
- `--model <id>` — OpenAI image model id. Default `gpt-image-2.5-sunburst-2026-09-08` (env override `OPENAI_IMAGE_MODEL`). Use `gpt-image-2.5-flare` for faster everyday output or `gpt-image-2-2026-04-21` for the previous model.
- `--quality <q>` — OpenAI quality override: `low`, `medium`, `high`, `xhigh`, `max`, `auto` (2.5 models). Overrides the `--res` mapping. Output cost scales with quality (`max` is roughly 4x `high` output tokens and ~2.5x the latency).
- `--size <WxH>` — OpenAI custom size, e.g. `2304x1600`. Multiples of 16, aspect between 1:3 and 3:1, max edge 3840, 655,360 to 8,294,400 total pixels. Overrides `--ratio` for OpenAI.
- `--background <b>` — OpenAI `transparent`, `opaque`, or `auto`. Transparent output needs png/webp. Note: 2.5 returns alpha in the 0..254 range with 1-2 unit noise; snap alpha before running binary gates.
- `--n <count>` — OpenAI: images per request.
- 2.5 models reject `input_fidelity`; do not pass it.

## Provider notes

- **OpenAI (gpt-image-2.5-sunburst)** — `--ratio` supports `1:1`, `16:9`, `9:16` only (other ratios auto-fallback to Gemini); use `--size WxH` for any other shape. The script prints `Elapsed:` and the `usage` token counts for cost tracking ($5/M text in, $8/M image in, $30/M out).
- **Gemini** — supports all aspect ratios. Used as fallback when OpenAI is unavailable or doesn't support the requested ratio.

## Examples

```bash
# Hero banner (OpenAI primary)
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts \
  "moody dark SaaS hero banner, abstract gradient mesh" \
  --ratio wide --res 2K \
  --out /Users/travisse/Programming/personal-master/personal/artifacts/image-generator \
  --name hero

# Force Gemini for unsupported ratio
cd ~/.claude/skills/image-generator && npx tsx generate-image.ts \
  "portrait photo style headshot" \
  --ratio 3:4 --provider gemini \
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
