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

## First run

Launch the exe. It'll ask for the server address once (e.g.
`http://10.50.0.1:3000`), then registers itself with the server as a
new, unapproved rental PC - **you still need to adopt it** from the
admin panel's PC Rental > Manage PC page before it'll ever unlock,
same as any new vendo device. Its config (server URL, device secret)
is saved to `%ProgramData%\StarkFiRental\config.json`.

## Running it every time Windows starts

Simplest: put a shortcut to the exe in
`shell:startup` (Win+R, type `shell:startup`, drop a shortcut in).
That's enough for testing.

## Making it survive Alt+F4 / Task Manager / a normal reboot into a real lock kiosk

The startup-folder approach above is easy to bypass (close the app,
it's gone). A real kiosk deployment needs the app to run as the literal
Windows **shell**, replacing `explorer.exe`, so there's no normal
desktop to fall back to at all. This is a genuinely consequential
system change - do it deliberately, not as a default:

1. Open Registry Editor (`regedit`) as Administrator.
2. Go to
   `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`
3. Set the `Shell` value to the full path of
   `StarkFiRentalClient.exe`.
4. Reboot to test.

**To revert** (get the normal desktop back): change `Shell` back to
`explorer.exe` in the same registry key, or boot into Safe Mode and
edit it there if the machine is unusable otherwise.

## The one thing this app genuinely cannot block: Ctrl+Alt+Del

Windows reserves Ctrl+Alt+Del as its own Secure Attention Sequence - by
design, no application (this one included) can intercept it. A
customer pressing it still reaches the real Windows security screen. Two
real mitigations, both deliberate operator setup steps, not something
this app applies for you:

- The shell-replacement above changes what's actually reachable *from*
  that screen (no normal desktop to switch to).
- A Group Policy / Software Restriction Policy on the machine can
  further lock down what's launchable at all.

## What's built vs deferred

Built: full lock/unlock enforcement (Alt+Tab/Win key/Ctrl+Esc blocked
while locked), branded lock screen (logo/wallpaper/announcement from
admin), member login/logout with live time drain, staff override
(local fail-safe, doesn't touch server-side credit), a countdown widget
while unlocked.

Deferred (see the main plan): per-PC coin acceptor (credit is still
admin/shared-box only), PC performance stats reporting, remote screen
spectate.
