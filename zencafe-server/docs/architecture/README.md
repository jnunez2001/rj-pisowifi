# ZenCafe Backend Architecture

## System Design & Components

### Documents to Create

- `overview.md` - High-level system diagram and components
- `data-flow.md` - How data flows through the system
- `service-architecture.md` - Service-oriented design (Sessions, Games, Analytics, etc)
- `scaling-strategy.md` - How to scale for 100+, 1000+ concurrent users
- `offline-sync.md` - OS offline support and data reconciliation
- `websocket-design.md` - Real-time update architecture
- `database-design.md` - Schema relationships and query optimization
- `security-model.md` - Authentication, authorization, encryption
- `disaster-recovery.md` - Backup strategy and failover

## Key Architectural Patterns

1. **Microservices-lite** - Separate services (sessions, games, analytics) but shared database
2. **Event-driven** - Key events trigger notifications to OS clients
3. **Offline-first sync** - OS clients work offline, sync on reconnect
4. **Audit trail** - Every write operation is logged
5. **Stateless API** - Any server instance can handle any request

## Component Diagram

```
Load Balancer (nginx/HAProxy)
    ↓
API Server (C++/Qt)
├── Session Service (timers, billing)
├── Game Service (library, whitelist)
├── Auth Service (JWT, validation)
├── Analytics Service (metrics, reports)
├── Cosmetics Service (marketplace)
└── Admin Service (dashboard API)
    ↓
PostgreSQL Database (ACID guarantees)
    ↓
Redis Cache (optional, for performance)
```

## Communication Protocols

```
OS Client ←→ Server: REST + WebSocket
Web Dashboard ←→ Server: REST + WebSocket
Server ←→ Database: PostgreSQL protocol
```
