# ZenCafe Enterprise - Complete System Proposal

**Status:** Design Phase → Ready for Development  
**Target:** Commercial PC Cafe Management Platform  
**Scope:** PanCafe Pro + Cloud + Windows Lockdown + Anti-Fraud  
**MVP Timeline:** 16 weeks (4 months)  
**Commercial Timeline:** 24 weeks (6 months) + launch

**Tagline:** *"PanCafe Pro features + Cloud control + Unbreakable Windows lockdown + Zero fraud + Multi-location scalability"*

---

## Executive Summary

**What ZenCafe Enterprise Does:**
- Manages PC time rental (billing, sessions, pricing tiers)
- Integrates POS (snacks, drinks, services sold with PC time)
- Enforces time via unbreakable Windows lockdown (kiosk mode)
- Controls everything from cloud dashboard (screenshot, reboot, lock, monitor)
- Prevents customer/staff fraud via audit logs and server-authoritative sessions
- Runs offline (local mode) but syncs to cloud when available
- Scales from 4 PCs to 100+ locations

**Key Advantages Over PanCafe Pro:**
1. **Cloud-based** (not just local) → remote control across multiple locations
2. **Harder to cheat** → server-authoritative time, client just displays
3. **Better windows lockdown** → uses Windows Assigned Access (Microsoft official kiosk mode)
4. **Offline-first** → works even if internet is down (syncs when back online)
5. **Optional bandwidth control** → per-PC bandwidth management (via router, not mandatory)
6. **Audit everything** → every staff action logged, nothing hidden from owner

---

## Part 1: System Architecture

### Overview Diagram

```
                           ISP / Internet
                                ↓
                          ┌──────────────┐
                          │   ROUTER     │ ← Single gateway for entire network
                          └──────┬───────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
        ┌──────────────┐  ┌──────────────┐  ┌────────────┐
        │ ZenCafe      │  │ PC Clients   │  │ WiFi AP    │
        │ Server       │  │              │  │            │
        │ (Management) │  │ PC1 (Gaming) │  │ (Guest WiFi)
        │              │  │ PC2 (General)│  │            │
        │ API, DB,     │  │ PC3 (General)│  │ For public/
        │ Remote RPC   │  │ PC4 (General)│  │ staff WiFi │
        └──────────────┘  └──────────────┘  └────────────┘
                │
        ┌──────────────┐
        │ Cashier      │
        │ Terminal     │
        │ (iPad/Tab)   │
        └──────────────┘

        ↑ All devices on SAME subnet
        ↑ Router manages WiFi + internet
        ↑ ZenCafe manages sessions (not internet)
        ↑ Optional: Local cache server (same network)
```

**Network Architecture:**
- **ISP → Router:** All internet comes from router (the hub)
- **Router → All Devices:** PCs, ZenCafe server, WiFi AP, cashier terminal all connected to router
- **WiFi Management:** Router handles WiFi (not ZenCafe)
- **ZenCafe Role:** Session management, billing, POS, remote control (NOT internet gateway)
- **Bandwidth Control (Optional):** Can be configured on router if supported, or via ZenCafe API calling router/switch APIs

### Component Breakdown

| Component | Purpose | Technology | Status |
|-----------|---------|-----------|--------|
| **API Server** | Session, POS, billing, RPC | Node.js + Express | New |
| **Database** | Transactions, audit logs, customers | PostgreSQL (cloud) + SQLite (local) | New |
| **Admin Dashboard** | Remote control, monitoring, reports | React/Vue + WebSocket | New |
| **Client Agent** | PC time enforcement, lockdown | Electron + Windows API | New |
| **POS Terminal** | Snacks + PC billing | React/Next.js or web app | New |
| **Network Layer** | Optional bandwidth control (router API or local shaping) | Router QoS OR tc HTB | Optional |
| **Local Server** | Offline mode, sync | Node.js (lightweight) | Optional |

---

## Part 2: Detailed System Components

### A. Cloud API Server

**Responsibilities:**
- Session CRUD (create, pause, resume, end)
- Time server (authoritative countdown timer)
- POS transactions
- Staff authentication & audit logging
- Remote PC control (RPC)
- Reporting & analytics
- User/customer management

**Key Features:**
```
POST   /api/session/start            ← PC rents time (cashier action)
GET    /api/session/:id/time         ← Client polls for remaining time
POST   /api/session/:id/pause        ← Owner pauses session
POST   /api/session/:id/end          ← Session expires or manually ended
GET    /api/pc/:id/status            ← Get PC status (screenshot, CPU, RAM)
POST   /api/pc/:id/control           ← Remote: lock/reboot/shutdown
POST   /api/pos/transaction          ← Log snack purchase
GET    /api/audit-log                ← Full audit trail for owner
GET    /api/reports/daily            ← Revenue, utilization, peak hours
```

**Server-Authoritative Time:**
```
Client does NOT control time.
Flow:
1. Cashier: "Rent PC1 for 2 hours"
2. Server: Creates session, timer starts ON SERVER
3. Client (PC1): Every 1 second, polls: "How much time left?"
4. Server: Returns remaining_time (calculated server-side)
5. Client: Displays timer countdown
6. When time = 0, Server tells client: "LOCK NOW"
7. Client: Forces logout, no escape possible (time is law, enforced server-side)
```

**Database Schema (Core Tables):**
```sql
-- Users & Staff
users (id, name, role, password_hash, cafe_id, created_at)
  - Roles: owner, cashier, manager, technician
  
-- PCs
pcs (id, name, mac_address, ip_address, cafe_id, status, 
     pc_type, specs_cpu, specs_ram, specs_gpu, location)
  - Status: online, offline, locked, maintenance
  - Types: gaming, general, editing, streaming

-- Sessions (core billing)
sessions (id, pc_id, voucher_code, minutes_total, minutes_remaining,
         status, started_at, expires_at, paused_at, customer_name, cafe_id)
  - Status: active, paused, ended, expired
  - Server calculates remaining_time on every request

-- POS (snacks/drinks)
pos_items (id, name, category, price, cafe_id)
pos_transactions (id, session_id, item_id, quantity, amount, cafe_id, created_at)

-- Rates
rates (id, duration_minutes, price, label, cafe_id, pc_type)
  - Allows different pricing per PC type (gaming ₱25/hr, general ₱10/hr)

-- Staff Audit Log (CRITICAL for fraud prevention)
audit_log (id, user_id, action, details, before_value, after_value, 
          timestamp, cafe_id, ip_address)
  - EVERY staff action logged: discount given, time added, session cancelled
  - Immutable (owner reviews, not editable)
  - Example: "cashier_john extended_session:PC1 +30min no_payment reason:customer_complaint"

-- Customers
customers (id, name, phone, email, balance, discount_tier, cafe_id, created_at)
  - Prepaid balance system
  - Loyalty discounts tracked
```

---

### B. Client Agent (Windows Lockdown)

**Runs on each PC, enforces time without being bypassable.**

**Installation Flow:**
```
1. Owner installs ZenCafe Client on each PC
2. Client registers PC with cloud (sends MAC, IP, specs)
3. Owner configures PC type (gaming/general) in dashboard
4. Client applies Windows Assigned Access kiosk mode
5. Reboot → customer sees ONLY ZenCafe portal
6. No desktop, no taskbar, no escape
```

**Core Functions:**
```javascript
// Every second, client polls server for time
setInterval(() => {
  fetch(`/api/session/${session_id}/time`)
    .then(res => res.json())
    .then(data => {
      display_timer(data.minutes_remaining);
      if (data.minutes_remaining <= 0) {
        force_logout();  // No negotiation, no UI, instant lockout
        block_internet(); // Kill network access too
      }
    });
}, 1000);

// Windows Lockdown (via Assigned Access / kiosk mode)
// - No Windows key, no Alt+Tab, no Task Manager
// - No access to Settings, Control Panel, File Explorer
// - Only ZenCafe portal runs
// - Replace explorer.exe with ZenCafe app as shell
```

**Anti-Bypass Measures:**
```
1. Replace Shell (HKLM\Winlogon\Shell = C:\ZenCafe\client.exe)
   → User literally can't get to desktop
   
2. Disable Ctrl+Alt+Del (registry: DisableTaskMgr, Ctrl+Alt+Del options)
   → No Task Manager
   
3. Disable Win key (Scancode Map registry)
   → Can't open Start menu
   
4. No Command Prompt / PowerShell (DisableCMD = 2)
   → Can't run commands
   
5. No File Explorer (NoFolderOptions, RestrictRun whitelist)
   → Can't access files
   
6. USB read-only (GPO: removable storage policies)
   → Can't copy files to USB, can charge phone only
   
7. Disk rollback on logout (Deep Freeze or VirtualBox differencing disk)
   → Even if someone finds a bypass, it's wiped at logout
   
8. Watchdog process (client monitors itself)
   → If client crashes, relaunch it automatically
   → If Windows process tries to kill it, log it and restart
```

**Portal on Client:**
```
┌─────────────────────────────┐
│  🖥️ ZenCafe PC Rental       │
├─────────────────────────────┤
│                             │
│  Time Remaining: 01:47:32   │  ← Server-authoritative countdown
│                             │
│  [Pause Session]  [End]     │  ← Owner/cashier controls from cloud
│                             │
│  Bandwidth: 5 Mbps ↓        │  ← Shaped by WiFi system
│  CPU: 45% | RAM: 62%        │  ← Monitored by client
│                             │
│  [Open Browser]             │  ← Only allowed apps
│  [Word/Excel]               │
│  [Games]                    │
│                             │
└─────────────────────────────┘
```

**Security Hardening (Windows 10/11 Pro):**
```
Use Windows 10/11 Pro's built-in "Assigned Access" (kiosk mode):
Settings → Accounts → Other users → Set up a kiosk or public PC
  → Create limited account → Assign ZenCafe app as shell
  → Reboot → No desktop, no escape

Backup (if Assigned Access unavailable):
  → Manual registry lockdown + Group Policy
  → Apply on logon via startup script
  → Belt-and-suspenders: re-apply policies every 30 seconds
```

---

### C. Admin Dashboard (Cloud Control)

**Real-time view of all PCs + remote control.**

**Features:**
```
1. PC STATUS GRID
   ┌──────────────────────────────────┐
   │ PC1 [Gaming]   │ PC2 [General]   │
   │ STATUS: LOCKED │ STATUS: ONLINE  │
   │ USER: John     │ USER: Maria     │
   │ TIME: 01:23:45 │ TIME: 00:45:20  │
   │ [Screenshot]   │ [Screenshot]    │
   │ CPU: 67%       │ CPU: 23%        │
   │ [Lock] [Reboot]│ [Lock] [Reboot] │
   └──────────────────────────────────┘

2. QUICK ACTIONS
   - Lock PC (force logout, no warning)
   - Reboot PC
   - Shutdown PC
   - Broadcast message ("Closing in 5 mins")
   - Take screenshot
   - Live monitor (watch what customer is doing)

3. REVENUE DASHBOARD
   - Today's revenue (PCs + POS combined)
   - Revenue per PC, per hour
   - Peak hours chart
   - Staff sales tracking

4. STAFF AUDIT LOG
   - Every action by cashier logged:
     "john_cashier: extended PC1 +30min, no payment, 14:23"
     "maria_manager: gave discount -₱50 to customer_id:123, 10:15"
     "john_cashier: started session PC3, 08:00"
   - Immutable (owner only, can't be deleted)
   - Exportable for accounting

5. CUSTOMER PROFILES
   - Name, phone, balance
   - Session history
   - Loyalty discount tier
   - Blacklist (banned customers)

6. RATE MANAGEMENT
   - Gaming PC: ₱25/1hr
   - General PC: ₱10/1hr
   - Edit anytime, applies to next session

7. REPORTS (Daily, Weekly, Monthly)
   - Revenue breakdown
   - Utilization (hours PC was rented vs. available)
   - Peak hours
   - Top customers
   - Staff performance
   - POS sales
```

**Live Screenshot Feature (Anti-Cheating):**
```
Owner can take screenshot of PC1 anytime:
  [Screenshot] button → see exactly what customer is viewing
  
This proves:
  - Customer is actually at PC (or staff gave them free time)
  - What they're doing (gaming vs. "studying")
  - If they're bypassing restrictions somehow (evidence)
```

---

### D. POS (Point of Sale)

**Integrated with session billing.**

**System:**
```
Cashier Terminal (iPad/Windows tablet/kiosk)

[Session Start]
  → PC1 selected
  → Duration: 1 hour (₱10)
  → Customer inserts coin
  → Add snacks? [Yes] [No]
     If yes: Show menu
       [Soft drink ₱25] [Chips ₱15] [Candy ₱10]
     → Select items → Add to bill
  
  → TOTAL BILL: ₱50 (₱10 PC + ₱25 drink + ₱15 chips)
  
  [Confirm Payment]
  
Server:
  → Creates session (PC1, 1 hour)
  → Creates POS transaction (snacks)
  → Single audit log entry: "session_started PC1 1hr+snacks ₱50"
  → Time starts counting DOWN on client
```

**Anti-Fraud (POS):**
```
- Cashier can't give discount without logging reason
  "Give discount ₱50?" → Requires reason dropdown:
    □ customer_complaint
    □ loyalty_reward
    □ system_error
    □ other (owner must review)
  
- Every discount logged with cashier name + timestamp
  Owner can audit: "Maria gave ₱50 discount at 14:23 (customer_complaint)"

- No "free time" without audit trail
  Cashier can't just add time, must log it
  
- Sales match sessions
  Owner can verify: "5 PC sessions today = ₱50 in session revenue"
  "2 snacks sold = ₱40 in POS revenue"
  "Total = ₱90"
```

---

### E. Network Integration (Optional Bandwidth Control)

**Bandwidth management is OPTIONAL and router-centric.**

**Architecture:**
```
DEFAULT (No bandwidth control):
  ISP → Router → PC gets full internet speed
  ZenCafe server manages sessions only (not internet path)
  
OPTIONAL (With bandwidth control):
  ISP → Router (supports API for QoS/traffic shaping)
         ↓
  ZenCafe detects router type, calls API:
    "Router, limit MAC aa:bb:cc:dd:ee:ff to 5 Mbps"
  Router applies shaping (not ZenCafe)
  
  OR: Use Linux bridge on ZenCafe server (if PCs use server as gateway)
    Then: ZenCafe applies tc HTB shaping
    (Your existing bandwidth control system)
```

**Implementation (Choose One):**

**Option A: Router with QoS API (Recommended)**
```
- Modern routers: MikroTik, Ubiquiti, Cisco
- ZenCafe calls router API: "Limit this MAC to 5 Mbps"
- No changes to network topology
- Cleaner, no single point of failure
```

**Option B: Local bandwidth shaping (Your existing)**
```
- If router doesn't support API, use your tc HTB system
- ZenCafe server becomes bandwidth enforcer
- Trade-off: ZenCafe can't be bypassed, but requires server involvement
```

**Option C: No bandwidth control (Simplest)**
```
- Router manages internet, ZenCafe manages sessions
- All PCs get full internet speed
- Staff controls via paid time (not bandwidth)
- Good for general-use cafes
```

**Decision:** Start with Option A or C. Add bandwidth control later if needed.

---

## Part 3: Implementation Roadmap

### Phase 1: MVP (Weeks 1-8) — Basic System

**Goal:** Get 4 PCs running with session control + POS + audit logs.

**Week 1-2: Foundation**
- [ ] Backend API (Node.js/Express) scaffolding
- [ ] PostgreSQL schema (users, pcs, sessions, pos, audit_log)
- [ ] Authentication (JWT)
- [ ] Session CRUD endpoints

**Week 2-3: Client Agent**
- [ ] Windows Assigned Access configuration
- [ ] Client app skeleton (Electron/Node)
- [ ] Time polling loop (every 1 second)
- [ ] Kiosk mode verification

**Week 3-4: Dashboard**
- [ ] Admin web portal (React)
- [ ] PC status grid (online/offline/locked)
- [ ] Session start/pause/end
- [ ] Audit log viewer

**Week 4-5: POS**
- [ ] POS items (snacks, drinks)
- [ ] Transaction logging
- [ ] Receipt generation

**Week 5-6: Network Integration**
- [ ] Connect to WiFi bandwidth shaper
- [ ] Test bandwidth capping per PC

**Week 6-8: Testing & Hardening**
- [ ] Real PC testing (your 4 machines)
- [ ] Windows lockdown stress test
- [ ] Network tests (offline mode, sync)
- [ ] Security audit

**Deliverable:** ZenCafe running on your 4 PCs with full audit trail and remote control.

### Phase 2: Hardening & Scale (Weeks 9-16) — Production Ready

**Week 9-10: Security Hardening**
- [ ] Disk rollback (Deep Freeze or VirtualBox)
- [ ] Client watchdog (auto-restart if killed)
- [ ] Enhanced audit logging
- [ ] Staff permission tiers (owner, manager, cashier)

**Week 10-11: Cloud Sync**
- [ ] Local server (lightweight cache)
- [ ] Offline mode (works without internet)
- [ ] Sync protocol (push/pull when back online)
- [ ] Conflict resolution

**Week 11-12: Multi-Location Support**
- [ ] Cafe ID in all tables
- [ ] Multi-cafe dashboard
- [ ] Per-cafe configuration (rates, users, PCs)
- [ ] API multi-tenancy

**Week 12-14: Advanced Features**
- [ ] Remote screenshot feature
- [ ] Customer profiles & loyalty system
- [ ] Detailed reporting (daily, weekly, monthly)
- [ ] Staff performance tracking
- [ ] Promo/discount system

**Week 14-16: QA & Launch Prep**
- [ ] Full load testing
- [ ] Security penetration testing
- [ ] Documentation
- [ ] Training materials for franchisees

**Deliverable:** ZenCafe Enterprise production-ready for multi-location deployment.

---

## Part 4: Tech Stack (Optimized for Scale & Security)

| Layer | Technology | Why |
|-------|-----------|-----|
| **Backend API** | Node.js + Express | Fast, async, good for real-time (WebSocket for live updates) |
| **Database** | PostgreSQL (cloud) + SQLite (local cache) | PostgreSQL: scalable, ACID. SQLite: offline sync capability |
| **Admin Dashboard** | React + TypeScript | Type-safe, component reusability, SEO-friendly with Next.js |
| **Client Agent** | Electron + Node.js | Cross-platform (Windows/Linux/Mac eventually), full OS control access |
| **POS Terminal** | React web app (responsive) | Works on iPad, Android tablet, or dedicated Windows kiosk |
| **Real-time comms** | WebSocket (Socket.io) | Push time updates, remote control, live screenshot streaming |
| **Security** | JWT auth, HTTPS/TLS, bcrypt | Standard, proven |
| **Deployment** | Docker + Kubernetes (cloud) | Scalable, auto-failover, multi-region ready |
| **Network** | Your existing tc HTB + nftables | No changes needed, just integrate via API calls |

---

## Part 5: Development Estimates

| Component | Effort | Notes |
|-----------|--------|-------|
| Backend API (core) | 80 hours | Sessions, POS, RPC, auth |
| Database design & migration | 20 hours | Schema, indexes, backup strategy |
| Client Agent (Windows) | 60 hours | Lockdown, time polling, watchdog |
| Admin Dashboard | 80 hours | Grid, real-time updates, reports |
| POS Terminal | 40 hours | Simple, just transaction logging |
| Network integration | 20 hours | API calls to bandwidth shaper |
| Testing & hardening | 60 hours | Security, offline mode, sync |
| Documentation | 20 hours | API docs, user guides, deployment |
| **TOTAL MVP (Phase 1)** | **~300 hours** | **~8 weeks, 1 developer** |
| **TOTAL v1.0 (Phase 2)** | **~200 hours** | **+5 weeks, includes scale + security** |

---

## Part 6: Security Model

### Threat & Mitigation

| Threat | Mitigation |
|--------|-----------|
| Customer bypasses time limit | Server-authoritative time (client can't override), Windows lockdown prevents escape |
| Staff extends session without payment | Audit log (every action logged), staff tiers (cashier can't override manager) |
| Staff steals cash + erases log | Audit log is immutable (stored server-side, cryptographically signed) |
| Customer accesses admin UI | Assigned Access kiosk mode (no access to anything except app) |
| PC compromised (malware/exploit) | Disk rollback on logout (session changes wiped), client validates time with server |
| Internet down | Local server caches sessions, syncs when back online |
| API compromised | HTTPS/TLS enforced, JWT auth, rate limiting per staff account |

---

## Part 7: Deployment Plan

### For Your Cafe (4 PCs)

```
1. Hardware Setup
   - 4 PCs (any decent Windows 10/11 Pro)
   - Local server (optional: cheap NUC or Raspberry Pi for caching)
   - Cloud account (AWS/Azure/Heroku for backend)
   - Cashier terminal (iPad or Windows tablet)

2. Software Installation
   - Backend deployed to cloud
   - Client agent installed on each PC
   - Admin dashboard (web browser, your laptop)
   - POS app on cashier terminal

3. Network Configuration
   - PCs on WiFi (or ethernet)
   - Bandwidth shaping enabled
   - Local sync server configured (optional)

4. Owner Onboarding
   - Set PC types (gaming, general)
   - Configure rates
   - Create staff accounts (your name, cashiers)
   - Test full flow

5. Go Live
   - First day: owner monitors everything
   - Second day: cashiers use system
   - Week 1: tweak rates/policies based on usage
```

### For Franchising (Multiple Locations)

```
1. Setup Per Cafe
   - Cloud dashboard for all locations (one URL)
   - Each cafe registers (ID, name, location, language)
   - Each cafe gets local sync server (optional)
   - PCs provisioned per cafe

2. Remote Management
   - Owner logs in, sees all cafes on one dashboard
   - Can drill down: all cafes → select cafe → PC details
   - Remote control works across all locations

3. Franchisee Onboarding
   - Franchisee gets cashier-level account (can't see other cafes)
   - Headquarters gets owner account (sees everything)
   - Training video + manual

4. Reporting
   - HQ sees: total revenue, utilization, top-performing cafes
   - Franchisee sees: their cafe only
```

---

## Part 8: Cost Breakdown (Estimated)

| Item | Cost | Notes |
|------|------|-------|
| **Development (300 hrs)** | $6,000-12,000 | Depends on developer rate ($20-40/hr) |
| **Cloud hosting** | $50-200/month | AWS/Azure (scales with locations) |
| **Windows licenses** | $0 | Windows 10/11 Pro already on PCs |
| **Electron packaging** | $0 | Free, open source |
| **Database** | $10-50/month | PostgreSQL managed service |
| **Hardware (local server)** | $300 | One-time, optional |
| **SSL cert** | $0-20/year | Free via Let's Encrypt |
| **Total setup** | **$6,360-12,270** | One-time dev + first year ops |
| **Per-month ops** | **$60-250/month** | Scales with locations |

---

## Part 9: Go-to-Market Strategy

### Year 1: Validate & Perfect (Your Cafe)
```
Months 1-4: Build MVP
Months 5-6: Run on your 4 PCs, perfect based on real usage
Months 7-9: Add franchisee-ready features (multi-location, scaling)
Months 10-12: Document, train, prepare for first franchisee
```

### Year 2: First Franchisee
```
Onboard 1 strategic franchisee (test multi-location)
Monitor, collect feedback, iterate
Document playbook (how to set up ZenCafe in a new cafe)
```

### Year 3+: Scale
```
Target 10-50 cafes using ZenCafe
Revenue model:
  - License per cafe (₱5,000-10,000/year)
  - OR transaction fee (1-2% of revenue)
  - OR hybrid
```

---

## Part 10: Quick-Reference Checklist

### MVP Completion (Phase 1)
- [ ] Backend API with session CRUD
- [ ] Client agent with Windows lockdown & time polling
- [ ] Admin dashboard with PC status + remote control
- [ ] POS integration with snacks
- [ ] Audit log (immutable)
- [ ] Network integration (bandwidth cap per PC)
- [ ] Tested on your 4 PCs
- [ ] Offline mode (local server optional)

### Production Ready (Phase 2)
- [ ] Multi-location support
- [ ] Disk rollback (Deep Freeze)
- [ ] Client watchdog
- [ ] Staff permission tiers
- [ ] Customer loyalty system
- [ ] Advanced reporting
- [ ] Security hardening (penetration tested)
- [ ] Documentation & training materials

---

## Part 11: Key Success Factors

1. **Server-Authoritative Time** — Client can never override time limit. This is the core security model.
2. **Immutable Audit Log** — Every staff action logged, signed, stored server-side. No tampering possible.
3. **Windows Lockdown** — Use Microsoft's Assigned Access (kiosk mode). Don't invent your own (too fragile).
4. **Offline-First Architecture** — Works without internet (local cache), syncs when online.
5. **Multi-Location Ready** — Build for scaling from day 1 (don't refactor cafe_id into every table later).

---

## Final Summary

**ZenCafe Enterprise is:**
- ✅ PanCafe Pro features (session, POS, pricing, vouchers)
- ✅ Cloud-based control (multi-location, remote management)
- ✅ Unbreakable Windows lockdown (customer can't escape)
- ✅ Zero fraud (server-authoritative, immutable audit log)
- ✅ Network-agnostic (router manages internet, ZenCafe manages sessions)
- ✅ Optional bandwidth control (add later if needed)
- ✅ Offline-capable (sync when internet back)
- ✅ Scalable (10-50+ cafes as product)

**Development Path:**
- Weeks 1-8: MVP (your 4 PCs)
- Weeks 9-16: Production (multi-location, scale)
- Year 2+: Franchising product

**Investment:** $6K-12K development + $50-250/month ops

---

**Ready to build ZenCafe Enterprise?** Next step: Confirm tech stack, hire developer (or use me as technical architect), and start Phase 1 sprint.

---

**Questions for refinement:**
1. Cloud provider preference? (AWS, Azure, Google Cloud, or self-hosted?)
2. Development timeline? (16 weeks doable, or need faster?)
3. Team? (Solo developer, outsource, hire local?)
4. WiFi integration urgency? (Can be separate from core MVP)

**This document is your development blueprint.** Hand it to a developer, they can start Phase 1 immediately.
