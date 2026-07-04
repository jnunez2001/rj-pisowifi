# ZenCafe Backend Server

Central server managing PC cafes: sessions, games, users, payments, analytics, and multi-location support.

## Folder Structure

### `/src` - Backend Source Code

**API Layer:**
- **`api/`** - REST + WebSocket endpoints for OS clients and admin dashboard

**Core Services:**
- **`sessions/`** - PC session management (start, pause, stop, time tracking)
- **`games/`** - Game library, whitelisting, cosmetics marketplace
- **`auth/`** - Authentication, JWT tokens, session validation
- **`database/`** - Database models, queries, migrations
- **`analytics/`** - Revenue tracking, player stats, usage metrics
- **`billing/`** - Payment processing, invoicing, subscriptions
- **`admin/`** - Admin dashboard API, multi-location management

### `/migrations` - Database Schema
- Migration scripts for PostgreSQL
- Schema versioning and rollback procedures

### `/scripts` - Deployment & Maintenance
- **`db/`** - Database setup, backup, restore scripts
- **`deploy/`** - Deployment automation, Docker configs

### `/docs` - Documentation
- **`api/`** - REST API reference, WebSocket protocol
- **`architecture/`** - System design, data flow, scaling
- **`database/`** - Schema design, relationships, indexes
- **`deployment/`** - Deployment guides, DevOps procedures

### `/tests` - Testing
- **`unit/`** - Unit tests for individual functions
- **`integration/`** - Integration tests between services
- **`api/`** - API endpoint tests, load testing

### `/config` - Configuration Files
- Database connection strings
- API keys and secrets (production overrides)
- Feature flags
- Environment-specific settings

---

## Technology Stack

```
Language: C++17 + Qt6.7
Framework: Qt for networking and concurrency
Database: PostgreSQL (primary) / SQLite (fallback)
API: REST (HTTP/HTTPS) + WebSocket (real-time)
Auth: JWT tokens
Caching: Redis (optional, for performance)
Message Queue: (optional, for async jobs)
```

## Key Responsibilities

1. **Session Management** - Track PC rental time, pricing, payments
2. **Game Management** - Maintain game whitelist, push updates to OS clients
3. **User Accounts** - Manage cafe owner accounts, player profiles, login
4. **Multi-Location** - Support multiple cafes under one account
5. **Analytics** - Track revenue, player activity, system performance
6. **Cosmetics Marketplace** - Handle designer uploads, customer purchases, revenue sharing
7. **Real-time Sync** - Push updates to OS clients (game changes, config updates)
8. **Offline Support** - OS works offline, server syncs when back online

## Development Focus

This is the **server-side backend**. It provides APIs for:
- ZenCafe OS clients (PC lockdown OS)
- Admin dashboard (web UI for cafe owners)
- Potential future mobile apps

## Next Steps

1. Create architecture and API design documents in `/docs/`
2. Design database schema
3. Plan API endpoints (session lifecycle, game management, etc)
4. Create environment setup guide
