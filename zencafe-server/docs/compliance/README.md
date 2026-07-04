# Minor Curfew Protection

Many LGUs (local government units) in the Philippines enforce curfew ordinances restricting minors from public establishments during certain hours. Since some cafés run 24/7, this must be **enforced automatically by the server**, not left to staff discretion.

---

## Core Rule

**Player accounts must record age (via birthdate) at registration.** The server calculates whether the account belongs to a minor, and automatically locks that account from starting or continuing a session during curfew hours.

---

## Design

### 1. Age Capture
- Require **birthdate** (not just "are you 18+" checkbox) at account registration
- Store birthdate, calculate age server-side whenever curfew logic runs (never trust a client-side age claim)
- Minor = under 18 (default assumption; may vary — see Open Decisions)

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

## Open Decisions (Need Owner Input)

- [ ] Exact minor age cutoff — under 18? Some LGUs define minors as under 15 for curfew purposes — confirm which applies
- [ ] Should age verification be self-reported only, or require staff ID check for stricter cafés?
- [ ] Should curfew rules be configurable per branch (recommended, since ordinances differ by city) or fixed platform-wide?
- [ ] What warning time should display before auto-ending a minor's session (5 min? 10 min?)
- [ ] Default `min_credit_for_account_transfer` threshold suggestion, or fully owner-configurable with no platform default?
- [ ] Default `temporary_account_validity_days` suggestion (e.g., 7 days), or fully owner-configurable?
- [ ] Does a forfeited temporary-account credit get logged anywhere for the café owner's records (e.g., "unclaimed credit" report), or simply disappears?
- [ ] Which free-tier email service to use for expiry reminders (e.g., free SMTP relay, or a free tier of a transactional email provider) — needs research during Foundation phase since volume limits vary
