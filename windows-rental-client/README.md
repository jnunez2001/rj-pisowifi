# StarkFi Rental Client

Windows app that locks a rental PC's desktop until it's credited (via
the admin panel's Add Time/Insert Coin, or a member logging in with
their own banked time). Talks to the same StarkFi server as the WiFi
side, over the `POST /api/rental/*` device-facing routes in
`server/routes/rental.js`.

## What this is NOT

This is source code, not a built app. It hasn't been compiled or run -
I don't have a Windows machine or .NET SDK to test it from here. You'll
need to build and test it on real Windows hardware, then tell me what
you see so I can fix anything that needs it.

## Build

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download) on
the Windows PC (or a Windows machine you build on and copy the result
to the rental PC).

```
cd windows-rental-client
dotnet build -c Release
```

Output lands in `bin\Release\net8.0-windows\StarkFiRentalClient.exe`.
Note: a plain `dotnet build` still produces a "framework-dependent" exe -
it needs the .NET 8 Desktop Runtime installed on whatever PC runs it.

## Publishing a single, self-contained .exe (for deploying to other PCs)

If you're setting up more than one rental PC, you don't want to install
the .NET SDK on every single one. Instead, build once on any Windows
machine with the SDK, then copy one file everywhere else:

```
cd windows-rental-client
dotnet publish -c Release -r win-x64
```

Output lands in
`bin\Release\net8.0-windows\win-x64\publish\StarkFiRentalClient.exe`.
This single file has the .NET runtime bundled inside it - copy just this
one exe to any other Windows 10/11 64-bit PC and run it directly, no
SDK or separate runtime install needed there. It'll be roughly
100-150MB (the runtime is baked in), which is normal for a
self-contained single-file publish.

## Installing (recommended path)

After publishing (previous section), run `install.bat` from the same
folder as the published `StarkFiRentalClient.exe` - **right-click, "Run
as administrator"** (it writes to `%ProgramFiles%` and a registry
policy, both need admin rights). It:

- Copies the exe to `%ProgramFiles%\StarkFiRental\`
- Adds a startup shortcut so it launches automatically at every login
- Disables Task Manager (`DisableTaskMgr` policy) so "End Task" isn't
  reachable even if someone gets to Ctrl+Alt+Del's screen

`uninstall.bat` (also run as administrator) reverses all of that -
removes the startup shortcut, re-enables Task Manager, removes the
installed files, and reverts shell replacement (below) back to
`explorer.exe` **only if** it's still pointed at this app, so it never
clobbers an unrelated customization.

## First run

Launch the exe (or let the startup shortcut do it). It first tries to
find the StarkFi server automatically on the local network - the same
broadcast discovery protocol ESP32 coin acceptors already use to find
it, no manual IP typing required on a normal network. If it can't find
one (different subnet, broadcast blocked, etc.) it falls back to asking
for the server address by hand (e.g. `http://10.50.0.1:3000`), pre-
filled with whatever it found so you can just press Enter to confirm or
type a different address.

It then registers itself with the server as a new, unapproved rental
PC - **you still need to adopt it** from the admin panel's PC Rental >
Manage PC page before it'll ever unlock, same as any new vendo device.
Its config (server URL, device secret) is saved to
`%ProgramData%\StarkFiRental\config.json`.

## Making it survive Alt+F4 / a normal reboot into a real lock kiosk

`install.bat` above covers startup + Task Manager, but the app can
still be closed via Alt+F4 or a plain reboot back to the normal
desktop. A real kiosk deployment needs the app to run as the literal
Windows **shell**, replacing `explorer.exe`, so there's no normal
desktop to fall back to at all. This is a genuinely consequential
system change - it's deliberately NOT part of `install.bat`, do it by
hand:

1. Open Registry Editor (`regedit`) as Administrator.
2. Go to
   `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`
3. Set the `Shell` value to the full path of
   `StarkFiRentalClient.exe` (e.g.
   `%ProgramFiles%\StarkFiRental\StarkFiRentalClient.exe` if installed
   via `install.bat`).
4. Reboot to test.

**To revert**: run `uninstall.bat` (it checks and reverts this
automatically if it's still pointed at this app), or change `Shell`
back to `explorer.exe` by hand in the same registry key, or boot into
Safe Mode and edit it there if the machine is unusable otherwise.

## The one thing this app genuinely cannot block: Ctrl+Alt+Del

Windows reserves Ctrl+Alt+Del as its own Secure Attention Sequence - by
design, no application (this one included) can intercept it. A
customer pressing it still reaches the real Windows security screen.
Real mitigations, all deliberate operator setup steps, not something
this app fully automates:

- `install.bat`'s Task Manager lock closes the most-reachable escape
  hatch from that screen ("End Task" won't work).
- The shell-replacement above changes what's actually reachable *from*
  that screen (no normal desktop to switch to).
- A Group Policy / Software Restriction Policy on the machine can
  further lock down what's launchable at all.

## Staff pause vs Staff override

The lock screen's "Staff" button (password-gated by the App Password
set in PC Rental > Settings) offers two different things:

- **Force Unlock** - a short, purely local unlock. Server-side credit
  is untouched, so the very next status poll (~5s) re-locks it unless
  real credit exists. Good for a quick peek/fix.
- **Pause** - suspends enforcement server-side (no lock screen, no
  member time drain) until explicitly resumed, either from the small
  "Resume" button this app shows while paused, or from the admin
  panel's Manage PC page (same underlying Lock/Unlock state). Good for
  real maintenance work on the PC.

## What's built vs deferred

Built: full lock/unlock enforcement (Alt+Tab/Win key/Ctrl+Esc blocked
while locked, Task Manager disabled via `install.bat`), branded lock
screen (logo/wallpaper/announcement from admin), member login/logout
with live time drain, staff override and staff pause, a countdown
widget while unlocked, automatic server discovery with manual fallback,
and install/uninstall scripts.

Deferred (see the main plan): per-PC coin acceptor (credit is still
admin/shared-box only), PC performance stats reporting, remote screen
spectate.
