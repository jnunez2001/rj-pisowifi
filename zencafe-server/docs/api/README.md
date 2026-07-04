# ZenCafe Backend API Documentation

## API Overview

RESTful API + WebSocket for real-time updates. All endpoints require JWT authentication (except /auth).

## Documents to Create

- `authentication.md` - JWT token generation, refresh, validation
- `sessions-api.md` - Start, pause, stop gaming sessions
- `games-api.md` - Game library, whitelist management, updates
- `users-api.md` - User registration, profile, login
- `analytics-api.md` - Revenue reports, player stats, usage metrics
- `cafes-api.md` - Multi-location management, cafe settings
- `cosmetics-api.md` - Marketplace items, purchases, designer uploads
- `websocket-protocol.md` - Real-time events and updates
- `error-codes.md` - HTTP status codes and error messages
- `rate-limiting.md` - API usage limits and quotas

## API Base URL

```
Development:  http://localhost:3000/api
Production:   https://api.zencafe.io/api
```

## Authentication

All endpoints except `/auth/*` require:
```
Authorization: Bearer <jwt_token>
```

## Content Type

All endpoints accept and return JSON:
```
Content-Type: application/json
```
