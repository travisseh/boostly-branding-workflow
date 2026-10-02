# Link Discovery Fixtures

Fixtures make discovery evals deterministic.

Layout:

```text
fixtures/
  <location_id>/
    v2.json
    expected-category-status.json
    website/
    external-link-in-bio/
    places.json
    search/
    app-store/
    provider-pages/
    browser-dom/
    errors/
```

`expected-category-status.json` is required for idempotence fixtures and optional for other locations.

Recording rules:

- Extraction-accuracy fixtures must be recorded with `--hide-existing`, or with discovery forced for all categories.
- Idempotence fixtures are recorded in normal mode.
- If one location serves both suites, record the union of both passes' fetches.
- Search fixtures recorded from DataForSEO store the provider name, normalized organic results, and the raw API response. They must not include auth headers or credentials.

Replay rules:

- `--replay` reads fixtures only.
- Missing fixture evidence becomes `missing_fixture`.
- Live fetches should not be attempted in replay mode.
- Replay uses recorded search fixtures and does not require `DATAFORSEO_LOGIN` or `DATAFORSEO_PASSWORD`.
