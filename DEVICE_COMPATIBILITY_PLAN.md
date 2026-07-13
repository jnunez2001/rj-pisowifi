# Device Compatibility — Plan for Commercial Site Listing

**Status:** Planning only. For the future commercial site (once ZenWiFi ships), matching the tiered "compatible hardware" presentation style FastFi already uses (Highly Recommended / Fully Supported / Broad Compatibility cards). Specific model names/prices below should be re-verified closer to actual launch - hardware availability and pricing shift over time, this is a starting framework, not a locked-in final list.

## Business priority: low-end market access matters as much as reliability

Explicit owner priority, not a secondary concern: reliability is the main goal, but the low-end/budget market is what builds the name, the same way piso wifi itself succeeds by being accessible to small operators on tight budgets. The tiers below are built around that - genuinely cheap hardware is a first-class target, not an afterthought after recommending mini PCs.

## The honest baseline requirement (updated with real measured data)

rj-pisowifi/ZenWiFi needs a real, general-purpose Linux computer to run on - not a purpose-built embedded router chip. But the actual footprint is smaller than first estimated:

- **RAM, measured**: the running app's actual memory use is **~60-64MB idle** (measured directly, not guessed - Working Set 60.4MB / Private 64.0MB for the live Node.js process). That's well below the earlier "1GB comfortable" estimate. A 512MB device leaves comfortable headroom for the app plus a minimal Linux OS; even 256MB total is plausibly workable for a light-duty single-lane deployment, though real testing under actual customer load (multiple concurrent sessions, SSE connections, SQLite writes) is needed before committing to that number publicly - idle memory isn't the same as memory under real traffic.
- **Storage**: a few GB free is plenty (the app itself is small; real growth is session/financial log history over time)
- **CPU**: any x86_64 or ARM64/ARMv7 - Node.js doesn't care about architecture, just needs a real one, not a router SoC purpose-built to be minimal
- **OS**: Ubuntu is what's tested/documented today; any modern Debian-based Linux would very likely work with minor `install.sh` adjustments, untested

**Next real step, not just a bigger guess:** test on actual constrained Linux hardware (a memory-limited VM or container, capped at 256MB/512MB) under realistic concurrent load, to get production-representative numbers before any of this goes on a marketing page. This still rules out cheap consumer OpenWrt-flashable routers (128-256MB *total*, shared with the router's own real-time WiFi/routing job, not just the app) - see "Explicitly Not Supported" below - but it opens up a genuinely cheap, dedicated-single-purpose device tier that the earlier draft of this plan underestimated.

## Tier 1 — Highly Recommended (best price/performance for a dedicated box)

- **Mini PCs** (Intel N100-class or similar, widely available under $150): Beelink, GMKtec, and similar budget mini PC brands, or a basic Intel NUC. Far more power than this app needs, silent, low power draw, easy to source. This is the most practical "buy this and go" recommendation for a new deployment.

## Tier 2 — Fully Supported (single-board computers, if adequate RAM)

- **Raspberry Pi 4 or 5** (2GB RAM minimum, 4GB+ recommended) - widely available, excellent ARM64 Linux support, well-documented community.
- **Orange Pi 3B/4/5-class boards** (1GB+ RAM models) - cheaper alternative to Raspberry Pi with comparable capability at this RAM tier. (Distinct from the Orange Pi One used in FastFi's build, which is a smaller, GPIO-coin-slot-focused board with less RAM - not the same recommendation.)

## Tier 3 — Broad Compatibility (repurposed / secondhand hardware)

- **Any old laptop or desktop with Ubuntu installed** - genuinely the most common real-world setup for a small shop starting out (this is literally what's running the live field test tonight). Zero extra hardware cost if one's already sitting unused - the actual cheapest option there is.
- **Secondhand thin-client boxes** (small corporate VDI terminals, very cheap on the secondhand market, more than enough CPU/RAM for this workload once reflashed with a normal Linux distro).

## Tier 4 — Ultra-Budget (new, dedicated hardware under ~$30) - pending real load testing

Enabled by the measured ~60MB idle footprint above, this is a genuinely new tier the earlier draft of this plan missed by assuming a much heavier baseline. Not yet ready to market until tested under real concurrent customer load, but worth actively pursuing given how directly it serves the low-end-market priority:

- **Orange Pi Zero 2/3, Raspberry Pi Zero 2 W, and similar sub-$30 ARM boards** (512MB-1GB RAM) - the app's own footprint should fit comfortably; the open question is real-world headroom once actual sessions, SSE connections, and SQLite writes are happening concurrently under load, not just sitting idle.
- **Action item before listing these anywhere public:** run the app on one of these (or an equivalently memory-limited VM/container as a stand-in) with several simulated concurrent customer sessions active, and watch real memory/CPU behavior over time, not just at startup - idle numbers alone aren't enough to promise reliability on hardware this constrained.

## For router mode specifically: separate hardware, separate list

Router mode needs a MikroTik device alongside the server box (two separate pieces of hardware, unlike FastFi's all-in-one router builds). Worth its own short recommended-router list once this section gets built out - the models already field-tested tonight (hEX/hEX S class) are the natural starting point, expanding to hAP-series and others as more get tested.

## Explicitly NOT supported (and why - real constraint, not a gap to close)

- **Cheap consumer OpenWrt-flashable routers** (the class of hardware FastFi's router builds target - Comfast N5, Newifi D2, Ruijie EW1200G Pro, generic OpenWrt devices). Typically 128-256MB total RAM on a low-power embedded SoC that also has to do the actual WiFi/routing job at the same time. Node.js's runtime overhead (V8 engine + a loaded Express app) can eat 50-150MB+ RAM on its own - doesn't fit alongside a router doing its real job on that class of hardware. This is exactly why FastFi is written in Lua for those specific builds, not a heavier language - a real technical constraint, not an oversight to "just fix." That hardware category stays FastFi's lane, not ZenWiFi's.
- **Very low-RAM SBCs** (Raspberry Pi Zero, older Pi models under 1GB RAM, Orange Pi Zero/Lite-class boards) - same underlying reason, insufficient RAM for comfortable Node.js operation.

## One real exception worth tracking, not promising yet

Newer MikroTik hardware running RouterOS 7+ supports actual Docker-style containers directly on the router. On specific, more capable MikroTik models (not the low-end ones), it's theoretically possible to run a lightweight Node.js container directly on the router itself - collapsing this app onto the same box as the router, closer to FastFi's all-in-one model but on MikroTik hardware instead of OpenWrt. Not verified this project's actual footprint would fit comfortably even there, and only applies to specific RouterOS 7+ models - worth testing later as a possible "all-in-one on MikroTik" tier, not something to list as supported until actually tried.
