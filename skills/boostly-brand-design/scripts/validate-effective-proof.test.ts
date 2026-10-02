import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  assessProofLogoRegion,
  planWritesLogo,
  requireLogoWriteProof,
} from './validate-effective-proof.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

const logoPlan = {
  writes: [{ kind: 'branding', payload: { logo_file: '/tmp/final-logo.png', web_primary_color: '#161616' } }],
};

test('1916 missing-logo fixture fails when a logo write reads back a null attachment', async () => {
  assert.equal(planWritesLogo(logoPlan), true);
  await assert.rejects(
    requireLogoWriteProof(logoPlan, { logo_attachment_id: null }, '/tmp/not-read.png', '#161616'),
    /proof_missing_logo: branding plan wrote a logo but readback logo_attachment_id is null/,
  );
});

test('Gennaros blank-logo proof fixture fails visible proof ink validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-proof-logo-missing-'));
  try {
    const proof = path.join(directory, 'gennaros-blank-logo-proof.png');
    await sharp({ create: { width: 772, height: 1200, channels: 4, background: '#161616' } }).png().toFile(proof);
    const assessment = await assessProofLogoRegion(proof, '#161616');
    assert.equal(assessment.pass, false);
    assert.equal(assessment.verdict, 'proof_missing_logo');
    await assert.rejects(
      requireLogoWriteProof(logoPlan, { logo_attachment_id: 'logo_123' }, proof, '#161616'),
      /proof_missing_logo: no visible non-background ink/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('known-good applied proof passes attachment and visible logo checks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-proof-logo-present-'));
  try {
    const proof = path.join(directory, 'known-good-logo-proof.png');
    const logo = await sharp(Buffer.from('<svg width="240" height="70"><text x="120" y="52" text-anchor="middle" font-family="Arial" font-size="48" font-weight="700" fill="#fff">GOOD</text></svg>'))
      .png()
      .toBuffer();
    await sharp({ create: { width: 772, height: 1200, channels: 4, background: '#161616' } })
      .composite([{ input: logo, left: 266, top: 230 }])
      .png()
      .toFile(proof);
    const result = await requireLogoWriteProof(logoPlan, { logo_attachment_id: 'logo_123' }, proof, '#161616');
    assert.equal(result?.pass, true, JSON.stringify(result));
    assert((result?.non_background_ink_share ?? 0) > 0.0025);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plans without logo writes do not require proof logo ink', async () => {
  const plan = { writes: [{ kind: 'branding', payload: { web_primary_color: '#161616' } }] };
  assert.equal(planWritesLogo(plan), false);
  assert.equal(await requireLogoWriteProof(plan, {}, '/tmp/not-read.png', '#161616'), null);
});
