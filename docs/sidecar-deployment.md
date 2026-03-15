# Sidecar deployment

The **sidecar** is the enterprise connector: it receives already-decrypted health data from the browser scanner and routes it to your organization’s storage (Google Drive, OneDrive, Box, Gmail, Outlook, SMTP email, or a custom API). This document describes how to deploy and configure it.

## When to use the sidecar

- You want scan results saved to **Google Drive, OneDrive, Box, Gmail, Outlook, SMTP, or a custom API** instead of (or in addition to) browser download / Web Share.
- You are willing to run a small server that receives decrypted payloads and stores OAuth tokens (encrypted at rest).
- You use the **scanner** configured to POST to this sidecar after decrypting in the browser.

The scanner never sends decrypted data to a server unless you explicitly configure it to POST to a sidecar URL.

## Requirements

- **Node 18+** (or use the sidecar Docker image).
- **SESSION_SECRET** — Required. Used for JWT signing and for encrypting OAuth tokens in the database. Use a long, random secret (for example 32+ bytes hex).
- **SQLite database** — Organizations, settings, and encrypted OAuth tokens. The sidecar reads and writes this schema, but does not provide registration, login, or OAuth bootstrap endpoints.
- **Config** — Drive client ID/secret, SMTP settings, and related connector options via `config.json` (in sidecar or repo root) and/or environment variables. See repo root config and `packages/sidecar/README.md`.

## Running the sidecar

**From repo root (after `npm ci`):**

```bash
export SESSION_SECRET="your-long-random-secret"
export DATABASE_PATH="/path/to/ktc.db"   # optional; default ./data/ktc.db
npm start
# or: node packages/sidecar/server.js
```

Default port: **3090**. Override with `PORT`.

**Docker:**

Build from the sidecar package directory (so that `package.json` and source files are in context):

```bash
cd packages/sidecar
npm install
docker build -t ktc-sidecar .
docker run -p 3090:3090 \
  -e SESSION_SECRET="your-long-random-secret" \
  -e DATABASE_PATH=/data/ktc.db \
  -v /host/path/to/data:/data \
  ktc-sidecar
```

Ensure the SQLite file is created and migrated by the app that manages orgs (for example the archived full server); the sidecar then reads and writes that shared schema.

## API

The sidecar exposes a single endpoint:

- **POST /api/orgs/:slug/route**
  - **Auth:** `Authorization: Bearer <JWT>` (staff or admin token for that org).
  - **Body:** `{ "fhirBundles": [...], "pdfs": [...], "label": null }` (same shape as the monolith route).
  - **Behavior:** Validates FHIR, filters by org `save_format`, then routes to the org’s `storage_type` (drive, onedrive, box, gmail, outlook, email, api).
  - **Response:** JSON with status, links, and any errors. PDF entries in the response are metadata (`filename`, `hasData`, `url`) and do not echo raw `dataBase64`.

Tokens are issued by the app that handles login (for example the archived full server with `/api/orgs/:slug/auth`). The sidecar only verifies the JWT and reads org settings from the DB.

## Configuring organizations

Organizations and their storage settings (and OAuth tokens) are stored in the SQLite database. Typically you:

1. Provision organizations, auth tokens, and OAuth credentials using your own bootstrap/admin tooling against the sidecar schema.
2. Point the **scanner** at the **sidecar** URL and run the sidecar with the same DB (or a synchronized copy) and `SESSION_SECRET` so it can read org settings and decrypt connector tokens.

Alternatively, you can create/update orgs and tokens via your own tooling, as long as the schema and encryption match (see `packages/sidecar/db.js` and `packages/sidecar/crypto.js`).

## Security and network

- Run the sidecar behind **HTTPS** (reverse proxy or load balancer).
- Restrict access to the sidecar (for example same network as the scanner or VPN) so only your scanner and auth issuer can reach it.
- Keep **SESSION_SECRET** and the **database** secure; anyone with both can decrypt tokens and impersonate orgs.
- See `docs/security-and-compliance-spec.md` and `docs/production-readiness.md` for more.

## References

- **Sidecar package:** `packages/sidecar/README.md`
- **Architecture:** `docs/architecture-executive-summary.md`
- **Production readiness:** `docs/production-readiness.md`
