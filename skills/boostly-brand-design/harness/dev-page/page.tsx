'use client';

import { generateBadgeHtml } from '@/lib/utils/generate-badge-html';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

function normalizeColor(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseIssueId(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function BadgePreviewHarness() {
  const params = useSearchParams();
  const shotRef = useRef<HTMLDivElement | null>(null);
  const logoUrl = params.get('logo')?.trim() || null;
  const [ready, setReady] = useState(!logoUrl);

  const html = useMemo(
    () =>
      generateBadgeHtml({
        side: 'back',
        logoUrl,
        primaryColor: normalizeColor(params.get('primary')),
        secondaryColor: normalizeColor(params.get('secondary')),
        textColor: normalizeColor(params.get('text')),
        textSecondaryColor: normalizeColor(params.get('textSecondary')),
        issueId: parseIssueId(params.get('issueId')),
      }),
    [params, logoUrl],
  );

  useEffect(() => {
    setReady(!logoUrl);
  }, [logoUrl, html]);

  useEffect(() => {
    if (!logoUrl || !shotRef.current) return;

    const img = shotRef.current.querySelector('img');
    if (!img) {
      setReady(true);
      return;
    }

    if (img.complete && img.naturalWidth > 0) {
      setReady(true);
      return;
    }

    const markReady = () => setReady(true);
    img.addEventListener('load', markReady, { once: true });
    img.addEventListener('error', markReady, { once: true });

    return () => {
      img.removeEventListener('load', markReady);
      img.removeEventListener('error', markReady);
    };
  }, [logoUrl, html]);

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
      }}
    >
      <div
        id="badge-shot"
        ref={shotRef}
        data-ready={ready ? 'true' : 'false'}
        style={{
          width: 386,
          height: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            transform: 'scale(1.7857142857)',
            transformOrigin: 'center center',
            width: 216,
            height: 336,
            filter: 'drop-shadow(0 18px 28px rgb(15 23 42 / 0.22))',
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Production badge HTML generated from query-configured harness values.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </main>
  );
}

export default function BadgePreviewHarnessPage() {
  return (
    <Suspense fallback={null}>
      <BadgePreviewHarness />
    </Suspense>
  );
}
