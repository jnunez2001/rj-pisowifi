# ZenCafe OS — System Requirements

Covers the **customer-facing gaming PCs** — a different question from the server hardware, covered in `zencafe-server/docs/deployment/hardware-requirements.md`. Written now, ahead of actual OS development, because many Philippine PC cafés run low-spec, older Windows machines, and this should shape design decisions from the start rather than get discovered as a problem later.

---

## The Games Decide the PC Specs, Not Our Software

The actual hardware a café needs is dictated by whichever games they choose to offer — that's true regardless of what ZenCafe OS is built with. A café offering only lighter esports titles (CS2, Dota 2, League of Legends, Valorant) can run on more modest gaming PCs than one offering demanding AAA titles. This is a business decision for each café owner, not something ZenCafe OS controls or should try to control.

## What ZenCafe OS Itself Must Do: Stay Out of the Way

**Design principle for whoever builds this:** the OS software (kiosk shell, game launcher, lockdown/registry hardening, watchdog) runs *alongside* whatever game the customer is playing. Every MB of RAM and every % of CPU our own software uses is resources taken away from the actual game — on a low-spec PC, that difference is much more noticeable than on a high-end one.

Concrete guidance for development:
- **Minimize background footprint** — the watchdog/monitor and lockdown enforcement should be lightweight, event-driven where possible rather than constantly polling
- **No unnecessary GUI overhead** — avoid heavy animations, effects, or unnecessary Qt Widgets usage in the kiosk shell; it should render fast and then get out of the way once a game launches
- **Target: total OS overhead well under what a single low-end game needs** — a rough goal to validate once real builds exist, not a hard number decided in the abstract

## Absolute Floor for the OS Software Itself (Separate From Game Requirements)

If we ignore what any specific game needs and just ask "what's the minimum for our OS software alone to run acceptably":

| | Minimum |
|---|---|
| CPU | Any dual-core |
| RAM | 4GB (though any real gaming PC will exceed this because of the games themselves) |
| OS | **Windows 10 must be a first-class supported target, not just Windows 11** |

**Why Windows 10 support matters specifically:** Windows 11 has stricter hardware requirements (TPM 2.0, Secure Boot, newer CPU generations) that exclude a meaningful number of older machines from being upgradeable at all. Since low-spec, older hardware is common in the target market, requiring Windows 11 would lock out real customers. ZenCafe OS should be built and tested against Windows 10 from day one, not treated as an afterthought or dropped later for convenience.

## Open Question for Later (Not Blocking Now)

- [ ] Once real OS builds exist, measure actual RAM/CPU footprint on representative low-spec hardware and revise this doc with real numbers instead of design intentions
