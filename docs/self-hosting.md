# Self-hosting: Scanner and optional proxy

This guide covers hosting the **scanner** (client-only app) and the **optional CORS proxy** yourself. For the enterprise connector (sidecar), see `docs/sidecar-deployment.md`.

## 1. Build the scanner

From the repo root:

```bash
npm ci
npm run build
```

This builds the scanner package; output is in `packages/scanner/dist/core/` (for example `index.html`, `js/`, `css/`).

## 2. Serve the scanner (static only)

Upload the contents of `packages/scanner/dist/core/` to any static host:

- **Nginx / Caddy:** Point the document root at that directory. Serve over **HTTPS** (required for camera access).
- **GitHub Pages / Netlify / Vercel:** Use the same directory as the publish source; ensure `index.html` is the default document.
- **S3 + CloudFront (or similar):** Upload the files and set the default root object to `index.html`.

No Node process is required for the scanner. No environment variables or database.

## 3. Optional: run the CORS proxy

Use the proxy only when the SHL manifest server does not send CORS headers and the scanner cannot fetch directly.

**From repo root:**

```bash
npm run start -w @ktc/proxy
```

Default port: **3080**. Override with `PORT=3080 node packages/proxy/server.js` or set `PORT` in the environment.

**Docker (from repo root, after `npm ci`):**

```bash
cd packages/proxy && npm install && docker build -t ktc-proxy .
docker run -p 3080:3080 ktc-proxy
```

The proxy accepts `POST /api/shl-proxy` with JSON body `{ "url": "<manifest URL>", "method": "GET", ... }` and returns a normalized response object. It enforces:

- `https:` targets only (no plaintext `http://`)
- SSRF protection for private/internal hosts and cloud metadata endpoints
- DNS-resolution checks so public hostnames that resolve to private IPs are blocked
- Redirect target re-validation and rate limiting (for example 30 requests per minute per IP)

## 4. Point the scanner at the proxy (optional)

If you host the proxy at `https://your-domain.com`, configure the scanner to use `https://your-domain.com/api/shl-proxy` when direct fetch fails. How you set this depends on how you build/serve the scanner (for example, a config file or a global like `window.__CORE_PROXY_URL__` before app load). See `docs/core-deployment.md` for exact setup details.

## 5. Summary

| What             | Where                     | Notes                         |
| ---------------- | ------------------------- | ----------------------------- |
| Scanner          | Static host (HTTPS)       | `packages/scanner/dist/core/` |
| Proxy (optional) | Node or Docker, port 3080 | Only if direct fetch fails    |

For architecture and security, see `docs/architecture-executive-summary.md` and `docs/security-and-compliance-spec.md`.
