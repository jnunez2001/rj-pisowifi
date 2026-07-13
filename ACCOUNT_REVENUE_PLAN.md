# Accounts & Revenue Features — Plan

**Status:** Planning only, nothing built yet. Build after the router-mode launch (2026-07-13) has run stable for real customers for a while — this is a real scope addition on top of an already-live payment system, not something to rush in behind it.

## Why this exists

Beyond the coin-slot/voucher model already live, there's a real opportunity to increase revenue and retention through: customer accounts with a spendable points balance, honest daily-login rewards, bundle pricing, game top-up reselling, and digital cash-in via GCash/Maya. All of it framed around one rule set during planning: nothing that makes a customer believe they're getting more than they actually get. The earlier "speed up the timer" and "gambling for time" ideas were declined for exactly that reason — everything below only ever gives the customer *at least* what they were told, never less.

## Feature list, in build order

### Phase 1 — Foundation (no external dependencies)

1. **Customer accounts + points balance**
   - A lightweight account (phone number or a simple PIN/device-remembered login — no email/password friction for a walk-in cafe customer)
   - A `points` balance, separate from real peso value, that can be spent on time or (later) store items
   - Every coin/voucher/free-claim credit already happening today could *also* award points at a fixed, disclosed rate (e.g. ₱1 = 1 point) — this is additive, doesn't change how time itself is earned
   - This is the foundation everything else in this plan builds on

2. **Daily login claim (5 min)**
   - Once per calendar day per account, a guaranteed (not chance-based) bonus — exactly what you asked for, no wagering
   - Straightforward extension of the existing `free_claims`/`free_minutes` pattern already in the codebase, just account-scoped instead of MAC-scoped-once-ever

3. **Bundle deals**
   - Rates Manager already maps coin value → minutes; this adds a second tier of "buy more, get a better rate" bundles (e.g. ₱50 → 180 min instead of the linear 150 min a flat rate would give)
   - Can also bundle WiFi/PC time with a sari-sari store item at a combined price, once the store-item feature (Phase 3) exists

### Phase 2 — Depends on you setting something up first

4. **E-wallet cash-in (GCash/Maya)**
   - **Update: a much simpler path exists, no payment gateway/KYC needed.** Confirmed working in FastFi's own router builds (`gcash.lua`, `FASTFI-NEWIFI-D2-V2.1.5` and others): customer picks a package, gets shown a GCash QR code + the exact peso amount to send, pays manually via any personal GCash account, and a spare Android phone running a generic SMS-forwarding app detects GCash's own payment-received SMS and forwards the amount to the server, which matches it against the oldest pending order for that exact price and auto-credits it. No PayMongo/Xendit account, no business KYC, no formal merchant relationship - just a GCash account (personal is fine) and one cheap Android phone dedicated to SMS forwarding.
   - **Known limitation, inherited from this approach:** matches by amount only, not a unique per-order reference - if two customers pick the exact same price at the same moment, the credit could land on the wrong pending order. FastFi accepts this tradeoff for simplicity; worth deciding whether to accept it here too or add a reference-number step (e.g. last 4 digits of the sender's GCash-registered mobile, which `gcash.lua` already collects) to disambiguate.
   - Formal payment gateway (PayMongo/Xendit) is still the more "official" path if wanted later, but is no longer a prerequisite to start - this can ship much sooner than originally planned.
   - Adds balance to a customer's points/account, which they then spend the same way as coin-credited points

5. **Game top-up reselling** (ML diamonds, Free Fire diamonds, PUBG UC, etc.)
   - Needs you to already have (or set up) supplier/reseller access for these top-ups — most small PH shops go through a reseller network or a load/top-up wholesaler, not directly through Garena/Moonton
   - Once you have that relationship, this becomes a simple catalog + order-forwarding feature: customer spends points/cash, you fulfill the top-up through your existing supplier relationship the same way you would manually

### Phase 3 — Once Phase 1 is solid

6. **VIP tiers** — spend thresholds unlock better rates/point multipliers
7. **Referral bonus** — both sides get bonus points on a successful referral
8. **Reserved PC slots** — book ahead from an account, small reservation fee
9. **Store items via account balance** — print/scan, sari-sari inventory, anything else you stock

## What I need from you before each phase

- **Phase 1**: nothing — can start once you say go
- **Phase 2, e-wallet**: a GCash account + QR code (personal is fine, already have this) and a spare Android phone for SMS forwarding - much lower barrier than originally planned, see the update above
- **Phase 2, game top-ups**: your existing (or new) supplier/reseller relationship details

## Design principle carried through all of it

Every point, every bundle, every bonus is **additive and disclosed** — a customer always gets at least what a plain coin-insert would have given them, points/bonuses are extra, never a substitute that quietly gives less. This is the same standard applied to tonight's real burst feature (Security → Bandwidth Control) and the free-minutes system already live.
