# Update Strategy — OS Client & Server

Two independent update channels, since the risk profile is very different: a broken server update means a brief outage; a broken OS update on a locked-down kiosk PC means a customer physically can't use that machine until someone intervenes.

---

## 1. Server Updates (Backend)

**Flow:**
1. Code is built and packaged via **GitHub Actions** (already our CI/CD choice) into a versioned release
2. Binary is published to **GitHub Releases** (free, versioned, includes changelog)
3. Each location's local server (and the optional cloud hub) periodically checks for a new version
4. Update is downloaded, but **only applied during a low-traffic maintenance window** (e.g., 4-5 AM), not while active sessions/billing are running
5. **Health check after update** — if the new version fails to start correctly or fails a basic health check, automatically roll back to the previous version binary (kept on disk, not deleted immediately)

**Why this matters for a 24-hour café:** even at 4 AM, some cafés may have active sessions. The update process must check for zero active sessions before applying, or postpone to the next window automatically.

---

## 2. OS Client Updates (Kiosk PCs)

**Flow:**
1. Each café's **local server acts as the update distribution point** for its own PCs — individual gaming PCs don't reach out to the internet directly; they check with their own local server. This avoids dozens of PCs all hitting an external server at once, and keeps updates working even if that café's internet is briefly down (local server already has the update cached).
2. OS client polls its local server for a new version
3. **Never updates during an active session** — update only applies when the PC is idle (no player logged in) or during a scheduled maintenance window set by the café owner
4. **Auto-rollback on failure** — if the PC fails to boot correctly after an update, it automatically reverts to the last known-good version. A bricked kiosk PC directly costs the café owner revenue, so this is non-negotiable, not a nice-to-have.

---

## 3. Staged Rollout (Avoid Breaking Everything at Once)

Given the Phase 1 plan already in the roadmap ("deploy at your own café first, then beta cafés, then commercial"), updates follow the same philosophy:

- **Beta channel** — new updates go to your own café (and any opted-in beta café partners) first
- **Stable channel** — after a few days with no issues reported, the update promotes to all other cafés automatically
- Café owners can see (in the admin dashboard) which channel their branch is on, but cannot indefinitely block *critical security updates* — see open decision below

---

## Data Model Implications

```
server_versions
  ├─ version_number
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)

os_versions
  ├─ version_number
  ├─ release_notes
  ├─ channel (beta, stable)
  ├─ released_at
  ├─ is_critical_security_update (boolean)

cafes — addition
  ├─ update_channel (beta, stable)
  ├─ maintenance_window_start / maintenance_window_end (per branch, owner-configurable)

pcs — addition
  ├─ current_os_version
  ├─ last_update_check_at
  ├─ last_update_status (success, failed_rolled_back, pending)
```

---

## Version Policy (Decided)

Based on semantic versioning (`MAJOR.MINOR.PATCH`):

| Update type | Example | Owner can defer? | Enforcement |
|---|---|---|---|
| **Security patch** | any version, any time | **No — mandatory, no exceptions** | Applied automatically at the next low-traffic window, regardless of channel or owner preference |
| **PATCH** (e.g., 1.0.8 → 1.0.9) | bug fixes, small tweaks | **Yes, owner's choice** | If deferred, auto-applies anyway after a **60-day grace period** — prevents a café drifting indefinitely on an old, increasingly unsupported patch version |
| **MINOR** (e.g., 1.0.9 → 1.1.0) | new features, API-contract changes | **No — mandatory** | Applied within a **14-day grace period** (short notice window, not instant) — because the OS and server must speak the same API version; letting these drift risks broken session sync or billing communication between client and server |
| **MAJOR** (e.g., 1.x → 2.0) | breaking architecture changes | **No — mandatory** | Applied within a **30-day grace period** (longer notice, since major versions need more prep/testing) |

**Why minor/major aren't optional:** unlike a typical app, the OS client and server are two separate programs that must agree on how to talk to each other. If a café's OS stays on an old minor version while the server moves to a new one, features like session billing or curfew enforcement could silently break — this isn't just a "nice to have latest," it's a compatibility requirement.

**Version compatibility check:** the server should reject connections from an OS client whose version is too far behind (below a defined minimum-supported version), forcing the update rather than allowing a broken/mismatched pairing to run silently.

---

## Data Model Addition (Version Compatibility)

**Simplified during `013_localization_and_versioning`:** rather than a standalone `version_compatibility` table (which read like a per-pair matrix with no clean row-per-what meaning), each minimum requirement is just a column on the relevant version table — `server_versions.minimum_os_version_required` and `os_versions.minimum_server_version_required`. A compatibility check is really "does the other side's version meet my own stated minimum," which only needs one value per version row.

```
server_versions — addition
  ├─ minimum_os_version_required

os_versions — addition
  ├─ minimum_server_version_required
```
