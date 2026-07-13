# Freemium Strategy — Free (Capable) / Pro (Rich) / Donate

**Status:** Planning only, nothing built yet. This is the guiding philosophy other plans (`ACCOUNT_REVENUE_PLAN.md`, `PIHOLE_PLAN.md`, `DEVICE_COMPATIBILITY_PLAN.md`) should be read against - it consolidates several business-strategy decisions made across one long planning session into one coherent statement, so future work doesn't have to re-derive it from scattered conversation.

## The core philosophy (owner's explicit framing)

- **Free tier must be genuinely capable** - a real, usable product on its own, not artificially crippled just to force upgrades. This is also what directly serves the "beat FastFi on cost, win the low-end market" strategy already decided - a free tier that's obviously worse than the competition doesn't win that market, it loses it.
- **Paid tier should be feature-reach** - real depth and power for operators who want/need more, genuinely worth paying for, not just "the same thing with a paywall removed."
- **A donate option, unconditional** - free-tier users who want to support the project can, with no feature unlock attached to it. Goodwill support, not disguised payment.

## Free tier — Standalone mode, the FastFi-cost-competitor

- Coin slot payment, sessions, vouchers
- Basic captive portal
- Flat-rate bandwidth cap (no burst)
- Daily free-minutes claim
- Runs on genuinely cheap hardware (`DEVICE_COMPATIBILITY_PLAN.md`'s Tier 3/4 - reused old laptops, or sub-$30 ARM boards once load-tested)

This list is a starting draft, not final - revisit once there's real usage data on what free-tier operators actually need to feel the product is complete on its own.

## Pro tier — Router mode + everything built on top of it

- Router mode itself (MikroTik integration, VLANs, multi-lane setups, Hotspot)
- Real speed burst (honest, router-enforced - built this session)
- Game-priority queueing (built this session)
- Custom portal hostname (built this session)
- Ad-blocking, once built (`PIHOLE_PLAN.md` - already decided: free for year 1, then part of Pro at ₱300/yr after that)
- Accounts, points, e-wallet cash-in, once built (`ACCOUNT_REVENUE_PLAN.md`)

## Donate — voluntary, no strings

A simple way for free-tier operators to support the project without needing or wanting Pro features. Technically cheap to build: reuse the same Maya Checkout / GCash-QR payment mechanism already researched for cash-in (`ACCOUNT_REVENUE_PLAN.md`), just relabeled as a "Support ZenWiFi" button in the admin panel instead of a time-purchase flow - no new payment infrastructure needed, just a different label and destination for the same underlying payment rail once it exists.

## The real dependency this whole plan sits on

None of the Free/Pro split *means* anything without a real way to tell which install is entitled to which tier - a licensing/entitlement layer. This is the same gap already flagged in `PIHOLE_PLAN.md` and `FASTFI_COMPARISON_PLAN.md` (FastFi's own working `license.lua` is the best reference architecture found so far, though it depends on a cloud service that doesn't exist for this project yet). Building genuine Free/Pro gating requires this to exist first - worth prioritizing once there's a concrete Pro feature ready to gate, not before.

## Suggested order

1. Finish validating Standalone mode on genuinely cheap hardware (`DEVICE_COMPATIBILITY_PLAN.md`'s open action item) - this is what makes the free tier's core promise ("capable AND cheap") actually true, not just a mission statement.
2. Build the licensing/entitlement layer (own project, references FastFi's `license.lua` architecture) - required before any real Pro-tier gating can exist.
3. Only then: start gating the Pro features already built (Router mode depth, burst, game priority, custom hostname) behind real license checks, plus the Donate button (cheap to add once the payment rail exists for cash-in anyway).
