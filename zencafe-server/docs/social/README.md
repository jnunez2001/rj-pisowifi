# Social Features — Friends, Chat & Profiles

Turns ZenCafe from a rental platform into a social hangout: players can add friends, chat, and view each other's profiles (status, collected cosmetics, badges).

**This doc was substantially revised** — the original design fully blocked all minors from social features. That's been replaced with a three-tier model (kids / teens / adults) that allows restricted chat for teens, since kids-only blocking versus teens-allowed-but-restricted was requested directly. See [database/README.md](../database/README.md) and [compliance/README.md](../compliance/README.md) for the tier definitions.

---

## 1. The Three Tiers (Kids / Teens / Adults)

| Tier | Age | Chat access | Requires staff verification? |
|---|---|---|---|
| **Kids** | Under 13 | **None at all** — no exceptions, not configurable | N/A — kids never get chat regardless of verification |
| **Teens** | 13-17 | Restricted to a **teens-only** pool: local (per-branch) teens chat + a global (cross-branch) teens chat. Never mixed with adults. | **Yes** — staff must verify and specifically confirm the "teens" tier |
| **Adults** | 18+ | Full global chat (local + global adult rooms) | **Yes** — staff must verify and confirm the "adults" tier |

**Why self-reported age isn't enough here (same principle as before):** a minor could simply claim to be older. Chat access — even the restricted teens-only version — is *access-granting*, so it still requires staff verification (the selfie+ID flow from [compliance/README.md](../compliance/README.md)), not just a self-reported birthdate. The difference from the original design is that verification can now result in a **teens** classification with restricted access, rather than only a binary pass/fail for adult status.

**The single most important rule in this whole feature: a teen must never be able to friend or message an adult, or vice versa.** Given the stakes, this is enforced by an actual database trigger (`trg_friends_tier_match`, `trg_messages_tier_check` in `009_social`), not just a service-layer convention — a deliberate exception to how the rest of this schema handles cross-table business rules (everywhere else, e.g. Game Pass activation, those are left to the service layer).

---

## 2. Friends System

- **Send/accept/reject friend requests** — only between two accounts holding a **matching, non-null `verified_chat_tier`** (both teens, or both adults). Enforced at the database level, not just the app.
- **Kids and unverified accounts cannot add friends at all** — attempting it raises a database error, not a silent no-op.
- **Friend list** — see who's currently online/in-session
- **Unfriend / block** — either party can remove the connection at any time

### Accountability: Who Verified the Account

- Every verification is logged with **which staff member performed it**, **which tier they confirmed** (teens or adults), **which branch**, and **when** — not just a true/false flag
- This matters if a minor slips through (staff error or misconduct) — there's a clear record of who approved it and what tier they assigned, for both café owner accountability and platform-level compliance

---

## 3. Player Profile (Visible to Friends)

Shows what the server can actually verify — no fake "skill" stats:

- **Status** — online, in-session, or offline (toggle: player can set visibility to `public`, `friends-only`, or `private`)
- **Currently playing** — which game, optionally which branch (respects the same visibility toggle)
- **Collected cosmetics showcase** — display owned skins/items from the marketplace
- **Badges** — full earning logic (leaderboards, seasons, rank-locked cosmetics, challenges) documented in [gamification/README.md](../gamification/README.md); this profile just displays them

---

## 4. Chat

- **Direct messages** — between two accounts with a matching verified tier, same rule as friends
- **Chat rooms** — each tier gets its own rooms, never shared:
  - **Local room** — one per café branch, per tier (e.g., "this café's teens chat")
  - **Global room** — one per tier, platform-wide (e.g., "global teens chat" spanning every branch)
  - Kids never get a room in either scope — there is no "kids chat"

---

## 5. Safety & Moderation (Must-Have, Not Optional)

- **Basic profanity/keyword filter** — free to implement (a blocklist check), no paid API needed, keeps us within the free-tier development goal
- **Report & block** — any player can report a message or block a user; blocked users can no longer message or see that player's profile. Available to both teens and adults (kids have no chat surface to report from).
- **Admin moderation view** — reported messages appear in the admin dashboard for the café owner (or platform-level moderation, TBD) to review
- **Message retention** — reported messages should be retained (not deleted) until reviewed, so there's evidence to act on
- **Known limitation, not yet solved:** if a user's `verified_chat_tier` is ever revoked or changed *after* a friendship/room membership already exists, existing rows aren't automatically re-validated — the tier-match triggers only run at insert time. Periodic re-validation is a service-layer follow-up, not handled by this migration.

---

## Data Model Implications

```
chat_rooms
  ├─ id
  ├─ cafe_id (nullable — null means a global, cross-branch room)
  ├─ tier (teens, adults — kids never get a room)
  ├─ room_type (local, global)
  ├─ one global room per tier; one local room per (cafe_id, tier)

friends
  ├─ user_id
  ├─ friend_id
  ├─ status (pending, accepted, blocked)
  ├─ created_at
  ├─ DB trigger rejects the insert unless both users hold a matching, non-null
    verified_chat_tier

messages
  ├─ id
  ├─ sender_id
  ├─ receiver_id (nullable — set for a DM)
  ├─ room_id (nullable — set for a room post; exactly one of receiver_id/room_id is set)
  ├─ content
  ├─ flagged (boolean)
  ├─ created_at
  ├─ DB trigger rejects the insert if sender isn't verified, or if sender/room or
    sender/receiver tiers don't match

reports
  ├─ id
  ├─ reporter_id
  ├─ reported_user_id
  ├─ message_id (nullable — could report a profile, not just a message)
  ├─ reason
  ├─ resolved (boolean)
  ├─ created_at

users (players) — additions (see 008_content_and_chat_tiers)
  ├─ status_visibility (public, friends_only, private)
  ├─ age_tier (kids, teens, adults — self-reported, safe for restricting content)
  ├─ verified_chat_tier (teens, adults, nullable — staff-verified only, unlocks chat)

age_verifications / age_verification_requests (shared with compliance — see
  compliance/README.md) — now also record which tier was verified/approved, not just a
  pass/fail adult check
```

---

## Open Decisions (Need Owner Input)

- [ ] Who reviews reported messages — the café owner (per branch) or you (platform-level moderation)? Platform-level is more consistent but adds workload for you.
- [ ] Should a verified adult be able to add ANY other verified adult as a friend, or only players verified at the same physical branch (reduces stranger-contact risk)? Same question applies to teens within the teens-only pool.
- [ ] Profanity filter — English + Filipino/Tagalog word list, or English only for v1?
- [ ] What ID types are acceptable for staff verification (national ID, school ID, any government ID)? Needed so staff have a consistent checklist.
- [ ] Should there be a way to audit/flag a staff member who has an unusually high rate of verification disputes (accountability enforcement beyond just logging)?
- [ ] Periodic re-validation if a `verified_chat_tier` is revoked after friendships/rooms already exist — needed, or acceptable risk for v1?
