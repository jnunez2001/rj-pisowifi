# Server Hardware Requirements

Covers the **server role only** — the machine running PostgreSQL + the backend service at each café (or the optional cloud aggregation hub). This is a separate question from the customer-facing gaming PCs, which are covered in `zencafe-os/docs/setup/system-requirements.md` — those need real gaming specs dictated by whatever games the café offers, not by our software.

Written because many Philippine PC cafés run on low-spec, older hardware (Windows 10/11, modest RAM), and the "server" is sometimes a repurposed old PC or a cheap single-board computer, not a proper rack server.

---

## Recommended Specs

| | Minimum (it'll run) | Recommended (comfortable) |
|---|---|---|
| CPU | Any dual-core (even an old Celeron/Pentium) | Any modern budget quad-core |
| RAM | 4GB | 8GB |
| Storage | A few GB free, SSD strongly preferred | SSD |
| OS | Windows 10/11, or Linux | **Linux** (lighter footprint than Windows for a headless service — same hardware goes further) |

## Single-Board Computers (e.g., Orange Pi)

A café wanting to minimize hardware cost by using a cheap board like Orange Pi instead of a full PC:

- **1GB RAM is NOT recommended for production** — technically PostgreSQL can start with that little, but it has to share it with the Linux OS and our server program simultaneously. Fine for testing, risky for a real café where several PCs might log in and start spending credit at the same moment (e.g., opening-time rush) — real risk of slowdowns or crashes under genuine concurrent load, not just a theoretical concern.
- **Minimum recommended: 2GB RAM** — comfortable for a small café, roughly up to 15-20 PCs.
- **4GB+ RAM** for anything larger.
- Run Linux on these boards (which is what they normally ship with anyway), not Windows.

## PostgreSQL Tuning for Low-Spec Hardware

PostgreSQL's *default* configuration is generic/conservative for a general-purpose server, not a strict requirement — it's commonly run successfully on modest hardware (even Raspberry Pi-class devices) for small workloads. A single café's database only needs to handle a handful to a few dozen PCs' worth of session/wallet updates — a tiny workload by database standards. Recommended `postgresql.conf` adjustments for a low-spec deployment:

- `shared_buffers` — cap around 64-128MB (default assumes much more available RAM)
- `max_connections` — lower to ~20-30 (a small café doesn't need PostgreSQL's default of 100)
- `work_mem` — reduce from default, since concurrent query complexity is low for this workload

## Server Binary Footprint (C++/Qt)

The backend server is headless (no GUI) — it should only link **Qt Core, Network, and Sql** modules, not Qt Widgets/GUI, which are unnecessary for a service and would otherwise inflate the binary's memory footprint for no benefit. This is a build-configuration note for whoever sets up `CMakeLists.txt` for `zencafe-server` when service code development begins.

## Decision Trail

This reconsiders (without reversing) the `docs/deployment/cloud-stack.md` decision to self-host PostgreSQL both locally and in the cloud — the original company proposal had actually planned SQLite for local café storage specifically because it's lighter (no background service, embedded). That was overridden in favor of PostgreSQL everywhere for consistency and full control over financial/compliance data.

**Re-litigated when the low-spec hardware reality was raised directly, and PostgreSQL was kept** — rewriting all 13 already-verified migrations for SQLite (which lacks the `EXCLUDE` constraint used for double-booking prevention, native UUID/JSONB types, and has different trigger syntax) was judged not worth it when PostgreSQL can be tuned to run comfortably on the hardware actually being discussed (2GB+ RAM), avoiding a costly rework of already-tested work.
