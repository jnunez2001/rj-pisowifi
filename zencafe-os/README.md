# ZenCafe OS - Structure & Purpose

Custom Windows-based PC café operating system with kiosk mode, game launcher, and hardened lockdown.

## Folder Structure

### `/src` - Source Code (No Backend Server)
- **`shell/`** - Custom Windows shell replacement (kiosk UI, boot screen)
- **`launcher/`** - Game launcher with whitelisting and process control
- **`lockdown/`** - Registry hardening, keyboard hooks, system lockdown
- **`monitor/`** - Watchdog, process monitoring, auto-restart on crash
- **`config/`** - Configuration management and validation

### `/resources` - Static Assets
- **`icons/`** - Application icons, UI elements
- **`themes/`** - UI theme files, color schemes
- **`assets/`** - Images, sounds, branding

### `/scripts` - Deployment & Maintenance
- **`install/`** - Windows installation scripts, registry patches
- **`deploy/`** - Deployment automation scripts
- **`maintenance/`** - Monitoring, cleanup, log rotation

### `/docs` - Documentation
- **`architecture/`** - System design, component diagrams
- **`setup/`** - Installation and configuration guides
- **`deployment/`** - Deployment procedures, hardware setup
- **`api/`** - OS API documentation (for server communication)
- **`troubleshooting/`** - Common issues and solutions

### `/tests` - Testing
- **`unit/`** - Unit tests for individual components
- **`integration/`** - Integration tests between components
- **`e2e/`** - End-to-end tests (boot → game → logout flow)

### `/config` - Configuration Files
- **`registry/`** - Windows registry hardening configs
- **`group-policy/`** - GPO templates for lockdown
- **`firewall/`** - Windows Firewall rules

---

## Development Focus
This OS is **client-side only** - no backend server. It communicates with the ZenCafe server via REST/WebSocket API.

**Next Step:** Create architecture documentation and design documents in `/docs/architecture/`
