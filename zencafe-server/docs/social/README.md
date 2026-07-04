# Social Features — Friends, Chat & Profiles

Turns ZenCafe from a rental platform into a social hangout: players can add friends, chat, and view each other's profiles (status, collected cosmetics, badges).

---

## 1. Friends System

- **Send/accept/reject friend requests** between registered accounts (guest/temporary accounts cannot add friends — encourages account creation)
- **Friend list** — see who's currently online/in-session
- **Unfriend / block** — either party can remove the connection at any time

### Access Rule: Minors Cannot Use Social Features At All

- **Minors are fully blocked from friends and chat** — no friends-only exception, no opt-in. This is a hard rule, not a configurable one.
- **Self-reported age is not enough to unlock social features** — a minor could simply lie about their birthdate to bypass the block. To prevent this, **friends/chat requires staff-verified adult status**, not just a self-reported birthdate passing the age check.
- Practically: a new account defaults to **social features locked**. A staff member must verify the player's ID in person and mark the account as verified before friends/chat unlocks — same verification flow already planned for stricter curfew enforcement (see [compliance/README.md](../compliance/README.md)), now reused here.

### Accountability: Who Verified the Account

- Every verification is logged with **which staff member performed it**, at **which branch**, and **when** — not just a true/false flag
- This matters if a minor slips through (staff error or misconduct) — there's a clear record of who approved it, for both café owner accountability and platform-level compliance

---

## 2. Player Profile (Visible to Friends)

Shows what the server can actually verify — no fake "skill" stats:

- **Status** — online, in-session, or offline (toggle: player can set visibility to `public`, `friends-only`, or `private`)
- **Currently playing** — which game, optionally which branch (respects the same visibility toggle)
- **Collected cosmetics showcase** — display owned skins/items from the marketplace
- **Badges** — full earning logic (leaderboards, seasons, rank-locked cosmetics, challenges) documented in [gamification/README.md](../gamification/README.md); this profile just displays them

---

## 3. Chat

- **Direct messages (friends only by default)** — simplest and safest starting point
- **Optional: branch lobby chat** — a public chat room per café branch, for players physically at that location (more social, higher moderation need)

### Minors and Chat
- Since minors cannot use social features at all (see above), this applies uniformly: **no DMs, no lobby chat, no exceptions** until staff verifies the account as an adult
- Lobby chat (if enabled at all) is therefore only ever visible/usable by staff-verified adult accounts

---

## 4. Safety & Moderation (Must-Have, Not Optional)

Since minors are core users, chat needs guardrails from day one:

- **Basic profanity/keyword filter** — free to implement (a blocklist check), no paid API needed, keeps us within the free-tier development goal
- **Report & block** — any player can report a message or block a user; blocked users can no longer message or see that player's profile
- **Admin moderation view** — reported messages appear in the admin dashboard for the café owner (or platform-level moderation, TBD) to review
- **Message retention** — reported messages should be retained (not deleted) until reviewed, so there's evidence to act on

---

## Data Model Implications

```
friends
  ├─ user_id
  ├─ friend_id
  ├─ status (pending, accepted, blocked)
  ├─ created_at

messages
  ├─ id
  ├─ sender_id
  ├─ receiver_id (nullable if room-based)
  ├─ room_id (nullable — for branch lobby chat)
  ├─ content
  ├─ created_at
  ├─ flagged (boolean — set true if reported or filter-triggered)

reports
  ├─ id
  ├─ reporter_id
  ├─ reported_user_id
  ├─ message_id (nullable — could report a profile, not just a message)
  ├─ reason
  ├─ resolved (boolean)
  ├─ created_at

users (players) — additions
  ├─ status_visibility (public, friends_only, private)
  ├─ social_unlocked (boolean — true only if age_verifications has an approved record AND is_minor = false)

age_verifications (shared with compliance — see compliance/README.md)
  ├─ id
  ├─ user_id
  ├─ verified_by_staff_id (FK → staff/users, accountability record)
  ├─ cafe_id (which branch performed the verification)
  ├─ verified_at
  ├─ id_type_checked (e.g., "Philippine national ID", "school ID" — optional detail)
  ├─ notes

cafes — additions
  ├─ lobby_chat_enabled (boolean, opt-in per branch — only ever reachable by social_unlocked accounts)
```

---

## Open Decisions (Need Owner Input)

- [ ] Should branch lobby chat exist at all in v1, or start with friends-only DMs and add lobby chat later once moderation is proven?
- [ ] Who reviews reported messages — the café owner (per branch) or you (platform-level moderation)? Platform-level is more consistent but adds workload for you.
- [ ] Should a verified-adult be able to add ANY other verified-adult as a friend, or only players verified at the same physical branch (reduces stranger-contact risk)?
- [ ] Profanity filter — English + Filipino/Tagalog word list, or English only for v1?
- [ ] What ID types are acceptable for staff verification (national ID, school ID, any government ID)? Needed so staff have a consistent checklist.
- [ ] Should there be a way to audit/flag a staff member who has an unusually high rate of verification disputes (accountability enforcement beyond just logging)?
