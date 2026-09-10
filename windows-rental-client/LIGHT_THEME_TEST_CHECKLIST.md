# Light Gaming Theme - Manual Test Checklist

Run the published exe on real Windows hardware and confirm each of these.
This machine's build could not be visually verified (no Windows display
available where it was built) - report anything that looks wrong.

- [ ] Fresh install (delete `%ProgramData%\StarkFiRental\preferences.json`
      if it exists, or run on a PC that's never run this app) - the app
      starts in the new light theme by default, not the old dark one.
- [ ] Lock Screen: Guest card is filled green with white, readable text.
      Member Login card is white/outlined with a visible gray border and
      dark, readable text (not invisible/white-on-white).
- [ ] Lock Screen: café name heading and status footer text are dark and
      readable against the light background.
- [ ] Insert Coins (Guest): all text (title, running credit total, Done,
      Cancel) is visible and readable - none of it should be invisible
      white-on-white.
- [ ] Create Account: same coin-insert screen, same check.
- [ ] Café Home top bar: remaining time, member badge (if logged in as a
      member), and points are all readable.
- [ ] Home page: the featured-game carousel's title text is readable
      against its card background.
- [ ] My Session page: time remaining and Logout button are readable.
- [ ] Rewards page: points balance and Claim buttons are readable.
- [ ] Settings > General > Theme: dropdown shows all three options (Dark,
      Neon Purple, Light Gaming); switching between them live re-colors
      the open Settings page and other visible screens without needing a
      restart; selecting each one and clicking Save actually persists
      (reopen Settings to confirm the dropdown still shows your pick).
- [ ] Switch to Dark or Neon Purple, confirm the Guest/Member cards on the
      Lock Screen still look exactly as they did before this change (both
      filled, no unexpected outline) - this change should not have altered
      those two themes' appearance.
