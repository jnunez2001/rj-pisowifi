# Minor Curfew Protection

Many LGUs (local government units) in the Philippines enforce curfew ordinances restricting minors from public establishments during certain hours. Since some cafés run 24/7, this must be **enforced automatically by the server**, not left to staff discretion.

---

## Core Rule

**Player accounts must record age (via birthdate) at registration.** The server calculates whether the account belongs to a minor, and automatically locks that account from starting or continuing a session during curfew hours.

---

## Design

### 1. Age Capture & Tiers
- Require **birthdate** (not just "are you 18+" checkbox) at account registration
- Store birthdate, calculate age server-side whenever curfew logic runs (never trust a client-side age claim)
- Minor = under 18 (used for curfew — see Open Decisions on whether some LGUs define this differently)
- **Three content/chat tiers, decided directly with the owner:** **Kids** (under 13), **Teens** (13-17), **Adults** (18+). This drives two separate things:
  - `age_tier` (self-reported, cached from birthdate) — safe to use for *restricting* content, same logic as curfew (e.g., filtering the game menu by rating — see [database/README.md](../database/README.md))
  - `verified_chat_tier` (staff-verified only, nullable) — used for *granting* chat access (see [social/README.md](../social/README.md)); self-reported age is never sufficient to unlock this, only a completed staff verification specifying which tier (teens or adults — kids never get a verified_chat_tier at all, since they get no chat access regardless)

### 2. Curfew Hours Are Per-Branch, Not Global
- Curfew ordinances vary by city/municipality (e.g., 10PM-5AM in one LGU, different hours in another)
- Each café (branch) should have a configurable `curfew_start` / `curfew_end` setting in its location settings
- This also matters for multi-branch owners — Branch A and Branch B could have different curfew rules if they're in different cities

### 3. Enforcement Points

**A. Login blocked during curfew**
- If a minor account attempts to log in / start a session during curfew hours → reject with a clear message (not just a silent failure)

**B. Active session gets auto-ended at curfew start**
- If a minor is already playing when curfew hour hits, the server must:
  - Warn the player on-screen (e.g., "Session ending in 10 minutes — curfew hour")
  - Auto-end the session at the curfew start time
  - Handle remaining credit based on account type (see "Remaining Credit Handling" below)

**C. Reservation blocked during curfew**
- Minors should not be able to reserve a PC for a time slot that falls within curfew hours

### 4. Verification Level (Important Limitation)
- Self-reported birthdate is **not proof of age** — a minor could lie about their birthdate
- Self-reported birthdate is sufficient for **curfew enforcement** (a restriction, so erring cautious is fine even if imperfect)
- For features that **grant access** rather than restrict it (e.g., friends/chat — see [social/README.md](../social/README.md)), self-reported age is NOT sufficient — those require staff verification, logged in the shared `age_verifications` table below, with accountability (which staff member verified, at which branch, when)

### 5. Remote Verification (Selfie + ID)

In-person verification (staff physically compares an ID to the person standing in front of them) doesn't scale well — staff may be busy, or a player may want to pre-register before ever visiting. A remote submission path exists, but with a deliberate safeguard:

- **A photo of an ID alone proves nothing** — a minor could submit a photo of an older sibling's or parent's ID with no one ever comparing the face on the ID to the actual person. **A selfie is required alongside the ID photo**, so staff can visually compare the two before approving — this preserves the "someone actually checked this is you" guarantee that pure in-person verification provides, rather than silently accepting a weaker remote-only path.
- Workflow: player submits ID photo + selfie → **pending** → staff reviews and approves/rejects (with a reason if rejected) → **only on approval** does a permanent row get written to `age_verifications` (the accountability log). Rejections do not create an accountability record.
- **Staff must specify which tier they're confirming, not just pass/fail an adult check** — approval sets `approved_tier` (`teens` or `adults`) on the request, which flows into `age_verifications.verified_tier` and then `users.verified_chat_tier`. A staff member reviewing an ID determines the actual tier (e.g., "this person is 15, that's teens"), not a binary yes/no.
- **Anti-abuse:** repeated rejected submissions are a risk specific to this feature's purpose — a minor could keep trying different fake/borrowed IDs remotely. After a policy-defined number of rejections (exact threshold TBD — see Open Decisions), the account is flagged `remote_verification_blocked`, forcing in-person-only verification going forward.
- **Storage:** ID and selfie photos live in a **separate, private, access-controlled storage bucket** — never the public-facing cosmetics/marketplace bucket (see [deployment/cloud-stack.md](../deployment/cloud-stack.md)). Access is via short-lived signed URLs generated on demand for staff review, not permanent links stored in the database.
- **Retention:** once a request is approved or rejected, the raw photos don't need to be kept indefinitely — only the verification *outcome* (who verified, when, what ID type) needs to persist permanently. Photos should be auto-purged after a policy-defined retention window (default suggestion: 30 days — see Open Decisions) post-decision.
- **Staff review interface:** this doesn't need a separate native mobile app — a responsive/installable web version of the admin dashboard (a PWA) can access a phone's camera fine via standard browser APIs, avoiding the cost of maintaining a second client alongside the OS and server (see [deployment/update-strategy.md](../deployment/update-strategy.md)).

---

## Remaining Credit Handling at Session End

What happens to unused wallet credit depends on the player's **account type**:

### A. Minor with a registered account
- Credit is simply **preserved in their existing account** — nothing else needed, it's still theirs for next time.

### B. Guest (no account, walk-in cash session)
- Credit is **refunded at the counter** by staff
- **Admin is notified** — this creates a compliance log entry (visibility that a minor was playing as a guest, useful for the café owner's own record-keeping/oversight)

### C. Guest choosing to create an account instead of a cash refund (staffed café)
- Guest can create a real registered account, and remaining credit transfers into the new account's wallet
- **Exception:** if the remaining credit is below a **minimum threshold set by the café owner** (e.g., ₱10), it's not worth transferring — it's just refunded in cash at the counter instead, no account created

### D. Unstaffed café (no one available to process a cash refund)
- Guest can create a **temporary account** to preserve their credit without needing staff intervention
- Temporary account has a **validity period set by the café admin** (e.g., valid for 7 days)
- If the validity period expires without the credit being claimed/used, the temporary account **deactivates** and the credit is forfeited (not carried over further)

**Note:** Temporary accounts are a general convenience feature, not exclusive to minors — any guest at an unstaffed café can use one to preserve credit between visits.

---

## Temporary Account Expiry Notifications

Applies to **every** temporary account holder, not just minors — anyone who creates a temporary account to preserve credit should be warned before it expires so they don't lose it unnecessarily.

- **Email is required** when creating a temporary account (used only for expiry reminders)
- Server sends a reminder email as the `temporary_expires_at` date approaches (e.g., 2 days before, and again on the day of expiry)
- **No SMS/phone notifications** — phone-based notifications cost money per message; email is free (or free-tier) and sufficient for an MVP built entirely on free-tier services
- If the account expires unclaimed despite the reminder, credit is forfeited as described above

---

## Data Model Implications

```
users (players)
  ├─ birthdate (required field)
  ├─ is_minor (computed/cached, refreshed periodically)
  ├─ account_type (registered, guest, temporary)
  ├─ email (required for temporary accounts — used for expiry reminders only)
  ├─ temporary_expires_at (nullable — only set for temporary accounts)
  ├─ temporary_expiry_reminder_sent (boolean — avoids duplicate reminder emails)
  ├─ temporary_deactivated (boolean)

cafes
  ├─ curfew_start (time, per branch)
  ├─ curfew_end (time, per branch)
  ├─ curfew_enabled (toggle — some branches may not be under any ordinance)
  ├─ min_credit_for_account_transfer (₱ threshold set by owner)
  ├─ temporary_account_validity_days (set by owner, e.g., 7 days)
  ├─ is_staffed (toggle — determines refund vs temp-account flow)

sessions
  ├─ ended_reason (add value: "curfew_auto_end")

admin_notifications
  ├─ type (e.g., "minor_guest_curfew_refund")
  ├─ cafe_id
  ├─ session_id
  ├─ amount_refunded
  ├─ created_at

age_verifications (shared with social/README.md — used to unlock friends/chat)
  ├─ id
  ├─ user_id
  ├─ verified_by_staff_id (FK → staff, accountability record)
  ├─ cafe_id (branch where verification happened)
  ├─ verified_at
  ├─ id_type_checked
  ├─ notes
```

## Enforcement Logic (Simplified Flow)

```
Every login attempt / reservation request:
  1. Check player.is_minor
  2. If minor AND cafe.curfew_enabled:
       Check current time against cafe.curfew_start/end
       If within curfew window → reject login / reservation
  3. If minor already in active session:
       Background job checks every minute:
         If curfew_start reached → warn player, then auto-end session
         Route to credit-handling logic below

Credit handling on forced session end:
  1. If account_type == "registered" → preserve credit in account, done
  2. If account_type == "guest":
       a. If cafe.is_staffed:
            Offer choice: cash refund at counter, OR create account
            If create account AND remaining_credit >= cafe.min_credit_for_account_transfer:
               Transfer credit to new account
            Else:
               Refund in cash at counter
            → Notify admin (admin_notifications log entry)
       b. If NOT cafe.is_staffed:
            Offer to create temporary account
            Set temporary_expires_at = now + cafe.temporary_account_validity_days
            If validity expires unused → deactivate account, forfeit credit
            → Notify admin (admin_notifications log entry)
```

---

## Owner-Configurable vs. Platform-Fixed Security Settings (Locked Decision)

A request was made to make **all** safety measures toggleable per café — curfew, age verification, teen/adult chat separation — backed by a liability waiver café owners sign when subscribing, on the theory that this shifts all legal responsibility to them. **This was declined for the core minor-protection mechanisms**, after explaining the reasoning, and the owner deferred the final call. Recorded here permanently so this doesn't get quietly reversed in a future session without the same context.

**Why a waiver doesn't solve this:** a signed form does not reliably waive statutory child-protection obligations (e.g., RA 7610 in the Philippines). If a café disables a protection and a minor is harmed, "they agreed to a form" is unlikely to shield the café owner — and it specifically would NOT shield the platform, since the platform would have knowingly built and shipped the bypass. This is a business-existential legal risk, not a technical preference, and genuinely warrants real legal counsel before ever being revisited — not something to decide by default in a schema design session.

### What IS café-owner-configurable (`cafes` table toggles — no safety trade-off):
- `curfew_enabled`, `curfew_start`/`curfew_end` — whether/when curfew applies (LGU ordinances differ by branch)
- `lobby_chat_enabled` — whether local (per-branch) chat rooms exist at all for that café
- `remote_verification_enabled` (added in `010_cafe_security_toggles`) — whether that café allows photo-based remote verification, or requires in-person-only. Turning this off only changes *how* someone gets verified — it does NOT weaken what "verified" means or who can chat with whom.

### What is NOT toggleable, fixed platform-wide, no schema exists to disable it:
- Kids get no chat access, period — no `cafes` column exists to override this, and none should be added without redoing this entire risk analysis first
- Teens and adults never chat with each other — enforced by the `trg_friends_tier_match`/`trg_messages_tier_check` database triggers (`009_social`), not a setting
- Some form of staff verification is always required before ANY chat unlocks — self-reported age never grants access, only restricts (same as curfew)

---

## Open Decisions (Need Owner Input)

- [ ] Exact minor age cutoff — under 18? Some LGUs define minors as under 15 for curfew purposes — confirm which applies
- [ ] Should age verification be self-reported only, or require staff ID check for stricter cafés?
- [ ] Should curfew rules be configurable per branch (recommended, since ordinances differ by city) or fixed platform-wide?
- [ ] What warning time should display before auto-ending a minor's session (5 min? 10 min?)
- [ ] Default `min_credit_for_account_transfer` threshold suggestion, or fully owner-configurable with no platform default?
- [ ] Default `temporary_account_validity_days` suggestion (e.g., 7 days), or fully owner-configurable?
- [ ] Does a forfeited temporary-account credit get logged anywhere for the café owner's records (e.g., "unclaimed credit" report), or simply disappears?
- [ ] Which free-tier email service to use for expiry reminders (e.g., free SMTP relay, or a free tier of a transactional email provider) — needs research during Foundation phase since volume limits vary
- [ ] Photo retention window for remote verification submissions (default suggestion: 30 days post-decision, then auto-purge)
- [ ] Rejection threshold before `remote_verification_blocked` is set (default suggestion: 3 rejections, then in-person-only)
