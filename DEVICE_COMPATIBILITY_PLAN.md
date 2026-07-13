# Device Compatibility — Plan for Commercial Site Listing

**Status:** Planning only. For the future commercial site (once ZenWiFi ships), matching the tiered "compatible hardware" presentation style FastFi already uses (Highly Recommended / Fully Supported / Broad Compatibility cards). Specific model names/prices below should be re-verified closer to actual launch - hardware availability and pricing shift over time, this is a starting framework, not a locked-in final list.

## The honest baseline requirement

rj-pisowifi/ZenWiFi needs a real, general-purpose Linux computer to run on - not a purpose-built embedded router chip. Concretely:

- **RAM**: 1GB+ comfortable, 512MB workable but tight (SQLite + Node.js/Express + all services running together)
- **Storage**: a few GB free is plenty (the app itself is small; real growth is session/financial log history over time)
- **CPU**: any x86_64 or ARM64/ARMv7 - Node.js doesn't care about architecture, just needs a real one, not a router SoC purpose-built to be minimal
- **OS**: Ubuntu is what's tested/documented today; any modern Debian-based Linux would very likely work with minor `install.sh` adjustments, untested

This rules out cheap consumer OpenWrt-flashable routers by design, not oversight - see "Explicitly Not Supported" below.

## Tier 1 — Highly Recommended (best price/performance for a dedicated box)

- **Mini PCs** (Intel N100-class or similar, widely available under $150): Beelink, GMKtec, and similar budget mini PC brands, or a basic Intel NUC. Far more power than this app needs, silent, low power draw, easy to source. This is the most practical "buy this and go" recommendation for a new deployment.

## Tier 2 — Fully Supported (single-board computers, if adequate RAM)

- **Raspberry Pi 4 or 5** (2GB RAM minimum, 4GB+ recommended) - widely available, excellent ARM64 Linux support, well-documented community.
- **Orange Pi 3B/4/5-class boards** (1GB+ RAM models) - cheaper alternative to Raspberry Pi with comparable capability at this RAM tier. (Distinct from the Orange Pi One used in FastFi's build, which is a smaller, GPIO-coin-slot-focused board with less RAM - not the same recommendation.)

## Tier 3 — Broad Compatibility (repurposed / secondhand hardware)

- **Any old laptop or desktop with Ubuntu installed** - genuinely the most common real-world setup for a small shop starting out (this is literally what's running the live field test tonight). Zero extra hardware cost if one's already sitting unused.
- **Secondhand thin-client boxes** (small corporate VDI terminals, very cheap on the secondhand market, more than enough CPU/RAM for this workload once reflashed with a normal Linux distro).

## For router mode specifically: separate hardware, separate list

Router mode needs a MikroTik device alongside the server box (two separate pieces of hardware, unlike FastFi's all-in-one router builds). Worth its own short recommended-router list once this section gets built out - the models already field-tested tonight (hEX/hEX S class) are the natural starting point, expanding to hAP-series and others as more get tested.

## Explicitly NOT supported (and why - real constraint, not a gap to close)

- **Cheap consumer OpenWrt-flashable routers** (the class of hardware FastFi's router builds target - Comfast N5, Newifi D2, Ruijie EW1200G Pro, generic OpenWrt devices). Typically 128-256MB total RAM on a low-power embedded SoC that also has to do the actual WiFi/routing job at the same time. Node.js's runtime overhead (V8 engine + a loaded Express app) can eat 50-150MB+ RAM on its own - doesn't fit alongside a router doing its real job on that class of hardware. This is exactly why FastFi is written in Lua for those specific builds, not a heavier language - a real technical constraint, not an oversight to "just fix." That hardware category stays FastFi's lane, not ZenWiFi's.
- **Very low-RAM SBCs** (Raspberry Pi Zero, older Pi models under 1GB RAM, Orange Pi Zero/Lite-class boards) - same underlying reason, insufficient RAM for comfortable Node.js operation.

## One real exception worth tracking, not promising yet

Newer MikroTik hardware running RouterOS 7+ supports actual Docker-style containers directly on the router. On specific, more capable MikroTik models (not the low-end ones), it's theoretically possible to run a lightweight Node.js container directly on the router itself - collapsing this app onto the same box as the router, closer to FastFi's all-in-one model but on MikroTik hardware instead of OpenWrt. Not verified this project's actual footprint would fit comfortably even there, and only applies to specific RouterOS 7+ models - worth testing later as a possible "all-in-one on MikroTik" tier, not something to list as supported until actually tried.
