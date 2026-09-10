using System.Drawing.Drawing2D;
using StarkFiRentalClient.UI;
using StarkFiRentalClient.Pages;

namespace StarkFiRentalClient;

// Café Home (mockup rebuild #2) - no longer a full-screen shell. The
// mockup this rebuild matches has no in-app desktop replacement at all:
// once unlocked, the customer sees their real Windows desktop normally,
// with only a small, draggable, always-on-top pill bar floating on top
// of it: "PC 04 | <timer> | ▼". Clicking the arrow expands a small
// dropdown menu (Add Time / User Settings / Admin Panel [members] /
// Log Out). There is no more sidebar, no more swappable content area,
// no more game/app catalog, and no more keyboard blocking - none of
// that exists in the mockup, and blocking input made sense only for a
// captive shell that no longer exists.
public class CafeHomeForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly ClientPreferences _prefs;

    // ---- The pill bar itself ----
    // Three segments in one 300x50 pill: PC name | timer | expand arrow.
    // Exact bounds (all children Top=0, Height=BarHeight, computed against
    // the 300-wide root panel, left to right with no gaps or overlaps):
    //   _pcNameLabel  Left=18,  Width=74   -> ends at 92
    //   _sep1 ("|")   Left=92,  Width=16   -> ends at 108
    //   _timeLabel    Left=108, Width=90   -> ends at 198
    //   _sep2 ("|")   Left=198, Width=16   -> ends at 214
    //   _expandButton Left=214, Width=68   -> ends at 282 (+18 right margin = 300, symmetric with the 18px left margin)
    private const int BarWidth = 300;
    private const int BarHeight = 50;

    private RoundedPanel _bar = null!;
    private Label _pcNameLabel = null!;
    private Label _timeLabel = null!;
    private Label _expandButton = null!;

    // ---- Dragging ----
    // MouseDown on the bar records the offset between the click point and
    // the Form's own Location; MouseMove (only while the button is held)
    // repositions the Form so that offset is preserved; MouseUp stops.
    // Position is clamped so at least 40px of the bar stays within
    // Screen.PrimaryScreen.WorkingArea on every side.
    private bool _dragging;
    private Point _dragOffset;
    private const int DragClampMargin = 40;

    // ---- Dropdown menu ----
    // A separate small borderless Form, built once and shown/hidden (never
    // recreated), positioned just below the bar's bottom-left corner and
    // clamped the same way the bar is. Default width 240; widens to 300
    // only while its content is swapped out for the Add Time coin panel
    // (see ShowAddTimeInMenu), then returns to 240 when that's dismissed.
    private const int MenuWidth = 240;
    private const int MenuItemHeight = 44;
    private const int MenuVPadding = 8;

    private Form _menuForm = null!;
    private Panel _menuList = null!;
    // Set whenever _menuForm.Deactivate closes the menu (see BuildMenu).
    // The arrow's own Click always fires just after a click-triggered
    // Deactivate on this Form, so without this guard ToggleMenu sees the
    // menu already closed and immediately reopens it - the arrow could
    // open the menu but never close it. A click within this window is
    // treated as "that deactivate already closed it", not a re-open.
    private DateTime _menuClosedByDeactivateAt = DateTime.MinValue;
    private static readonly TimeSpan MenuReopenSuppressWindow = TimeSpan.FromMilliseconds(250);
    private CardButton _addTimeItem = null!;
    private CardButton _settingsItem = null!;
    private CardButton _adminItem = null!;
    private CardButton _logoutItem = null!;
    private CoinInsertPanel? _menuCoinPanel;

    private bool _isMember;
    private string _pcName = "";

    // ---- Idle auto-logout / session-ending reminder ----
    // Restores behavior the old full-screen shell had via the same
    // IdleDetector class (still present, just no longer instantiated
    // anywhere after the bar/menu rebuild) and a CheckSessionReminder
    // method that was dropped entirely during that rewrite, even though
    // SettingsPage.cs still exposes both toggles ("Auto logout when
    // idle", "Remind me before my session ends") - silently doing nothing
    // is worse than not having the settings at all.
    private readonly IdleDetector _idleDetector = new();
    private bool _sessionReminderShown;

    public CafeHomeForm(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
    {
        _api = api;
        _config = config;
        _prefs = prefs;

        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = false;
        Width = BarWidth;
        Height = BarHeight;

        var workArea = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(workArea.Left + 16, workArea.Top + 16); // default corner: top-left, small margin

        // Without this, only RoundedPanel's own painted corners look
        // rounded - the Form itself stays a plain grey rectangle behind
        // them, visible wherever the panel's rounded corners don't cover.
        // Setting a matching rounded Region on the Form makes everything
        // outside the pill shape genuinely transparent to the desktop
        // underneath, not just visually covered by a themed color.
        ApplyRoundedRegion();
        Resize += (_, _) => ApplyRoundedRegion(); // the bar isn't expected to resize, but keep this correct if it ever does

        BuildBar();
        BuildMenu();

        _idleDetector.IdleTimeoutReached += async () => await OnIdleTimeoutAsync();

        // Same guard the old shell used - without this, Alt+F4 would
        // dispose this Form outright (not just hide it), and Program.cs's
        // cached reference would throw ObjectDisposedException on its very
        // next Show()/Hide() call, crashing the whole client.
        FormClosing += (_, e) => { if (Visible) e.Cancel = true; };

        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
        ApplyTheme();
    }

    private void BuildBar()
    {
        _bar = new RoundedPanel { Dock = DockStyle.Fill, CornerRadius = BarHeight / 2 };
        Controls.Add(_bar);

        _pcNameLabel = new Label { AutoSize = false, Left = 18, Top = 0, Width = 74, Height = BarHeight, TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoEllipsis = true };
        var sep1 = new Label { Text = "|", AutoSize = false, Left = 92, Top = 0, Width = 16, Height = BarHeight, TextAlign = ContentAlignment.MiddleCenter };
        _timeLabel = new Label { AutoSize = false, Left = 108, Top = 0, Width = 90, Height = BarHeight, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12, FontStyle.Bold) };
        var sep2 = new Label { Text = "|", AutoSize = false, Left = 198, Top = 0, Width = 16, Height = BarHeight, TextAlign = ContentAlignment.MiddleCenter };
        _expandButton = new Label { Text = "▼", AutoSize = false, Left = 214, Top = 0, Width = 68, Height = BarHeight, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 10, FontStyle.Bold), Cursor = Cursors.Hand };
        _expandButton.Click += (_, _) => ToggleMenu();

        _bar.Controls.Add(_pcNameLabel);
        _bar.Controls.Add(sep1);
        _bar.Controls.Add(_timeLabel);
        _bar.Controls.Add(sep2);
        _bar.Controls.Add(_expandButton);

        // Dragging: wired on the bar and every non-clickable label on it
        // (not the expand button, which has its own Click) so the whole
        // pill (other than the arrow) is grabbable, matching how a
        // draggable title-bar-less window normally behaves.
        foreach (Control c in new Control[] { _bar, _pcNameLabel, sep1, _timeLabel, sep2 })
        {
            c.MouseDown += Bar_MouseDown;
            c.MouseMove += Bar_MouseMove;
            c.MouseUp += Bar_MouseUp;
        }
    }

    private void Bar_MouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _dragging = true;
        // Click coordinates from `sender` need to be translated to
        // screen space before subtracting the Form's own screen Location,
        // since sender may be a child control of _bar, not the Form itself.
        var screenPoint = ((Control)sender!).PointToScreen(e.Location);
        _dragOffset = new Point(screenPoint.X - Location.X, screenPoint.Y - Location.Y);
    }

    private void Bar_MouseMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        var screenPoint = ((Control)sender!).PointToScreen(e.Location);
        var newLocation = new Point(screenPoint.X - _dragOffset.X, screenPoint.Y - _dragOffset.Y);
        Location = ClampToScreen(newLocation, Width, Height);
        if (_menuForm.Visible) PositionMenu();
    }

    private void Bar_MouseUp(object? sender, MouseEventArgs e)
    {
        _dragging = false;
    }

    // Keeps at least DragClampMargin px of the given size on-screen on
    // every side, using Screen.PrimaryScreen.WorkingArea as the bound.
    private static Point ClampToScreen(Point location, int width, int height)
    {
        var area = Screen.PrimaryScreen!.WorkingArea;
        var minX = area.Left - width + DragClampMargin;
        var maxX = area.Right - DragClampMargin;
        var minY = area.Top - height + DragClampMargin;
        var maxY = area.Bottom - DragClampMargin;
        return new Point(Math.Clamp(location.X, minX, maxX), Math.Clamp(location.Y, minY, maxY));
    }

    // Same rounded-rect GraphicsPath technique RoundedPanel.RoundedRect
    // already uses to paint the pill's corners, reused here (not shared -
    // that method is private to RoundedPanel) so the Form's own Region
    // matches the panel's painted shape exactly.
    private void ApplyRoundedRegion()
    {
        using var path = RoundedRectPath(new Rectangle(0, 0, Width, Height), BarHeight / 2);
        Region = new Region(path);
    }

    private static GraphicsPath RoundedRectPath(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private void BuildMenu()
    {
        _menuForm = new Form
        {
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            TopMost = true,
            ShowInTaskbar = false,
            Width = MenuWidth,
            Height = MenuVPadding * 2 + MenuItemHeight * 4,
        };

        _menuList = new Panel { Dock = DockStyle.Fill };
        _menuForm.Controls.Add(_menuList);

        _addTimeItem = MenuButton("Add Time");
        _addTimeItem.Click += (_, _) => ShowAddTimeInMenu();

        _settingsItem = MenuButton("User Settings");
        _settingsItem.Click += (_, _) => OnUserSettingsClicked();

        // Temporary: a real, dedicated Admin Panel screen is a separate,
        // later task not yet built. Until then this reuses the exact same
        // password-gated Force Unlock / Pause action LockForm's Staff
        // Access link already implements, so the menu item does something
        // real and consistent with the rest of the app rather than a dead
        // click or a fake placeholder.
        _adminItem = MenuButton("Admin Panel");
        _adminItem.Click += async (_, _) => await OnAdminPanelClicked();

        _logoutItem = MenuButton("Log Out");
        _logoutItem.Click += async (_, _) => await OnLogOutClicked();

        // DockStyle.Top siblings dock closest-to-edge-first-added-last, so
        // adding in this (reversed) order renders them top-to-bottom as
        // Add Time / User Settings / Admin Panel / Log Out - the order the
        // mockup actually shows, not the order they're declared above.
        _menuList.Controls.Add(_logoutItem);
        _menuList.Controls.Add(_adminItem);
        _menuList.Controls.Add(_settingsItem);
        _menuList.Controls.Add(_addTimeItem);

        // Closing the menu on any click outside it (deactivation) matches
        // normal dropdown behavior - without this it would only ever
        // close via the arrow or an item action.
        _menuForm.Deactivate += (_, _) =>
        {
            if (_menuCoinPanel != null) return;
            _menuClosedByDeactivateAt = DateTime.UtcNow;
            HideMenu();
        };

        RelayoutMenu();
    }

    private CardButton MenuButton(string text) => new()
    {
        Text = text, Dock = DockStyle.Top, Height = MenuItemHeight, CornerRadius = 0,
        TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(16, 0, 0, 0),
    };

    // Recomputes which menu items are visible for the current guest/member
    // state and the menu Form's resulting height. Guest sessions get only
    // Add Time and User Settings - this app has no server-side concept of
    // "log out" for a guest (only RentalApiClient.MemberLogoutAsync
    // exists, and Admin Panel's Staff Access action is member/staff-only
    // in spirit), so rather than inventing new guest-session-ending
    // behavior, both Admin Panel and Log Out are simply not shown for a
    // guest, same convention SwitchPage already used for hiding Rewards
    // from a guest in the old shell.
    private void RelayoutMenu()
    {
        _addTimeItem.Visible = true;
        _settingsItem.Visible = true;
        _adminItem.Visible = _isMember;
        _logoutItem.Visible = _isMember;

        // Dock=Top controls stack in the order they were added regardless
        // of Visible, so no manual Top math is needed here - just the
        // resulting Form height, sized to fit exactly the visible items
        // plus top/bottom padding.
        var visibleCount = (_addTimeItem.Visible ? 1 : 0) + (_settingsItem.Visible ? 1 : 0) + (_adminItem.Visible ? 1 : 0) + (_logoutItem.Visible ? 1 : 0);
        _menuList.Padding = new Padding(0, MenuVPadding, 0, MenuVPadding);
        _menuForm.Height = MenuVPadding * 2 + MenuItemHeight * visibleCount;
        _menuForm.Width = MenuWidth;
        if (_menuForm.Visible) PositionMenu();
    }

    private void ToggleMenu()
    {
        if (_menuForm.Visible)
        {
            HideMenu();
            return;
        }
        // The click that just landed here already activated CafeHomeForm,
        // which fired _menuForm.Deactivate and closed the menu a moment
        // ago - this Click is the same physical click, not a new request
        // to open it. Let it count as the close and stop here.
        if (DateTime.UtcNow - _menuClosedByDeactivateAt < MenuReopenSuppressWindow) return;
        ShowMenu();
    }

    private void ShowMenu()
    {
        PositionMenu();
        _menuForm.Show();
        _menuForm.Activate();
    }

    private void HideMenu()
    {
        if (_menuCoinPanel != null) CloseAddTimeInMenu();
        _menuForm.Hide();
    }

    // Positions the dropdown just below the bar's bottom-left corner, or
    // above it when the bar is parked low enough on screen that the full
    // menu wouldn't fit below (a perfectly normal place to leave a
    // floating bar) - the old always-below placement plus the small
    // DragClampMargin allowance left most of a tall menu off-screen and
    // unusable in that case, not just imperfectly positioned. Horizontal
    // position still uses the same clamping logic as the bar itself.
    private void PositionMenu()
    {
        var area = Screen.PrimaryScreen!.WorkingArea;
        var fitsBelow = Location.Y + Height + 4 + _menuForm.Height <= area.Bottom;
        var desiredY = fitsBelow ? Location.Y + Height + 4 : Location.Y - _menuForm.Height - 4;
        var clampedX = ClampToScreen(new Point(Location.X, desiredY), _menuForm.Width, _menuForm.Height).X;
        _menuForm.Location = new Point(clampedX, desiredY);
    }

    private void OnUserSettingsClicked()
    {
        HideMenu();
        // SettingsPage.BuildGeneralTab() (its tallest tab) lays its last
        // control - the Save button - at Top ~384, Height 40, so content
        // bottom is ~424px within the TabPage's own client area. Add the
        // TabControl's tab-strip header (~30px) plus a margin (~40px)
        // beyond that content bottom: ~424 + 30 + 40 = ~494px of usable
        // client height needed. Using ClientSize instead of Width/Height
        // sizes the actual usable area directly rather than guessing how
        // much the FixedDialog title bar/borders eat into an outer Height,
        // which is what left the Save button clipped before.
        using var host = new Form
        {
            Text = "User Settings",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen,
            MaximizeBox = false,
            MinimizeBox = false,
            TopMost = true,
            ClientSize = new Size(620, 500),
        };
        var settingsPage = new SettingsPage(_api, _config, _prefs);
        settingsPage.PreferencesSaved += _ => ApplyPreferences();
        settingsPage.Dock = DockStyle.Fill;
        host.Controls.Add(settingsPage);
        host.ShowDialog();
    }

    // Mirrors LockForm.OnStaffClicked's exact Force Unlock / Pause flow.
    // Duplicated here rather than shared because LockForm and CafeHomeForm
    // are separate, independently-owned forms in Program.cs with no
    // reference to each other - this is the same pattern, not the same
    // object. Remove this duplication once a real Admin Panel screen
    // replaces it.
    private async Task OnAdminPanelClicked()
    {
        HideMenu();
        var password = PromptDialog.Show("Staff Access", "Enter the app password:", isPassword: true);
        if (string.IsNullOrEmpty(password)) return;

        var choice = MessageBox.Show(
            "Force Unlock now (temporary, re-locks on the next status check)?\n\nChoose No to Pause instead - suspends enforcement until resumed from here or from the admin panel.",
            "Staff Access", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
        if (choice == DialogResult.Cancel) return;

        if (choice == DialogResult.Yes)
        {
            var result = await _api.StaffOverrideAsync(_config.Mac, _config.DeviceSecret, password);
            if (result == null || !result.Success)
            {
                MessageBox.Show(result?.Message ?? "Override failed", "Staff Access", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            // Nothing further to do on success here - unlike LockForm,
            // there's no lock screen on this Form to hide.
        }
        else
        {
            var result = await _api.PauseAsync(_config.Mac, _config.DeviceSecret, password);
            if (result == null || !result.Success)
            {
                MessageBox.Show(result?.Message ?? "Pause failed", "Staff Access", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            // The next status poll picks up paused:true and Program.cs's
            // HandleStatus swaps to the paused indicator - no need to
            // duplicate that transition here.
        }
    }

    private async Task OnLogOutClicked()
    {
        HideMenu();
        if (!_isMember) return; // guest sessions have no logout concept today - see RelayoutMenu's comment
        await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
        // Next poll picks up the logged-out state - same as the old
        // shell's idle-timeout auto-logout, no need to duplicate the
        // locked-screen transition here.
    }

    // Swaps the menu's content from the item list to an embedded
    // CoinInsertPanel, the exact same compact (non-large) pattern the old
    // top bar's ShowTopBarCoinPanel/HideTopBarCoinPanel used - just
    // rehosted inside the dropdown instead of the old shell's top bar.
    // CoinInsertPanel's compact mode is a fixed 280x220, so the menu Form
    // temporarily widens/heightens to fit it (plus a 10px margin on every
    // side) rather than trying to squeeze it into the 240px list width.
    private void ShowAddTimeInMenu()
    {
        _menuList.Visible = false;
        _menuForm.Width = 300;
        _menuForm.Height = 240;
        PositionMenu();

        _menuCoinPanel = new CoinInsertPanel(_api, _config, "pc_rental") { Left = 10, Top = 10 };
        _menuCoinPanel.Cancelled += CloseAddTimeInMenu;
        _menuCoinPanel.Completed += _ => CloseAddTimeInMenu();
        _menuForm.Controls.Add(_menuCoinPanel);
        _menuCoinPanel.BringToFront();
    }

    private void CloseAddTimeInMenu()
    {
        if (_menuCoinPanel == null) return;
        _menuForm.Controls.Remove(_menuCoinPanel);
        _menuCoinPanel.Dispose();
        _menuCoinPanel = null;
        _menuList.Visible = true;
        RelayoutMenu(); // restores the 240-wide list sizing
        HideMenu();
    }

    private void ApplyTheme()
    {
        _bar.BackColor = Theme.SurfaceAlt;
        _pcNameLabel.ForeColor = Theme.TextPrimary;
        _timeLabel.ForeColor = Theme.TextPrimary;
        _expandButton.ForeColor = Theme.TextMuted;
        foreach (Control c in _bar.Controls)
        {
            if (c is Label l && l.Text == "|") l.ForeColor = Theme.Border;
        }

        _menuList.BackColor = Theme.Surface;
        _menuForm.BackColor = Theme.Surface;
        foreach (var item in new[] { _addTimeItem, _settingsItem, _adminItem, _logoutItem })
        {
            item.BackColor = Theme.Surface;
            item.ForeColor = Theme.TextPrimary;
        }
    }

    private void ApplyPreferences()
    {
        if (_isMember && _prefs.AutoLogoutEnabled) _idleDetector.Start(_prefs.AutoLogoutMinutes);
        else _idleDetector.Stop();
    }

    // Shows a one-time-per-approach reminder once the remaining time drops
    // to or below the configured threshold; resets as soon as it's no
    // longer below threshold (e.g. the member added time) so a later
    // approach shows it again.
    private void CheckSessionReminder(double minutesRemaining)
    {
        if (!_prefs.SessionReminderEnabled) { _sessionReminderShown = false; return; }
        if (minutesRemaining > _prefs.SessionReminderMinutesBefore) { _sessionReminderShown = false; return; }
        if (_sessionReminderShown || !Visible) return;
        _sessionReminderShown = true;
        MessageBox.Show($"Your session ends in about {_prefs.SessionReminderMinutesBefore} minutes. Add more time from the menu if you'd like to keep playing.",
            "Session ending soon", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task OnIdleTimeoutAsync()
    {
        if (!_isMember) return; // no session to auto-logout for a guest
        await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
        // Next poll picks up the logged-out state - no need to duplicate
        // that transition here.
    }

    // Called on every ~5s status poll (Program.cs), not just when a
    // session actually starts - so first-show setup (Show/TopMost/
    // Activate) must only run on the hidden-to-visible transition. Under
    // the old full-screen shell, calling Activate() unconditionally was
    // harmless (the shell WAS the foreground app); now that the real
    // desktop shows through under this small bar, activating on every
    // poll would steal keyboard/mouse focus from whatever the customer is
    // doing every few seconds, and would also fire _menuForm's Deactivate
    // handler and close any menu the customer just opened.
    public void ShowHome()
    {
        if (Visible) return;
        Show();
        TopMost = true;
        Activate();
    }

    public void HideHome()
    {
        HideMenu();
        Hide();
    }

    public void UpdateFromStatus(StatusResponse status)
    {
        var minutes = (int)status.MinutesRemaining;
        var seconds = (int)((status.MinutesRemaining - minutes) * 60);
        _timeLabel.Text = $"{minutes:D2}:{seconds:D2}";

        _pcName = status.PcName;
        _pcNameLabel.Text = _pcName;

        var wasMember = _isMember;
        _isMember = !string.IsNullOrEmpty(status.LoggedInUser);
        if (wasMember != _isMember) RelayoutMenu();

        ApplyPreferences();
        CheckSessionReminder(status.MinutesRemaining);
    }

    // Clean Up on Exit (Settings > General) - called from Program.cs
    // when a session ends (member logout or guest time hits 0). Closes
    // any running process not on the server's whitelisted-apps allow-
    // list, unless the operator has turned this off. Unchanged from the
    // previous shell - unrelated to the bar/menu rebuild.
    public async Task CleanUpOnExitIfEnabledAsync()
    {
        if (!_prefs.CleanUpOnExit) return;
        WhitelistedAppsResponse? whitelist;
        try
        {
            whitelist = await _api.GetWhitelistedAppsAsync(_config.Mac, _config.DeviceSecret);
        }
        catch
        {
            return; // can't confirm the allow-list - safer to close nothing than close something exempt
        }
        if (whitelist == null || !whitelist.Success) return;

        var allowed = new HashSet<string>(whitelist.Apps, StringComparer.OrdinalIgnoreCase);
        var thisProcessName = System.Diagnostics.Process.GetCurrentProcess().ProcessName;
        foreach (var process in System.Diagnostics.Process.GetProcesses())
        {
            try
            {
                if (process.Id == Environment.ProcessId) continue; // never close self
                if (allowed.Contains(process.ProcessName)) continue;
                if (string.IsNullOrEmpty(process.MainWindowTitle)) continue; // skip background/system processes with no window
                process.CloseMainWindow();
            }
            catch
            {
                // A process that can't be inspected/closed (permissions,
                // already exited) shouldn't stop the rest of the cleanup.
            }
        }
    }
}
