# Kill the Clipboard

A multi-tenant web application that lets healthcare practices scan **SMART Health Link (SHL) QR codes** to extract patient health data as FHIR resources and PDFs, then automatically route that data to the destination of their choice.

**Live demo:** [killtheclipboard.fly.dev](https://killtheclipboard.fly.dev)

## What It Does

1. A patient presents a SMART Health Link QR code (from a supported health app)
2. Front-desk staff scans the QR code using their browser camera
3. The system extracts FHIR health records and/or PDF documents from the link
4. Data is automatically delivered to the practice's configured destination

No more clipboard. No more faxes. No more manual data entry.

## Features

- **QR Scanner** — Browser-based camera scanner for SMART Health Link QR codes
- **Multi-tenant** — Each organization gets its own URL, passwords, and configuration
- **7 storage destinations:**
  - Direct Download (browser)
  - Google Drive
  - OneDrive
  - Box
  - Gmail
  - Outlook
  - API / Webhook (POST JSON to any endpoint)
- **Configurable output** — PDF only, FHIR only, or both
- **Role-based access** — Admin password (settings) and Staff password (scanner)
- **Session management** — Admin sessions: 24 hours, Staff sessions: 12 hours
- **Setup guide** — Built-in step-by-step configuration walkthrough
- **Super admin dashboard** — Manage all organizations from a single panel

## Quick Start

```bash
git clone https://github.com/CMSgov/kill-the-clipboard-qr-code-reader.git
cd killtheclipboard
npm install
npm start
```

Visit `http://localhost:3000` to register your first organization.

## Self-Hosting Guide

### Prerequisites

- Node.js 20+
- A server or cloud platform (Fly.io, Railway, Render, etc.)
- HTTPS (required for camera access in browsers)

### Environment Variables

**Required:**

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `3000`) |
| `DATABASE_PATH` | Path to SQLite database file (default: `./data/ktc.db`) |
| `JWT_SECRET` | Secret key for signing auth tokens (auto-generated if not set) |
| `ADMIN_KEY` | Super admin dashboard password |

**Google Drive + Gmail (optional):**

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Create credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Enable the **Google Drive API** and **Gmail API**. Add redirect URIs:
- `https://your-domain.com/auth/google/callback` (Drive)
- `https://your-domain.com/auth/gmail/callback` (Gmail)

**OneDrive + Outlook (optional):**

| Variable | Description |
|----------|-------------|
| `ONEDRIVE_CLIENT_ID` | Microsoft/Azure app client ID |
| `ONEDRIVE_CLIENT_SECRET` | Microsoft/Azure app client secret |

Register an app at [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps). Add **Microsoft Graph** permissions: `Files.ReadWrite`, `Mail.Send`, `User.Read`. Add redirect URIs:
- `https://your-domain.com/auth/onedrive/callback` (OneDrive)
- `https://your-domain.com/auth/outlook/callback` (Outlook)

**Box (optional):**

| Variable | Description |
|----------|-------------|
| `BOX_CLIENT_ID` | Box app client ID |
| `BOX_CLIENT_SECRET` | Box app client secret |

Create an app at [Box Developer Console](https://app.box.com/developers/console). Choose **Custom App** with **User Authentication (OAuth 2.0)**. Enable scopes: `Read and write all files and folders`. Add redirect URI:
- `https://your-domain.com/auth/box/callback`

### Deploy with Docker

```bash
docker build -t killtheclipboard .
docker run -p 3000:3000 \
  -e DATABASE_PATH=/data/ktc.db \
  -e ADMIN_KEY=your-admin-key \
  -v ktc-data:/data \
  killtheclipboard
```

### Deploy to Fly.io

```bash
# Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
fly launch
fly volumes create ktc_data --size 1 --region iad

# Set secrets
fly secrets set ADMIN_KEY=your-admin-key
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
fly secrets set ONEDRIVE_CLIENT_ID=... ONEDRIVE_CLIENT_SECRET=...
fly secrets set BOX_CLIENT_ID=... BOX_CLIENT_SECRET=...

fly deploy
```

The included `fly.toml` is pre-configured with a persistent volume mounted at `/data` for the SQLite database.

### OAuth Redirect URIs

When registering OAuth apps, use these callback URLs (replace `your-domain.com` with your actual domain):

| Integration | Redirect URI |
|-------------|-------------|
| Google Drive | `https://your-domain.com/auth/google/callback` |
| Gmail | `https://your-domain.com/auth/gmail/callback` |
| OneDrive | `https://your-domain.com/auth/onedrive/callback` |
| Outlook | `https://your-domain.com/auth/outlook/callback` |
| Box | `https://your-domain.com/auth/box/callback` |

## Core (client-only) deployment

**Core** is a client-only scanner: no server handles PHI, no auth, save via Web Share (mobile) or browser download (desktop). It can run on a static host or CDN with zero backend.

1. **Build the Core artifact:**
   ```bash
   npm run build:core
   ```
   This writes `dist/core/index.html` and `dist/core/js/` (shl-client.js, approved-apps.js).

2. **Deploy** the contents of `dist/core/` to any static host or CDN (e.g. S3 + CloudFront, Netlify, GitHub Pages). No Node server is required. Serve `index.html` at the root of the deployment (or as the default document) so script paths `js/...` resolve.

3. **HTTPS** is required for camera access in production.

4. **Optional CORS proxy:** If SHL manifest servers don’t send CORS headers, you can run the full app with `ENABLE_CORE_PROXY=1` and point the Core client at the proxy: before loading the scanner, set `window.__CORE_PROXY_URL__ = 'https://your-server.com/api/shl-proxy'` (e.g. in a small inline script in `index.html`). The proxy only forwards encrypted traffic and uses the same SSRF/rate limits as the org-scoped proxy.

See **docs/core-deployment.md** for details (browser support, Web Share, confirm-before-fetch).

## Architecture

```
server.js          — Express app, routes, OAuth flows
src/
  auth.js          — JWT auth, password hashing, session management
  db.js            — SQLite database (better-sqlite3), org CRUD
  config.js        — Configuration loader
  shl/
    uri-parser.js  — SMART Health Link URI parser
    manifest.js    — SHL manifest fetcher
    fhir-extractor.js — FHIR bundle + PDF extraction
  output/
    drive-uploader.js   — Google Drive upload
    gmail-sender.js     — Gmail send via API
    onedrive-uploader.js — OneDrive upload
    outlook-sender.js   — Outlook send via Graph API
    box-uploader.js     — Box upload
    api-poster.js       — Generic webhook/API POST
    file-writer.js      — Local file output
public/
  landing.html     — Marketing/home page
  register.html    — Organization registration
  index.html       — QR scanner (staff-facing)
  admin.html       — Admin settings dashboard
  super-admin.html — Super admin (all orgs)
  setup-guide.html — Step-by-step setup walkthrough
  privacy.html     — Privacy policy
  terms.html       — Terms of service
data/
  approved-apps.js — Single source for CMS approved apps + known SHL manifest hosts
```

## Development (DRY)

To avoid duplication, some assets are generated from a single source:

| Source | Generated / used by | Command |
|--------|---------------------|--------|
| `data/approved-apps.js` | `public/js/approved-apps.js`, server | `npm run generate:approved-apps` |
| `src/util/sanitize.js` | `public/js/sanitize.js`, server | `npm run generate:sanitize` |

**Approved apps:** The list in `data/approved-apps.js` comes from the **CMS "Kill the Clipboard"** program: 12 early adopters and 71+ pledgees (see [CMS health tech ecosystem](https://www.cms.gov/health-tech-ecosystem/early-adopters) and [Kill the Clipboard](https://www.cms.gov/health-tech-ecosystem/early-adopters/kill-the-clipboard)). This file is maintained by hand; when CMS updates the participant list, edit `data/approved-apps.js`, then run `npm run generate:approved-apps`. The server imports from `data/`; the client loads the generated script. Core build runs this automatically.

**Sanitize (escapeHtml, isSafeBase64, isSafeUrl):** Edit `src/util/sanitize.js`; run `npm run generate:sanitize` to update the client script. The server imports from `src/util/sanitize.js`.

**Remaining duplication (by design):** SHL URI parsing exists in both `src/shl/uri-parser.js` (Node) and `public/js/shl-client.js` (browser) because the client cannot import Node modules. Timeout and size constants (e.g. 30s, 5 MB) are repeated in client and server so each runtime is self-contained.

## Testing

Tests use **Vitest** and live in **`__tests__`** folders next to the code they test: `src/**/__tests__/**` and `data/**/__tests__/**`. The top-level `test/` directory is reserved for future integration or end-to-end tests (e.g. server health, API).

- **Run once (CI):** `npm test` (runs `vitest run`)
- **Watch mode:** `npm run test:watch` (runs `vitest`)
- **Coverage:** `npm run test:coverage` (runs `vitest run --coverage`; report in `coverage/`)

Coverage is enforced at **80%** for lines, functions, and statements (77% for branches); `npm run test:coverage` must pass in CI. Some integration-heavy modules (cli, input, output, SHL manifest/decryptor/fhir-extractor) are excluded from coverage; see `vitest.config.js`.

## License

MIT
