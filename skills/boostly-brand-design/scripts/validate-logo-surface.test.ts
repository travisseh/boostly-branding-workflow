import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { assessLogoSurface } from './validate-logo-surface.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('rejects an opaque light logo panel on a colored card and accepts transparent white ink', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-surface-'));
  try {
    const opaque = path.join(directory, 'opaque.jpg');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="200" height="100"><text x="30" y="65" font-size="48">LOGO</text></svg>') }])
      .jpeg()
      .toFile(opaque);

    const transparent = path.join(directory, 'transparent.png');
    await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="200" height="100"><text x="30" y="65" font-size="48" fill="white">LOGO</text></svg>') }])
      .png()
      .toFile(transparent);

    const opaqueResult = await assessLogoSurface(opaque, '#D90429');
    assert.equal(opaqueResult.pass, false);
    assert.equal(opaqueResult.verdict, 'opaque_light_panel_on_colored_surface');

    const transparentResult = await assessLogoSurface(transparent, '#D90429');
    assert.equal(transparentResult.pass, true);
    assert.equal(transparentResult.verdict, 'ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
