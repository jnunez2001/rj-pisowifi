# ZenCafe Business Model & Revenue Flows

This document defines **who controls what, and where the money goes** for each monetized feature. This matters for database design (who owns each transaction) and for API permissions (who can toggle/edit what).

---

## 1. PC Reservation System (Credit-Burn Model)

Players can reserve a specific PC in advance via app/web. The PC is powered on and locked to that player only.

**Key rule:** Credit starts burning at the **reserved time**, not when the player physically arrives.
- No-shows naturally lose credit — no separate deposit/refund system needed
- Late arrivals simply lose the time between reservation start and actual login
- Self-cleaning: no manual staff intervention required for no-shows

**Rules to enforce:**
- **Grace period** — if nobody logs in within a configurable window (e.g., 30 min), auto-cancel the session and release the PC back to public walk-in use
- **Minimum credit to reserve** — require a minimum wallet balance (e.g., 1 hour worth) before allowing a reservation, so short/empty reservations don't lock a PC pointlessly
- **Identity lock** — only the account that made the reservation can log into that specific PC during the reserved window; no other player can claim it
- **Auto-release on zero credit** — if the player never shows and credit hits zero, PC auto-unlocks back to public availability

---

## 2. Cosmetics Marketplace (Platform-Owned)

**Revenue flow:** Player buys cosmetic → **money goes to Zentry Systems (platform)**, not the café owner.

**Why:** Zentry controls the cosmetics catalog, designer approvals, and marketplace curation — it's a platform-level product, not a café-level one.

**What the café DOES control:**
- Their **shop logo / branding** appears in designated placement slots within the client-side cosmetics UI (e.g., a "presented by [Shop Name]" banner or branded corner)
- This is purely cosmetic/branding — the café earns no cut of cosmetics sales, but gets visibility/branding presence in front of their own customers

**What the café does NOT control:**
- Cannot add/remove cosmetic items themselves
- Cannot set cosmetic prices
- Cannot receive cosmetics revenue directly

**Data model implication:**
- `cosmetics` table stays platform-owned (no `cafe_id` foreign key needed for ownership — only for optional branding placement config)
- `transactions` table needs a `payee` field: `platform` vs `cafe`, so revenue routes correctly
- Need a `branding_slots` config per cafe (logo image, display position, on/off toggle)

---

## 3. Game Pass — Two-Layer Subscription Model

This feature has **two separate subscription relationships** stacked on top of each other:

### Layer 1: Café Owner → Zentry (Platform) — "Unlocking the feature"

Before a café can offer Game Pass to their players at all, **the café owner must subscribe to Zentry** to unlock the module.

- This is a **platform feature subscription** — separate from, and in addition to, the base per-PC licensing fee (see Section 4 below)
- If the café owner doesn't subscribe to this module, the Game Pass toggle simply isn't available in their admin dashboard
- Revenue from this subscription → **Zentry (platform)**

### Layer 2: Player → Café Owner — "Buying the Game Pass"

Once unlocked, the café owner configures their own Game Pass (price, perks, rewards) and players can subscribe to it.

- Player pays using their **wallet credit at that café** (same credit system used for session time)
- The café sets the price and perks — full control over their own product
- Revenue from player purchases → **café owner** (not Zentry)

**Why split it this way:** Zentry earns recurring platform revenue for providing the *capability*, while the café owner earns the *actual usage revenue* from their own customers. This mirrors how POS systems charge merchants a monthly fee for "loyalty program" features, while the merchant keeps the loyalty revenue itself.

**Data model implication:**
- New table: `platform_subscriptions` — `cafe_id`, `feature` (e.g., `game_pass`), `status`, `billing_cycle`, `expires_at` — tracks which platform features a café has unlocked
- New table: `game_passes` — `cafe_id`, `name`, `price`, `perks` (JSON), `active` (toggle, only available if `platform_subscriptions` shows `game_pass` active), `billing_cycle`
- New table: `subscriptions` — `player_id`, `game_pass_id`, `status`, `renewed_at`, `expires_at` — tracks player-to-café Game Pass subscriptions
- `transactions` table: needs `payee` field distinguishing `platform` (Layer 1 fee) vs `cafe` (Layer 2 player payment)

---

## 4. Per-PC Platform Licensing Fee (Base Subscription)

**Revenue flow:** Café owner pays Zentry a recurring fee **per PC** they operate (e.g., ₱10-50/PC/month, exact pricing TBD).

**Why:** This is the base cost of running any ZenCafe OS-managed PC at all — separate from any optional feature add-ons like Game Pass. More PCs = more platform revenue, scaling naturally with the café's size.

**How it interacts with other features:**
- This fee is required just to operate — it's not optional like the Game Pass module
- A café could pay the per-PC fee and NOT subscribe to Game Pass — they'd just run sessions/billing/cosmetics without the subscription feature
- If a café stops paying (lapses), their PCs likely need to be locked/disabled from operating (business rule to decide)

**Data model implication:**
- `platform_subscriptions` table (same as above) can also track `feature = 'base_pc_license'` with a `pc_count` field, or a separate `pc_licenses` table: `cafe_id`, `pc_id`, `monthly_fee`, `status`, `renewed_at`

---

## Revenue Routing Summary

```
Who pays...              For...                    Money goes to...
──────────────────────────────────────────────────────────────────────
Café owner            →  Per-PC licensing       →  Zentry (platform)
Café owner            →  Game Pass module       →  Zentry (platform)
                          unlock (optional)
Player                →  Session time            → Café owner
Player                →  Cosmetics marketplace   → Zentry (platform)
Player                →  Game Pass subscription  → Café owner
                          (paid via café credit)
```

---

## Additional Platform Monetization Ideas (For Consideration)

1. **Tiered SaaS subscription for café owners** — Basic/Pro/Enterprise plans gating features like multi-location support, advanced analytics, or Game Pass access itself (i.e., Game Pass is a Pro-tier feature)

2. **Platform fee on Game Pass transactions** — small % cut (5-10%) since Zentry provides the billing/subscription infrastructure

3. **Sponsored/featured cosmetics slots** — designers could pay extra for their items to appear in a "Featured" section of the marketplace (platform revenue)

4. **Kiosk idle-screen ad slots** — when a PC is idle/unclaimed, show rotating ads (café's own food menu, or third-party ads) — platform or café revenue depending on who sells the ad space

5. **White-label branding upgrade** — cafés on a higher subscription tier could get more branding customization (custom boot screen, custom kiosk theme) as a paid upsell

6. **Designer revenue share tier** — even though cosmetics revenue goes to platform, offering top designers a rev-share (e.g., 20-30%) incentivizes better cosmetic submissions and content quality

---

## Open Decisions (Need Owner Input)

- [ ] Per-PC licensing price — exact ₱ amount within the 10-50 range, or tiered by PC count?
- [ ] Game Pass module unlock price — flat monthly fee, or % of café's Game Pass revenue?
- [ ] What happens to a café's PCs if their per-PC license lapses (auto-lock? grace period?)
- [ ] Should designers get any cosmetics revenue share, or 100% platform?
- [ ] Reservation grace period — how many minutes before auto-release?
- [ ] Minimum credit required to make a reservation?
