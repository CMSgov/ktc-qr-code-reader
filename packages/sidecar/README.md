# @ktc/sidecar

Enterprise connector for **Kill the Clipboard**. Receives already-decrypted health data from the scanner (browser) and routes it to your organization’s storage: Google Drive, OneDrive, Box, Gmail, Outlook, SMTP email, or a custom API.

**This package is for self-hosted enterprise deployments.** It is not enabled by default. The main scanner app runs in the browser and never sends decrypted PHI to a server unless you explicitly configure it to POST to a sidecar instance.

## What it does

- **Single endpoint:** `POST /api/orgs/:slug/route` with `Authorization: Bearer <token>`.
- **Accepts:** `{ fhirBundles, pdfs, label }` (same shape as the current monolith route).
- **Dispatches** to the org’s configured storage (drive, onedrive, box, gmail, outlook, email, api).
- **Stores** org settings and OAuth tokens in SQLite; tokens are encrypted at rest with `SESSION_SECRET`.

## Requirements

- Node 18+
- `SESSION_SECRET` (required for token encryption)
- `DATABASE_PATH` (optional; default `./data/ktc.db`)
- Config via `config.json` (see repo root or main app) and/or env vars for Drive client ID/secret, SMTP, etc.
- Organizations and tokens must be created elsewhere (e.g. the full server’s registration and OAuth flows); the sidecar only reads from the same DB and serves the route.

## Run

```bash
npm start
# or from repo root: npm run start -w @ktc/sidecar
```

Default port: `3090` (override with `PORT`).

## Deployment

- Run behind HTTPS and restrict access to the route (e.g. same network as scanner or VPN).
- Use the same SQLite DB (or a copy) and `SESSION_SECRET` as the app that performs org registration and OAuth so tokens are valid.
- See `docs/sidecar-deployment.md` (when added) for full deployment and configuration.
