# R&J PisoWifi — Anti-Piracy & Code Protection Plan (DRAFT, awaiting approval)

Status: **planning only — nothing in this document is built yet.**
Companion to `ROUTER_MODE_PLAN.md`, split out separately since this covers how the *product itself* is protected and distributed, not the router-mode feature.

---

## 1. Threat model — what's actually being defended against

Two different things get called "copying our system," and they need different defenses. Getting this distinction right matters, because one of them is legitimately preventable and one isn't:

1. **Literal copying** — someone takes the actual running code/config and redeploys it as their own product, or clones a purchased unit and resells copies. **This is preventable, to a meaningful degree**, and is what this document is about.
2. **Learning from it** — someone studies how a working system behaves (coin slot → captive portal → session timer, the general architecture) and builds their *own* independent implementation inspired by it. **This is not preventable, and isn't theft** — it's normal competition. This exact project began by studying a competitor's (LPB's) shipped system to learn patterns (`PISOWIFI_REFERENCE_NOTES.md`). If that was fair game going one direction, the same category of thing will always be fair game coming back. No technical measure here should try to stop general concept-learning — only literal code/config copying gets real defense.

---

## 2. Decision: three tiers of protection

### Tier 1 — non-negotiable, build these
- **Compile to bytecode before shipping; never distribute readable `.js` source to devices in the field.** Node.js normally runs plain-text source directly — today, anyone with device access can open any `.js` file and read the real logic. Compiling to V8 bytecode (e.g. via `bytenode`) turns "open a text editor" into "need real reverse-engineering tools and skill." Standard for every release, not optional.
- **License key bound to a specific device's hardware ID**, not a password that works anywhere. Without this, one purchase becomes unlimited free installs — the bare-image approach below doesn't hold up without it.
- **Bare-image + authenticated first-boot download**, gated by that hardware-bound key. The image shipped/flashed is minimal; the real application only downloads after the key validates against that specific device. Stops the simplest attack (clone an SD card / VM image, sell copies) before it starts. Note: the protection here comes entirely from the license check gating the download — an unauthenticated download would defeat the whole point.

### Tier 2 — strongly recommended, moderate effort
- **Obfuscate before compiling** (scramble names/control flow) as a second layer under the bytecode compilation — defense in depth, not a replacement for Tier 1.
- **Watermark each licensed copy** with something unique baked into its compiled output. Doesn't stop extraction, but gives a way to establish provenance if a suspiciously similar product turns up elsewhere.
- **Keep license validation server-side** (a check against a server under the operator's control), even though the core coin/session gating logic must stay local for offline reliability (established requirement throughout `ROUTER_MODE_PLAN.md` — the system has to keep working through bad/no internet). Splits "what must work offline" from "what should never be fully exposed to the customer."

### Tier 3 — not code, but a real security plan always includes this
- **A proprietary license/terms of use the customer agrees to**, explicitly prohibiting reverse engineering, redistribution, and using the system as the basis for a competing product. Technical measures raise the *cost* of copying; legal terms make it *actionable* even against someone who gets past the technical layer. This is the piece most easily skipped by a small team — shouldn't be skipped here.

### Explicitly not pursuing
Any attempt to stop people from learning the *general approach* by studying a working unit. Not achievable, and effort spent chasing it would be better spent on Tier 1. Protect the code and the config; accept the concept itself was always learnable by anyone willing to study a working system.

---

## 3. Distribution format — what to actually ship

**Important: the container format itself is not a security decision.** OVA, IMG, ISO — none of these are "vaults." Any of them can be mounted and inspected with common, freely available tools by anyone who has the file. The real protection is what's *inside* (Tier 1 above — bytecode-compiled, no readable source, license-gated download). The format choice is about **matching how each target deployment actually runs**, not about which one is "more protected."

Given the two real deployment paths already established in `ROUTER_MODE_PLAN.md`:

- **IMG (raw disk image)** — for headless single-board computers (Orange Pi and similar), flashed directly to SD card/eMMC. This is the natural fit for the primary target hardware, and matches the bare-image-downloads-on-first-boot flow above.
- **ISO** — for a **dedicated mini PC** bought specifically to run this system and nothing else. No existing OS to preserve, no other workload competing for the hardware, so a bare-metal install (boot from USB, install straight onto the mini PC's own drive) is simpler and more efficient than adding VM overhead for no reason. This is its own real, distinct case — not a lesser alternative to OVA.
- **OVA (packaged VM appliance)** — for a PC/laptop that's *also* doing something else, or where multiple isolated systems genuinely need to share one machine (the operator's own current setup: WiFi rental and PC rental as two separate VMs on one laptop). VM overhead earns its keep here because isolation is the actual point.
- **EXE** — doesn't fit. The core system depends on Linux-specific tooling (`nft`, `tc`, `iptables`, `systemd`) that a native Windows executable can't provide without a fundamentally different rewrite of the network-control layer. Not pursued.

**Recommendation: support all three — IMG, ISO, and OVA.** Each matches a genuinely different real deployment situation (headless SBC / dedicated mini PC / shared PC needing multiple isolated systems), not three options competing for the same use case. All three are built on the same Tier 1/2 protected internals — not three different security postures, just three containers around the same protected core.

---

## 4. Still open

- **License validation mechanism**: offline key vs. online check-in vs. hybrid (see `ROUTER_MODE_PLAN.md` §6 for the original tradeoff breakdown) — a business-model decision for the user, not decided here.
- Everything else in this document is a decided technical direction, not an open question.
