# Response to "Secure Architecture for SHL Scanning" Review

**Date:** March 4, 2026
**From:** Amy Gleason
**Re:** Architecture review of Kill the Clipboard

Thank you for the thorough review. We've implemented several of the recommended changes and want to walk through each concern, what we did, and where we think further discussion would be valuable.

---

## Concerns Addressed

### 1. PHI should not be decrypted on the server
**Status: Fixed.**

The entire SHL pipeline — parse URI, fetch manifest, decrypt JWE, decompress, parse FHIR, extract PDFs — now runs in the browser using the `jose` library (AES-256-GCM) and `pako` (DEFLATE). The decryption key never leaves the browser. The server cannot decrypt health data because it never possesses the key.

### 2. Server should not be in the SHL request chain with access to decrypted content
**Status: Fixed.**

The server now provides a CORS proxy that forwards encrypted JWE blobs verbatim between the browser and SHL manifest servers. It never sees decrypted content. This addresses the CORS constraint the review identified while maintaining the security boundary the review recommended.

### 3. No credentials at rest (OAuth tokens, password hashes, API keys)
**Status: Addressed — OAuth tokens now encrypted at rest. Password hashes retained by design.**

We still store OAuth refresh tokens and password hashes. The review recommends eliminating these entirely via Web Share API and removing the multi-tenant password model. We believe this creates a worse security outcome for the target users (front-desk healthcare staff) for the following reasons:

- **Admin-controlled routing eliminates human error.** With our current model, an admin configures "all scans go to this Google Drive folder" once, and staff never make that decision. With Web Share API, every scan requires the staff member to choose the correct share target, pick the correct folder, and do it right every time. A wrong tap sends PHI to a personal phone, personal iCloud, or text message. In a busy front desk environment, this is a significant HIPAA risk.

- **The password model enforces organizational access control.** Without it, anyone with the scanner URL can use it. The dual-password system (admin vs. staff) ensures only authorized personnel access the scanner and only administrators can change where data goes.

- **OAuth tokens are scoped and revocable.** Each token is limited to one organization, uses minimum-privilege scopes (e.g., `drive.file` for Google Drive — only files the app created), and can be disconnected by the admin at any time. The risk profile of these tokens is meaningfully different from storing PHI.

**What we implemented:** All OAuth refresh tokens (Google Drive, Gmail, OneDrive, Outlook, Box) are now encrypted at rest using AES-256-GCM. Each organization's tokens are encrypted with a unique key derived from `HMAC-SHA256(SESSION_SECRET, orgId)`. A database leak alone does not expose usable OAuth tokens — the attacker would also need the `SESSION_SECRET` environment variable. Existing plaintext tokens are automatically migrated to encrypted form on server startup.

### 4. Multi-tenant isolation risk from shared backend
**Status: Mitigated by architecture change + existing controls. Self-hosting option available.**

The most critical data (decrypted PHI) no longer passes through server-side processing logic where a vulnerability could cause cross-tenant leakage during the cryptographic phase. The CORS proxy handles only encrypted blobs. The route endpoint still processes decrypted data transiently for delivery, but every API request is validated against the authenticated organization's slug, and tokens are scoped per-organization. OAuth tokens are encrypted with per-org keys, so a cross-tenant data leak at the database level would not expose another organization's usable credentials.

**Self-hosting / single-tenant deployment:** For organizations that want to eliminate multi-tenant risk entirely, Kill the Clipboard can be self-hosted as a single-tenant instance. The application is a single Node.js server with a SQLite database — no external infrastructure dependencies. A health system can deploy it on their own infrastructure (Docker, VM, or cloud) with a single organization configured, eliminating any shared-backend concern. The same codebase supports both multi-tenant (hosted) and single-tenant (self-hosted) deployment without modification.

### 5. Server-side injection surface (SSRF)
**Status: Fixed.**

The CORS proxy includes SSRF protection that blocks requests to private/internal IP ranges (RFC 1918), localhost, link-local addresses, and non-HTTP protocols. Only HTTPS requests to external hosts are proxied. Header forwarding is restricted to an allowlist (`Content-Type`, `Accept`).

### 6. XSS risk from attacker-controlled SHL content
**Status: Fixed — HTML sanitization + CSP + SRI.**

A [threat model report](https://fhir-search.exe.xyz/threat-model-report.html#poc) demonstrated that a poisoned SHL QR code could inject malicious HTML via the `label` field (e.g., `<img onerror="...">`) and exfiltrate data from subsequent scans. We've implemented defense-in-depth:

**HTML Sanitization:** All external data rendered via `innerHTML` is now sanitized through an `escapeHtml()` function that escapes `<`, `>`, `&`, `"`, and `'`. This covers: SHL labels, FHIR resource types, PDF filenames, app names, error messages, and storage labels. Download buttons use `data-*` attributes and event listeners instead of inline `onclick` with interpolated filenames.

**Content Security Policy headers:**
- `script-src` restricted to `'self'` and specific trusted CDNs (unpkg, cdnjs, jsdelivr)
- `connect-src 'self'` — prevents exfiltration to external origins
- `object-src 'none'` — no plugin content
- `X-Frame-Options: DENY` — no clickjacking
- `X-Content-Type-Options: nosniff`

**Server-side FHIR validation:** The route endpoint re-validates all FHIR bundles before routing, rejecting malformed data.

### 7. Data accessible to any script running in browser origin
**Status: Mitigated — SRI hashes implemented.**

This is a valid concern and applies equally to the review's recommended architecture. Any script running on the page origin can access decrypted PHI in browser memory. Our mitigations:

- **Subresource Integrity (SRI):** All CDN script tags now include `integrity` attributes with SHA-384 hashes and `crossorigin="anonymous"`. If a CDN is compromised or a script is tampered with, the browser will refuse to execute it. Covered: `html5-qrcode@2.3.8`, `jose@5.9.6`, `pako@2.1.0`, `qrcode@1.4.4`.
- **CSP headers** restrict what scripts can load and where they can send data
- **`connect-src 'self'`** prevents a compromised script from exfiltrating data to an external server
- Production dependencies are pinned to specific versions

### 8. No server-side audit trail
**Status: Fixed — audit logging implemented.**

The route endpoint now records every scan event in an `audit_log` table with the following metadata (no PHI content):
- Timestamp
- Organization slug
- Storage destination type (Drive, OneDrive, Box, Gmail, Outlook, API, download)
- FHIR bundle count and PDF count
- Success/failure status and error messages
- Client IP address and user agent

Audit logs are accessible via:
- **Admin API:** `GET /api/orgs/:slug/audit-log` (per-organization, requires admin auth)
- **Super-admin API:** `GET /api/admin/audit-log` (all organizations)

---

## Concerns Where We Chose a Different Path

### Saving files via Web Share API instead of server-side storage routing
**Status: Disagree — kept server-side routing. Recommend discussion.**

The review argues that Web Share API (Android/iOS) and browser download dialogs can replace all server-side storage integrations. This is technically correct but we believe it's the wrong choice for this use case:

1. **Staff error risk.** Healthcare front-desk staff scan dozens of patients per day. Requiring a manual save decision for each scan — choosing the right app, the right folder, confirming each time — introduces repeated opportunities for PHI to end up in the wrong place. Our model: admin configures the destination once, every scan auto-routes there.

2. **Desktop gap.** Most health system workstations run Windows desktops with Chrome. Web Share API is not supported on desktop browsers. The fallback is "Save As" dialog → hope staff picks the right synced folder. This is not a reliable workflow for PHI.

3. **No organizational control.** With Web Share API, the organization cannot enforce where files go. An admin has no way to ensure staff are saving to the compliant Google Workspace folder vs. their personal Dropbox. Our model gives the admin that control.

4. **HIPAA workflow alignment.** HIPAA requires organizations to have policies and controls around PHI handling. Admin-controlled routing is a technical control. "Trust staff to tap the right share target" is a policy control with no enforcement mechanism.

**Our approach:** The server handles *routing*, not *processing*. PHI is decrypted in the browser (as recommended), then sent to the server solely for delivery to the admin-configured destination. This gives organizations the automated, controlled workflow they need while keeping cryptographic operations out of the server.

### Fully eliminating the server / static-site-only architecture
**Status: Disagree for current requirements.**

The review's recommended baseline is a fully static client-side application with no server component beyond a CORS proxy. We agree this is the ideal architecture for a pure scan-and-display demo. However, the health systems using Kill the Clipboard have told us they need:

- Automated routing to their cloud storage (they don't want staff manually saving files)
- Organizational configuration (which storage destination, which format, session timeouts)
- Access control (only authorized staff can use the scanner)
- The option to send via email (Gmail/Outlook integration)

These requirements justify the server components we maintain. We've minimized the server's role to configuration management and data routing — it no longer performs any cryptographic operations on health data.

---

## Summary

| Review Concern | Our Response |
|---|---|
| Server decrypts PHI | ✅ Fixed — decryption moved to browser |
| SSRF via manifest fetches | ✅ Fixed — CORS proxy with SSRF blocklist |
| XSS from SHL content | ✅ Fixed — HTML sanitization (`escapeHtml`), CSP headers, SRI hashes |
| No credentials at rest | ✅ Addressed — OAuth tokens encrypted at rest with per-org AES-256-GCM keys |
| Multi-tenant isolation | ✅ Mitigated — PHI no longer in server crypto path; self-hosting option available |
| Web Share API for file saving | ❌ Disagree — admin-controlled routing is safer for healthcare staff |
| No audit trail | ✅ Fixed — route endpoint logs non-PHI metadata to `audit_log` table |
| Browser dependency risk | ✅ Fixed — SRI hashes on all CDN scripts; CSP restricts script sources |
| Fully static architecture | ❌ Disagree for current requirements — health systems need automated routing |

We'd welcome a follow-up conversation on the items marked for discussion, particularly around the tradeoffs between stored credentials and staff-directed file saving in a healthcare front-desk environment.
