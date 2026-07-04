# Gamification — Bragging Rights System

## Design Philosophy

Lean into ego, not shared goals. Every feature here is designed so that a player wanting to flex their status directly drives café revenue: more hours played (billable time), more spending (Game Pass, cosmetics), and more foot traffic (defending rank in person, bringing friends to witness a challenge). The bragging right is the hook for the player; the revenue is the outcome for the café.

**Hard constraint carried over from earlier design:** we can only measure what the server actually sees — time, credit spent, streaks, games played, referrals. We cannot measure in-game skill (kills, wins, rank in Valorant/CS2), since that data lives inside each third-party game, not our platform. So bragging rights are built entirely on **presence and spend data**, not fake skill claims.

**Minor safety rule (consistent with [compliance/README.md](../compliance/README.md)):** spend-based leaderboards and badges are **adults-only** (same `social_unlocked` / staff-verification gate used for friends/chat) — a minor should never feel pressure to spend more to compete for status.

---

## 1. Leaderboard Categories

| Category | Metric | Eligibility |
|---|---|---|
| Most Hours (overall) | total session minutes | all players |
| Most Hours (per game) | minutes in a specific game, e.g. "Top CS2 player" | all players |
| Longest Streak | consecutive days with a session | all players |
| Most Diverse Player | distinct games played | all players |
| Top Spender | credit spent in the period | **staff-verified adults only** |
| Referral Champion | players successfully referred | all players |

Each category runs **per branch** and **cross-branch** (platform-wide) separately — a player can be #1 at their home café even if they're not #1 across the whole network, giving more players a realistic shot at some form of bragging rights.

---

## 2. Seasons (Keeping Competition Fresh)

- Leaderboards run in **seasons** — weekly and monthly windows, tracked independently
- At the end of a season, the final standings are **frozen into permanent history** (`season_history`) before live counters reset to zero for the next season
- This means a player who was #1 in "Week 12" keeps that as a permanent bragging credential ("Season 12 Champion") even after being dethroned — old glory isn't erased, it becomes a trophy

---

## 3. Rank Change Detection & Broadcast

**Process:**
1. A background job recalculates standings whenever a relevant event occurs (session ends, credit spent, streak updates) — not a constant poll, to keep it cheap
2. If the recalculation changes who holds **#1** in any category at a branch, a broadcast event fires
3. The broadcast pushes (via the existing WebSocket infrastructure already used for session sync) to **all PCs at that branch**, displaying an on-screen banner: *"🔥 [Player] just became #1 this week!"*
4. The same event also updates the **Wall of Fame** display (a dedicated idle-screen or shared display in the café showing current standings) so it's visible to everyone physically present, not just the person who earned it

---

## 4. Earned-Only Cosmetics & Titles (Cannot Be Bought)

- A special category of cosmetics/titles is flagged as **rank-locked** within the existing platform-owned cosmetics catalog (see [business-model/README.md](../business-model/README.md)) — same catalog, but these specific items are never purchasable, only auto-granted
- **While holding #1:** the player wears the title/cosmetic automatically
- **After losing #1:** the live title is removed, but a **permanent "Former #1 — Season X" badge** stays on their profile forever — this is what makes the season-freeze important; the flex doesn't disappear, it becomes a permanent trophy
- **"First to..." titles** — one-time permanent badges for being first to hit a milestone in a given month (first to 100 hours, first to buy a new cosmetic, etc.) — rewards active early participation, not just raw grinding

---

## 5. Real-World Perk: VIP Seat

- Each branch can designate one PC as the **"VIP Seat"** in its settings
- The current #1 player (by whichever category the café owner chooses, e.g., overall hours) gets that seat **free or discounted** for the duration they hold the title
- **Integrates with the existing reservation system** ([business-model/README.md](../business-model/README.md) reservation section) — the VIP seat is auto-reserved for the current title holder, and the normal reservation/credit-burn rules still apply to everyone else trying to book it
- This is the most visible real-world perk — everyone in the café can see who's sitting in "the" seat

---

## 6. Challenge Mechanic

- A player can publicly **challenge** another player's record (e.g., "beat my 10-day streak") directly from their profile
- Both players get notified; the challenge is visible to both (and optionally to friends) until it resolves
- Resolution: challenge auto-closes when either the challenger surpasses the record, the challenged player extends their lead further, or a time limit (owner-configurable) expires
- This turns a silent leaderboard number into a social event between two specific players, not just a passive ranking

---

## Data Model

```
leaderboard_seasons
  ├─ id
  ├─ cafe_id (nullable — null means cross-branch/platform-wide)
  ├─ category (hours_total, hours_per_game, streak, diverse_games, top_spender, referral)
  ├─ period_type (weekly, monthly)
  ├─ starts_at / ends_at
  ├─ status (active, closed)

leaderboard_entries
  ├─ season_id (FK)
  ├─ user_id
  ├─ game_id (nullable, only for hours_per_game category)
  ├─ score (minutes, streak days, ₱ spent, etc — meaning depends on category)
  ├─ rank (computed, refreshed on recalculation)

season_history (frozen standings after a season closes)
  ├─ season_id (FK)
  ├─ user_id
  ├─ final_rank
  ├─ title_awarded (e.g., "Season 12 Champion — Most Hours")

rank_locked_cosmetics (subset of the existing cosmetics table)
  ├─ cosmetic_id (FK → cosmetics)
  ├─ unlock_condition (e.g., "hold #1 in hours_total at any branch")

user_badges
  ├─ user_id
  ├─ badge_type (former_champion, first_to_achieve, vip_seat_holder, etc)
  ├─ label (display text, e.g., "Former #1 — Season 12")
  ├─ awarded_at
  ├─ is_permanent (boolean — true for season/first-to badges, false for "currently holding" live status)

cafes — addition
  ├─ vip_seat_pc_id (nullable, FK → pcs)
  ├─ vip_seat_category (which leaderboard category grants the VIP seat)

challenges
  ├─ id
  ├─ challenger_id
  ├─ challenged_id
  ├─ category
  ├─ target_value (the record being chased)
  ├─ status (pending, active, won_by_challenger, defended_by_challenged, expired)
  ├─ expires_at
```

---

## How This Connects to Systems Already Built

- **Billing/Sessions** ([billing_service.h](../../src/billing/billing_service.h), [session_manager.h](../../src/sessions/session_manager.h)) — supplies the raw hours/spend data leaderboards are computed from; no new tracking needed, just aggregation
- **Reservation system** ([business-model/README.md](../business-model/README.md)) — VIP seat auto-reservation reuses the exact same lock/credit-burn logic already designed, just with a different trigger (rank instead of manual booking)
- **Social profiles** ([social/README.md](../social/README.md)) — badges and titles display on the profile already designed there; this doc defines *how* those badges are earned, social doc defines *how* they're shown
- **Compliance/minor safety** ([compliance/README.md](../compliance/README.md)) — the same `social_unlocked` staff-verification flag that gates friends/chat also gates eligibility for spend-based leaderboards

---

## Open Decisions (Business/Policy — Need Owner Input)

- [ ] Which category grants the VIP seat by default (overall hours seems the fairest — spend-based would favor whoever has the most money, not the most loyal player)
- [ ] Challenge time limit default (e.g., 7 days to beat a streak challenge before it auto-expires)
