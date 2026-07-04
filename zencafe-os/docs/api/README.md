# ZenCafe OS API Documentation

## Communication with ZenCafe Server

The OS communicates with the backend server via REST + WebSocket for:
- Session validation
- Game whitelisting
- Configuration updates
- Telemetry & crash reporting
- Revenue sync

## Documents to Create

- `session-api.md` - PC session start/stop/pause API
- `game-launcher-api.md` - Game launching and process control
- `config-sync-api.md` - Configuration synchronization
- `telemetry-api.md` - Session data and crash reporting
- `authentication.md` - How OS authenticates with server
- `offline-mode.md` - Behavior when server is unreachable
- `websocket-protocol.md` - Real-time communication protocol
- `error-codes.md` - System error codes and meanings
