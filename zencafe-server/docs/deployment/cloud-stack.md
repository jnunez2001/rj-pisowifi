# Cloud Stack Decision

## Decision: Self-hosted PostgreSQL (not Firebase/Firestore, not Supabase as the default)

**Reasoning:**
- The system already handles real money (wallet, billing, Game Pass, licensing fees) and legally-sensitive records (age verification with staff accountability, curfew logs). This data needs to stay under full control — no third-party vendor sitting between us and financial/compliance records that could be needed as evidence later.
- The original architecture (see [zencafe-server/DEVELOPMENT.md](../../DEVELOPMENT.md)) already plans **local PostgreSQL per café location + optional cloud aggregation** — this is a custom sync design regardless, so a managed Postgres provider (Supabase) doesn't remove much engineering work, it just adds a dependency.
- Self-hosting keeps us at **zero cost** on the database itself; only paying for compute (the VM it runs on).

**Where Postgres runs:**
- **Per location:** on the mini PC / existing server PC at each café (as already planned — works offline, syncs when online)
- **Cloud aggregation hub (optional, for multi-location owners):** self-hosted Postgres on an **Oracle Cloud Free Tier VM** — genuinely free forever (not a trial), unlike most "free tier" offers that expire

---

## Locked-In Cloud Stack

| Service | Role | Why |
|---|---|---|
| **PostgreSQL (self-hosted)** | Core database — wallet, sessions, users, compliance records | Full control over financial/legal data, matches offline-first multi-location design |
| **Oracle Cloud Free Tier** | Hosts the cloud aggregation server (if/when multi-location sync is needed) | Free forever, not a trial — good fit for a bootstrapped budget |
| **Cloudflare Tunnel** | Exposes each café's local server to the cloud securely | No router port-forwarding needed — cafés often have basic/shared internet setups, this avoids networking headaches for non-technical owners |
| **Cloudflare Pages** | Hosts the admin dashboard (web UI) and any marketing site | Free static hosting, fast CDN |
| **Cloudflare R2** | Stores cosmetics images/marketplace assets | No egress fees, unlike most S3-compatible storage |
| **Firebase Auth** | Handles "Sign in with Google" | Avoids building OAuth from scratch; narrow use — NOT used for the main database |
| **Firebase Cloud Messaging** | Push notifications (kiosk/app alerts) | Free, avoids the per-message cost of SMS (already ruled out) |
| **GitHub Actions** | CI/CD — build/test the C++ server before deploy | Already using GitHub for source control; free tier covers early-stage build volume |
| **Resend or Mailgun (free tier)** | Sends expiry/reset emails | Needed for temp-account expiry reminders and password resets already designed |

**Pay-as-you-go path:** every service above has a free tier that becomes a paid tier automatically once usage grows — no migration needed when the business scales past free limits, just a billing threshold.

---

## What We're Deliberately NOT Using

- **Firestore / Firebase Realtime Database** — NoSQL doesn't fit the relational, ACID-guaranteed design needed for money and compliance data
- **Supabase as the primary database** — reconsider only if self-hosting Postgres becomes an operational burden; it remains a valid fallback since it's Postgres-compatible
