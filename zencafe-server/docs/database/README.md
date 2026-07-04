# ZenCafe Backend Database Design

## PostgreSQL Schema

### Documents to Create

- `schema-design.md` - Core tables and relationships
- `users-table.md` - Cafe owners, staff, players
- `cafes-table.md` - Locations, settings, configuration
- `sessions-table.md` - Gaming sessions, time tracking, billing
- `games-table.md` - Game library, metadata
- `cosmetics-table.md` - Cosmetic items and inventory
- `transactions-table.md` - Payments, purchases, revenue
- `audit-log-table.md` - Compliance and change tracking
- `indexes-and-optimization.md` - Performance tuning
- `backup-and-recovery.md` - Data protection strategy

## Key Design Principles

1. **ACID Guarantees** - Financial transactions must not fail
2. **Normalization** - Reduce data duplication
3. **Audit Trail** - Every change is traceable
4. **Encryption** - Sensitive data (passwords, tokens) encrypted
5. **Performance** - Proper indexes on frequently queried columns

## Core Tables Overview

```
users
  ├─ id (PK)
  ├─ email (unique)
  ├─ password_hash
  ├─ role (owner, staff, player)
  ├─ created_at

cafes
  ├─ id (PK)
  ├─ owner_id (FK → users)
  ├─ name
  ├─ location
  ├─ settings (JSON)
  ├─ created_at

pcs
  ├─ id (PK)
  ├─ cafe_id (FK → cafes)
  ├─ pc_name
  ├─ specs (CPU, RAM, GPU)
  ├─ status (online, offline, maintenance)

sessions
  ├─ id (PK)
  ├─ pc_id (FK → pcs)
  ├─ player_id (FK → users)
  ├─ game_id (FK → games)
  ├─ started_at
  ├─ ended_at
  ├─ total_minutes
  ├─ amount_paid

games
  ├─ id (PK)
  ├─ title
  ├─ description
  ├─ metadata (JSON)

cosmetics
  ├─ id (PK)
  ├─ designer_id (FK → users)
  ├─ name
  ├─ type (skin, theme, profile)
  ├─ price
  ├─ sales

transactions
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ type (session_billing, cosmetic_purchase, designer_payout)
  ├─ amount
  ├─ description
  ├─ created_at

audit_log
  ├─ id (PK)
  ├─ user_id (FK → users)
  ├─ action (create, update, delete)
  ├─ table_name
  ├─ record_id
  ├─ old_value (JSON)
  ├─ new_value (JSON)
  ├─ timestamp
```

## Migration Strategy

Migrations stored in `/migrations/` with naming:
```
001_initial_schema.sql
002_add_cosmetics_table.sql
003_add_audit_logging.sql
```

Each migration is:
- Forward (apply changes)
- Backward (rollback changes)
- Idempotent (safe to run multiple times)
