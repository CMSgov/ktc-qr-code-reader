# Kill the Clipboard

Scan **SMART Health Link (SHL) QR codes** to extract patient health data as FHIR resources and PDFs — no clipboard, no fax, no manual entry.

**Live demo:** [killtheclipboard.fly.dev](https://killtheclipboard.fly.dev)

---

## Quick Start

```bash
git clone https://github.com/CMSgov/kill-the-clipboard-qr-code-reader.git
cd kill-the-clipboard-qr-code-reader
npm install
npm run dev
```

That's it. `npm run dev` builds the scanner and serves it at `http://localhost:3000`.

> Camera access requires HTTPS. For testing on a real device, use a tunnel:
> `npx localtunnel --port 3000`

---

## Project Structure

This is a monorepo with three packages:

| Package            | What it does                                                                                      | Port   |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------ |
| **`@ktc/scanner`** | Client-only QR scanner — runs entirely in the browser, zero runtime deps                          | static |
| **`@ktc/proxy`**   | Minimal CORS proxy for SHL manifest fetches (encrypted traffic only, SSRF-protected)              | 3080   |
| **`@ktc/sidecar`** | Enterprise connector — receives decrypted data and routes to Drive/OneDrive/Box/Gmail/Outlook/API | 3090   |

```
packages/
  scanner/     — static site: public/, scripts/, Dockerfile
  proxy/       — Express server: server.js, ssrf.js, Dockerfile
  sidecar/     — Express server: server.js, connectors/, Dockerfile
src/             — shared core logic (SHL parsing, FHIR extraction, CLI)
bin/shl-scan.js  — CLI tool
```

### Which packages do I need?

- **Just scanning + manual save:** Scanner only (static files, no server).
- **Scanner + CORS fallback:** Scanner + Proxy (for SHL servers that don't send CORS headers).
- **Full enterprise routing:** Scanner + Proxy + Sidecar (auto-route to Drive, email, API, etc.).

---

## Scripts

| Command                   | What it does                                   |
| ------------------------- | ---------------------------------------------- |
| `npm run dev`             | Build scanner and serve locally                |
| `npm run build`           | Build scanner to `packages/scanner/dist/core/` |
| `npm test`                | Run all tests (Vitest)                         |
| `npm run lint`            | Lint with oxlint                               |
| `npm run format`          | Format with oxfmt                              |
| `npm run scan -- <image>` | CLI: scan a QR code from an image or PDF       |
| `npm run pack:core`       | Zip the scanner build for distribution         |

### Running individual packages

```bash
# Proxy
npm start -w @ktc/proxy          # listens on :3080

# Sidecar (needs config.json and SQLite)
npm start -w @ktc/sidecar        # listens on :3090
```

---

## Deploying the Scanner

The scanner is a static site. After building, deploy `packages/scanner/dist/core/` to any host:

```bash
npm run build
# upload packages/scanner/dist/core/ to your CDN, S3, Netlify, Vercel, GitHub Pages, etc.
```

Or use Docker:

```bash
npm run build
docker build -t ktc-scanner packages/scanner
docker run -p 8080:80 ktc-scanner
```

HTTPS is required in production (for camera access). See **docs/core-deployment.md** for details on the optional CORS proxy, app verification, and known-issuer host checks.

---

## Deploying Proxy and Sidecar

Both have standalone Dockerfiles:

```bash
# Proxy
docker build -t ktc-proxy packages/proxy
docker run -p 3080:3080 ktc-proxy

# Sidecar
docker build -t ktc-sidecar packages/sidecar
docker run -p 3090:3090 \
  -e DATABASE_PATH=/data/ktc.db \
  -v ktc-data:/data \
  ktc-sidecar
```

See **docs/sidecar-deployment.md** for environment variables and connector setup (Drive, OneDrive, Box, Gmail, Outlook, API).

---

## Development

### Data generation

Some client-side scripts are generated from shared source files:

| Source                  | Generated file                                | Trigger         |
| ----------------------- | --------------------------------------------- | --------------- |
| `data/approved-apps.js` | `packages/scanner/public/js/approved-apps.js` | `npm run build` |
| `src/util/sanitize.js`  | `packages/scanner/public/js/sanitize.js`      | `npm run build` |

Both are regenerated automatically as part of `npm run build`. To update the approved-app list, edit `data/approved-apps.js` and rebuild.

### Testing

Tests use **Vitest** and live in `__tests__/` folders next to the code they test.

```bash
npm test                  # run once (CI)
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

### CLI

Scan a QR code from the command line:

```bash
npm run scan -- photo.png
npm run scan -- document.pdf --output ./results
npm run scan -- photo.jpg --drive-folder https://drive.google.com/drive/folders/...
```

---

## Further Reading

- **docs/core-deployment.md** — scanner build, local dev, static deploy, CORS proxy
- **docs/sidecar-deployment.md** — sidecar env vars, connector config
- **docs/self-hosting.md** — full self-hosting guide
- **docs/architecture-executive-summary.md** — system architecture overview
- **docs/security-and-compliance-spec.md** — PHI handling, XSS/SSRF protections

## License

MIT
