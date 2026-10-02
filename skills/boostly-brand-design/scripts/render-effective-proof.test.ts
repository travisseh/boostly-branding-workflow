import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractEffectiveBranding,
  requireCompletePreviewColors,
  resolvePreviewColors,
} from './render-effective-proof.ts';

test('digital proof uses resolved web colors, not stale account or proposal colors', () => {
  const effective = extractEffectiveBranding({
    selected_scope: 'account',
    account_branding: { web_secondary_color: '#dbb111' },
    override_branding: { web_secondary_color: '#c05700' },
    effective_branding: {
      web_primary_color: '#000000',
      web_secondary_color: '#c05700',
      web_text_color: '#ffffff',
      print_primary_color: '#111111',
      print_secondary_color: '#dbb111',
      print_text_color: '#eeeeee',
      print_text_secondary_color: '#222222',
      logo_url: 'https://example.com/live.png',
    },
  });

  assert.deepEqual(resolvePreviewColors(effective, 'digital'), {
    primary: '#000000',
    secondary: '#c05700',
    text: '#ffffff',
    textSecondary: '#ffffff',
  });
});

test('print proof follows print colors and the production print-to-web fallbacks', () => {
  assert.deepEqual(
    resolvePreviewColors(
      {
        web_primary_color: '#123456',
        web_secondary_color: '#abcdef',
        web_text_color: '#ffffff',
        print_primary_color: null,
        print_secondary_color: '#010203',
        print_text_color: null,
        print_text_secondary_color: null,
      },
      'print',
    ),
    {
      primary: '#123456',
      secondary: '#010203',
      text: '#ffffff',
      textSecondary: '#ffffff',
    },
  );
});

test('flattened snapshots are accepted only when they are already effective', () => {
  assert.equal(
    extractEffectiveBranding({
      location_id: 'loc_1',
      web_primary_color: '#112233',
      logo_url: null,
    }).web_primary_color,
    '#112233',
  );

  assert.throws(
    () =>
      extractEffectiveBranding({
        account_branding: { web_primary_color: '#112233' },
        override_branding: { web_primary_color: '#445566' },
      }),
    /resolved effective_branding/,
  );
});

test('invalid stored colors fail instead of silently rendering harness defaults', () => {
  assert.throws(
    () => resolvePreviewColors({ web_primary_color: 'orange' }, 'digital'),
    /six-digit hex color/,
  );
  assert.throws(
    () => requireCompletePreviewColors(resolvePreviewColors({ web_primary_color: '#000000' }, 'digital')),
    /missing preview colors: secondary, text, textSecondary/,
  );
});
