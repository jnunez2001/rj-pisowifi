# StarkFi Café Client Installer

A minimal WiX Toolset v5 installer for `windows-rental-client` - four
screens only (Welcome, Install Location, Progress, Finish), matching
the V1.0.0 Client Installation Wizard spec exactly. Everything café-
specific (server address, PC registration) is handled by the client
EXE's own first-run setup after install, not by this installer.

## What this is NOT

Unlike `windows-rental-client` itself (which cross-compiles cleanly
from this Mac via `dotnet build`), **the WiX Toolset only supports
Windows** - it says so itself with an explicit warning on every run.
Confirmed directly: `wix build` against this project's real `Package.wxs`
exits with code 0 and produces no error, but also produces no `.msi` -
silent, undefined failure, exactly what that warning describes. A
simpler synthetic test `.wxs` (unrelated to this project) does still
surface real schema errors from the same machine, so the core tool
runs here in a limited way, but the actual MSI-writing step does not
work on macOS. This `Package.wxs` has been written carefully and
reviewed, but **it has never actually been compiled or run** - you'll
need to build it on real Windows to verify it, then report back what
you see so anything that needs fixing can get fixed from there.

**Recommended path: let CI build it.** `.github/workflows/build-
rental-client-installer.yml` builds the client + this installer on a
real (free, GitHub-hosted) Windows runner on every push, and uploads
the `.msi` as a downloadable build artifact - nobody needs their own
Windows machine just to get a working installer out of a code change.
Trigger it manually from the repo's Actions tab ("Build Café Client +
Installer" > Run workflow) any time, or it fires automatically on a
push touching either project.

## What's deliberately NOT in this installer

Per the spec this was scoped from, the installer should answer exactly
one question ("install the Café Client on this PC?") and nothing else:

- No server IP / PC registration / coin acceptor / pricing / guest or
  member settings / points / games / banners / branding / shell /
  security / admin settings - all of that lives in the Café Client EXE
  itself (first-run setup, `Program.cs`) or the admin panel, never here.
- No License Agreement dialog - skipped via two `<Publish>` overrides
  in `Package.wxs` (a standard, documented WiX customization, not a
  hack) so Welcome goes straight to the install-location picker.
- No Start Menu shortcut checkbox - the mockup this was built from
  explicitly says "No complicated options" under that screen, so the
  shortcut is just always created rather than making it a toggle.
- No "Installing Café Service" step - that component doesn't exist
  yet (the Local Café Service/watchdog was explicitly deferred to a
  later phase when Café Home was scoped). Add that step here once that
  project is actually built, not before.

## Manual build (only if you'd rather not use CI)

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download) and
the WiX v5 tool, on a real Windows machine:

```
dotnet tool install --global wix --version 5.0.2
wix extension add WixToolset.UI.wixext/5.0.2
wix extension add WixToolset.Util.wixext/5.0.2
```

**Before building the installer**, publish the client it packages
(from `windows-rental-client/`, see that project's own README):

```
cd ..\windows-rental-client
dotnet publish -c Release -r win-x64
```

Then build the installer itself:

```
cd ..\windows-rental-client-installer
dotnet build -c Release
```

Output lands in `bin\Release\en-US\StarkFiCafeClientSetup.msi`.

## Install location

Installs directly to `C:\CaféClient\` (not under `Program Files`),
matching the mockup's own stated default path exactly.

## Versioning

Bump `ProductVersion` in `StarkFiClientInstaller.wixproj` on any
installer-relevant change (new files added to the package, new
shortcuts) - this is independent of the client EXE's own
`FIRMWARE_VERSION`-equivalent versioning, they track different things.
