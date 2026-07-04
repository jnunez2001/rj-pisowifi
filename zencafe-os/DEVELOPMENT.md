# ZenCafe OS - Development Roadmap

## Phase Overview

This is the **client-side OS only** - no backend server code. The OS runs on each gaming PC and communicates with a separate ZenCafe server backend.

## Development Phases (From Proposal)

### Phase 1: Foundation (Weeks 1-4)
- [ ] Project setup and build environment
- [ ] Windows API research and prototyping
- [ ] Configuration system design
- [ ] Process monitoring framework

### Phase 2: Custom Shell & Boot (Weeks 7-9)
- [ ] Custom Windows shell replacement
- [ ] Kiosk mode (hide desktop, taskbar)
- [ ] Boot splash screen
- [ ] Graceful shutdown handler

### Phase 3: Lockdown Mechanism (Weeks 7-9)
- [ ] Registry hardening scripts
- [ ] Keyboard hook implementation
- [ ] Process whitelist enforcement
- [ ] Group Policy optimization

### Phase 4: Game Launcher (Weeks 7-9)
- [ ] Game discovery and whitelisting
- [ ] Process launching with isolation
- [ ] Process monitoring and termination
- [ ] Auto-lock on timeout

### Phase 5: Watchdog & Monitoring (Weeks 10-12)
- [ ] System watchdog service
- [ ] Crash detection and recovery
- [ ] Health check monitoring
- [ ] Auto-restart on failure

### Phase 6: Configuration Management (Ongoing)
- [ ] Config file format design
- [ ] Server-side config sync
- [ ] Local caching
- [ ] Validation and error handling

### Phase 7: Testing & Hardening (Weeks 21-22)
- [ ] Unit tests for components
- [ ] Integration testing
- [ ] Security testing (lockdown escapes)
- [ ] Performance benchmarking
- [ ] Stress testing under load

## Technology Stack

```
Language: C++17
Framework: Qt6.7 (desktop framework for Windows)
Build System: CMake
OS Target: Windows 10/11
Architecture: x86-64

Key Libraries:
- Windows API (direct OS calls for lockdown)
- Qt Core/GUI (UI and windowing)
- SQLite (local cache, config storage)
- OpenSSL (certificate validation)
```

## Key Components

1. **Shell** - Custom Windows shell replacement
2. **Launcher** - Game launcher and process control
3. **Lockdown** - Registry hardening and escape prevention
4. **Monitor** - Watchdog and crash recovery
5. **Config** - Configuration management
6. **API** - Communication with server (stub for now)

## Next Steps

1. Create architecture design documents in `/docs/architecture/`
2. Design boot sequence flow
3. Plan Windows API usage
4. Create build environment setup guide
5. Create test plan document

---

**Note:** This is **client-side only**. Backend server (ZenCafe server for sessions, games, analytics) is separate.
