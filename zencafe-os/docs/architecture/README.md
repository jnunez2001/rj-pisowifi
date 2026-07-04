# ZenCafe OS Architecture

## Documents to Create

- `system-overview.md` - High-level system design
- `component-diagram.md` - Visual architecture of OS components
- `kiosk-shell.md` - Custom shell architecture
- `game-launcher.md` - Game launcher design
- `lockdown-mechanism.md` - Registry hardening & lockdown flow
- `process-monitor.md` - Watchdog and process monitoring
- `config-system.md` - Configuration management
- `boot-sequence.md` - OS boot and initialization flow
- `communication-protocol.md` - API communication with server

## Key Principles

1. **Zero Trust** - Assume all user input is malicious
2. **Fail-Safe Lockdown** - If anything breaks, system stays locked
3. **Process Isolation** - Games run in restricted containers
4. **Watchdog Protection** - Automatic recovery from crashes
5. **Server Sync** - All critical decisions verified with server
