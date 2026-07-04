# ZenCafe Backend Server - Development Roadmap

## Overview

Central backend server that manages all cafe operations, player accounts, games, payments, and analytics. Designed to be **scalable, reliable, and offline-tolerant**.

## Architecture Principles

1. **Stateless API** - Any server instance can handle any request
2. **Database as source of truth** - All state persisted immediately
3. **Offline-first** - OS clients work offline, sync when online
4. **Audit trail** - All transactions logged for compliance
5. **Real-time updates** - WebSocket for pushing config/game changes to clients

## Development Phases (From Proposal)

### Phase 1: Foundation (Weeks 1-4) ⭐ START HERE
- [ ] Project setup and build environment
- [ ] PostgreSQL database schema design
- [ ] Core API server scaffolding (Express/Flask equivalent in C++)
- [ ] Authentication system (JWT tokens)
- [ ] Database connection pooling
- [ ] Logging and monitoring framework

**Deliverable:** Server running on port 3000, basic health check endpoint

### Phase 2: Session Management (Weeks 5-6)
- [ ] Session start/stop/pause API endpoints
- [ ] Time tracking and billing logic
- [ ] Payment processing integration
- [ ] Real-time session monitoring

**Deliverable:** OS clients can start gaming sessions, track time, record billing

### Phase 3: Game Management (Weeks 7-9)
- [ ] Game library API
- [ ] Whitelist management
- [ ] Push game updates to OS clients
- [ ] Game launcher configuration

**Deliverable:** Push game whitelist to OS, OS receives and validates

### Phase 4: Multi-Location Support (Weeks 10-12)
- [ ] Cafe hierarchy (owner → locations → PCs)
- [ ] Location-specific configurations
- [ ] Staff role management
- [ ] Data isolation per location

**Deliverable:** One owner can manage multiple cafes

### Phase 5: Analytics & Reporting (Weeks 13-14)
- [ ] Revenue tracking and reporting
- [ ] Player activity analytics
- [ ] PC utilization metrics
- [ ] Export to CSV/PDF

**Deliverable:** Owner can see dashboard with revenue, active sessions, etc

### Phase 6: Cosmetics Marketplace (Weeks 15-18)
- [ ] Designer upload system
- [ ] Customer storefront
- [ ] Purchase and inventory tracking
- [ ] Revenue sharing calculations

**Deliverable:** Players can buy cosmetics, designers can upload

### Phase 7: Admin Dashboard API (Weeks 19-20)
- [ ] All admin endpoints for web UI
- [ ] Real-time WebSocket updates
- [ ] Batch operations (multiple PC control)

**Deliverable:** Web dashboard can manage all aspects of cafe

### Phase 8: Integration & Security (Weeks 21-22)
- [ ] End-to-end encryption for sensitive data
- [ ] Rate limiting and DDoS protection
- [ ] API key management
- [ ] Audit logging

**Deliverable:** Production-ready security

---

## Core API Endpoints (Planned)

### Sessions
```
POST   /api/sessions           - Start new session
GET    /api/sessions/:id       - Get session details
PATCH  /api/sessions/:id       - Pause/resume session
DELETE /api/sessions/:id       - End session
GET    /api/sessions           - List active sessions
```

### Games
```
GET    /api/games              - List all games
GET    /api/games/:id          - Game details
POST   /api/games/whitelist    - Update PC whitelist
GET    /api/pcs/:id/whitelist  - Get PC's whitelisted games
```

### Users & Auth
```
POST   /api/auth/login         - Authenticate user
POST   /api/auth/register      - Register new account
POST   /api/auth/refresh       - Refresh JWT token
GET    /api/users/:id          - Get user profile
```

### Analytics
```
GET    /api/analytics/revenue  - Revenue by time period
GET    /api/analytics/sessions - Session history
GET    /api/analytics/players  - Player activity stats
```

### Multi-Location
```
GET    /api/cafes              - List user's cafes
POST   /api/cafes              - Create new cafe
GET    /api/cafes/:id          - Cafe details
GET    /api/cafes/:id/pcs      - List PCs at location
```

---

## Database Schema (Outline)

### Core Tables
```
users               - Cafe owners, staff
cafes               - Physical cafe locations
pcs                 - Gaming PCs at each location
games               - Game library
sessions            - Active/historical sessions
cosmetics           - Cosmetic items marketplace
transactions        - Payment history, cosmetics sales
```

### Supporting Tables
```
roles               - Staff permissions
audit_log           - All changes for compliance
settings            - Configuration per cafe
game_whitelist      - Which games on which PCs
```

---

## Data Flow Example: Start Gaming Session

```
1. OS Client → Server: POST /api/sessions
   { pc_id, player_id, game_id, requested_duration }

2. Server:
   - Validate authentication
   - Check PC is available
   - Check player account has balance/time
   - Create session record in DB
   - Start billing timer

3. Server → OS Client: 200 OK + session_token

4. OS Client: Launch game with session_token

5. OS Client → Server (WebSocket): Every 10s with session_token
   Server verifies token, updates session_end_time

6. Player stops game or time runs out:
   OS Client → Server: DELETE /api/sessions/:id
   
7. Server: Calculate total time, calculate billing, record transaction
```

---

## Technology Decisions

### Why C++17 + Qt6.7?
- **Consistency** - Same stack as OS client, easier cross-team communication
- **Performance** - Critical for handling 100+ concurrent sessions
- **Qt Networking** - Built-in WebSocket, HTTP, TLS support
- **Portable** - Runs on Linux, Windows, macOS for flexibility

### Why PostgreSQL?
- **ACID guarantees** - Money-related transactions must not fail
- **Scalability** - Handles thousands of concurrent connections
- **Replication** - Data redundancy for reliability
- **JSON support** - For flexible configuration storage

### Why JWT for Auth?
- **Stateless** - Each server instance can verify without database
- **Mobile-friendly** - Works for future mobile app
- **Expiration** - Tokens automatically invalidate

---

## First Task: Create Database Schema

Before coding, we need:
1. Design core tables (users, cafes, pcs, sessions, games, transactions)
2. Plan relationships and indexes
3. Create migration script template
4. Document data model

See: `/docs/database/schema-design.md` (to be created)
