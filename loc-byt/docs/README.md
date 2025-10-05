# MatchSpot Docs

Quick links for API documentation and CI artifacts.

## Local (BFF-served)
- Landing: http://localhost:3001/docs
- Redoc
  - BFF Valet: http://localhost:3001/docs/bff-valet
  - Upstream Valet: http://localhost:3001/docs/upstream-valet
- Swagger UI
  - BFF Valet: http://localhost:3001/swagger/bff-valet
  - Upstream Valet: http://localhost:3001/swagger/upstream-valet
- Raw specs
  - BFF Valet: http://localhost:3001/openapi/bff-valet.yaml
  - Upstream Valet: http://localhost:3001/openapi/upstream-valet.yaml

Note: Local port may vary if you run the BFF with a custom PORT.

## CI Artifacts (GitHub Actions)
- Workflow: BFF Tests → artifact named `openapi-docs`
  - Contains:
    - bff-valet.html (Redoc bundle)
    - upstream-valet.html (Redoc bundle)
    - docs-index.html (links page)

## CI Validation
- OpenAPI specs are linted and validated on each push/PR:
  - @redocly/cli lint
  - swagger-cli validate

## Next additions (optional)
- Add additional domain specs as they stabilize (auth, venues, parking).
- Publish docs to GitHub Pages or an internal docs site if desired.

