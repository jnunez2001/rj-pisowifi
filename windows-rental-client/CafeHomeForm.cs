using StarkFiRentalClient.UI;
using StarkFiRentalClient.Pages;

namespace StarkFiRentalClient;

// Café Home (V1.0.0 mockup rebuild) - a persistent shell (sidebar + top
// bar + swappable content area) shown instead of the raw Windows
// desktop while a session is unlocked and no game is currently running.
// Same full-screen/borderless/topmost/keyboard-blocked technique
// LockForm already uses, but a separate form (not a reuse of LockForm)
// since the purpose is different: launching processes and returning,
// not blocking input for payment.
//
// The old CountdownWidget floating corner form is retired - this
// persistent top bar supersedes its entire reason to exist. Its Add
// Time/Account/Points logic wasn't lost, it's redistributed to where
// the mockup actually puts it: Add Time lives in the top bar (below),
// Account lives in Settings, Points lives in the Rewards page.
public class CafeHomeForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly ClientPreferences _prefs;
    private readonly KeyboardBlocker _keyboardBlocker = new();

    // Top bar
    private Panel _topBar = null!;
    private Label _timeLabel = null!;
    private CardButton _addTimeButton = null!;
    private Label _memberLabel = null!;
    private Label _memberBadge = null!;
    private Label _pointsLabel = null!;
    private Label _pcInfoLabel = null!;
    private Label _clockLabel = null!;
    private CoinInsertPanel? _topBarCoinPanel;
    private readonly System.Windows.Forms.Timer _clockTimer;

    // Sidebar
    private Panel _sidebar = null!;
    private readonly Dictionary<string, CardButton> _navButtons = new();

    // Content pages
    private Panel _content = null!;
    private HomePage _homePage = null!;
    private GamesPage _gamesPage = null!;
    private ApplicationsPage _applicationsPage = null!;
    private MySessionPage _mySessionPage = null!;
    private RewardsPage _rewardsPage = null!;
    private SettingsPage _settingsPage = null!;
    private string _activePage = "home";

    private readonly System.Windows.Forms.Timer _catalogRefreshTimer;
    private static readonly TimeSpan CatalogRefreshInterval = TimeSpan.FromSeconds(60);

    private readonly IdleDetector _idleDetector = new();
    private bool _isMember;
    private bool _sessionReminderShown;

    public CafeHomeForm(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
    {
        _api = api;
        _config = config;
        _prefs = prefs;

        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = Screen.PrimaryScreen!.Bounds;
        ShowInTaskbar = false;
        KeyPreview = true;

        BuildSidebar();
        BuildTopBar();
        BuildContent();

        _catalogRefreshTimer = new System.Windows.Forms.Timer { Interval = (int)CatalogRefreshInterval.TotalMilliseconds };
        _catalogRefreshTimer.Tick += async (_, _) => await RefreshActivePageAsync();

        _clockTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        _clockTimer.Tick += (_, _) => _clockLabel.Text = DateTime.Now.ToString("hh:mm tt  •  MMM d, yyyy");

        _idleDetector.IdleTimeoutReached += async () => await OnIdleTimeoutAsync();
        AppLauncher.ProcessExited += () => { if (IsHandleCreated) BeginInvoke(ShowHome); };

        // Same guard LockForm uses - without this, Alt+F4 would dispose
        // this Form outright (not just hide it), and Program.cs's cached
        // reference would throw ObjectDisposedException on its very next
        // Show()/Hide() call, crashing the whole client.
        FormClosing += (_, e) => { if (Visible) e.Cancel = true; };

        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
        ApplyTheme();
        SwitchPage("home");
    }

    // Program.cs polls status every 5s and calls ShowHome() on every
    // unlocked tick - without this guard, that would pop this screen
    // back up on top of a game the customer just launched.
    public bool IsProgramRunning => AppLauncher.IsProgramRunning;

    private void BuildSidebar()
    {
        _sidebar = new Panel { Dock = DockStyle.Left, Width = 220 };
        Controls.Add(_sidebar);

        var logo = new Label { Text = "CAFÉ HOME", Font = new Font("Segoe UI", 13, FontStyle.Bold), AutoSize = true, Left = 20, Top = 20 };
        _sidebar.Controls.Add(logo);

        var items = new (string key, string label)[]
        {
            ("home", "HOME"), ("games", "GAMES"), ("applications", "APPLICATIONS"),
            ("mysession", "MY SESSION"), ("rewards", "REWARDS"), ("settings", "SETTINGS"),
        };
        var y = 70;
        foreach (var (key, label) in items)
        {
            var button = new CardButton { Text = label, Width = 180, Height = 44, Left = 20, Top = y, CornerRadius = 8, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(16, 0, 0, 0) };
            var capturedKey = key;
            button.Click += (_, _) => SwitchPage(capturedKey);
            _sidebar.Controls.Add(button);
            _navButtons[key] = button;
            y += 52;
        }
    }

    private void BuildTopBar()
    {
        _topBar = new Panel { Dock = DockStyle.Top, Height = 76 };
        Controls.Add(_topBar);

        _timeLabel = new Label { Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = true, Left = 24, Top = 14 };
        var timeCaption = new Label { Text = "REMAINING TIME", Font = new Font("Segoe UI", 7, FontStyle.Bold), AutoSize = true, Left = 24, Top = 40 };
        _addTimeButton = new CardButton { Text = "+ ADD TIME", Width = 110, Height = 30, Left = 150, Top = 22, CornerRadius = 6 };
        _addTimeButton.Click += (_, _) => ShowTopBarCoinPanel();

        _memberLabel = new Label { Font = new Font("Segoe UI", 10, FontStyle.Bold), AutoSize = true, Top = 14 };
        _memberBadge = new Label { Text = "MEMBER", Font = new Font("Segoe UI", 7, FontStyle.Bold), AutoSize = true, Top = 15, Padding = new Padding(6, 2, 6, 2) };
        _pointsLabel = new Label { Font = new Font("Segoe UI", 8), AutoSize = true, Top = 38 };

        _pcInfoLabel = new Label { Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, Top = 14, TextAlign = ContentAlignment.MiddleRight };
        _clockLabel = new Label { Font = new Font("Segoe UI", 8), AutoSize = true, Top = 38 };

        _topBar.Controls.Add(_timeLabel);
        _topBar.Controls.Add(timeCaption);
        _topBar.Controls.Add(_addTimeButton);
        _topBar.Controls.Add(_memberLabel);
        _topBar.Controls.Add(_memberBadge);
        _topBar.Controls.Add(_pointsLabel);
        _topBar.Controls.Add(_pcInfoLabel);
        _topBar.Controls.Add(_clockLabel);

        _topBar.Resize += (_, _) => RepositionTopBarRight();
    }

    private void RepositionTopBarRight()
    {
        _clockLabel.Left = _topBar.Width - _clockLabel.Width - 24;
        _pcInfoLabel.Left = _topBar.Width - Math.Max(_pcInfoLabel.Width, 140) - 24;
        _memberLabel.Left = _pcInfoLabel.Left - _memberLabel.Width - 200;
        _memberBadge.Left = _memberLabel.Left + _memberLabel.Width + 8;
        _pointsLabel.Left = _memberLabel.Left;
    }

    private void BuildContent()
    {
        _content = new Panel { Dock = DockStyle.Fill };
        Controls.Add(_content);

        _homePage = new HomePage(_api, _config) { Visible = false };
        _homePage.NavigateRequested += key => SwitchPage(key);
        _gamesPage = new GamesPage(_api, _config) { Visible = false };
        _applicationsPage = new ApplicationsPage(_api, _config) { Visible = false };
        _mySessionPage = new MySessionPage(_api, _config) { Visible = false };
        _rewardsPage = new RewardsPage(_api, _config) { Visible = false };
        _settingsPage = new SettingsPage(_api, _config, _prefs) { Visible = false };
        _settingsPage.PreferencesSaved += _ => ApplyPreferences();

        _content.Controls.Add(_homePage);
        _content.Controls.Add(_gamesPage);
        _content.Controls.Add(_applicationsPage);
        _content.Controls.Add(_mySessionPage);
        _content.Controls.Add(_rewardsPage);
        _content.Controls.Add(_settingsPage);

        _sidebar.BringToFront();
        _topBar.BringToFront();
    }

    private void SwitchPage(string key)
    {
        if (key == "rewards" && !_isMember) key = "home"; // hidden entirely for a guest session, same as before
        _activePage = key;

        foreach (var (navKey, button) in _navButtons)
        {
            button.BackColor = navKey == key ? Theme.Accent : Theme.Surface;
        }

        _homePage.Visible = key == "home";
        _gamesPage.Visible = key == "games";
        _applicationsPage.Visible = key == "applications";
        _mySessionPage.Visible = key == "mysession";
        _rewardsPage.Visible = key == "rewards";
        _settingsPage.Visible = key == "settings";

        if (key == "home") _homePage.OnShown(); else _homePage.OnHidden();

        _ = RefreshActivePageAsync();
    }

    private async Task RefreshActivePageAsync()
    {
        try
        {
            switch (_activePage)
            {
                case "home": await _homePage.RefreshAsync(); break;
                case "games": await _gamesPage.RefreshAsync(); break;
                case "applications": await _applicationsPage.RefreshAsync(); break;
                case "rewards": await _rewardsPage.RefreshAsync(); break;
            }
        }
        catch
        {
            // Network hiccup - keep whatever's already showing rather
            // than clearing the screen over a transient failure.
        }
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
        _sidebar.BackColor = Theme.SurfaceAlt;
        _topBar.BackColor = Theme.SurfaceAlt;
        foreach (Control c in _sidebar.Controls)
        {
            if (c is Label l) l.ForeColor = Theme.TextPrimary;
        }
        foreach (var (navKey, button) in _navButtons)
        {
            button.ForeColor = Theme.TextPrimary;
            button.BackColor = navKey == _activePage ? Theme.Accent : Theme.Surface;
        }
        _timeLabel.ForeColor = Theme.TextPrimary;
        _addTimeButton.BackColor = Theme.Accent;
        _memberLabel.ForeColor = Theme.TextPrimary;
        _memberBadge.BackColor = Theme.Accent;
        _memberBadge.ForeColor = Color.White;
        _pointsLabel.ForeColor = Theme.TextMuted;
        _pcInfoLabel.ForeColor = Theme.TextPrimary;
        _clockLabel.ForeColor = Theme.TextMuted;
        foreach (Control c in _topBar.Controls)
        {
            if (c.Font.Size <= 8 && c is Label lbl && lbl != _pointsLabel && lbl != _clockLabel) lbl.ForeColor = Theme.TextMuted;
        }
    }

    private void ApplyPreferences()
    {
        if (_isMember && _prefs.AutoLogoutEnabled) _idleDetector.Start(_prefs.AutoLogoutMinutes);
        else _idleDetector.Stop();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _keyboardBlocker.Install();
        Activate();
        Focus();
    }

    public void ShowHome()
    {
        if (IsProgramRunning) return;
        if (!Visible)
        {
            Show();
            _ = RefreshActivePageAsync();
        }
        _keyboardBlocker.Install();
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        Activate();
        _catalogRefreshTimer.Start();
        _clockTimer.Start();
        _clockLabel.Text = DateTime.Now.ToString("hh:mm tt  •  MMM d, yyyy");
    }

    public void HideHome()
    {
        _catalogRefreshTimer.Stop();
        _clockTimer.Stop();
        _keyboardBlocker.Uninstall();
        Hide();
    }

    public void UpdateFromStatus(StatusResponse status)
    {
        var minutes = (int)status.MinutesRemaining;
        var seconds = (int)((status.MinutesRemaining - minutes) * 60);
        _timeLabel.Text = $"{minutes:D2}:{seconds:D2}";
        _pcInfoLabel.Text = status.PcName;

        _isMember = !string.IsNullOrEmpty(status.LoggedInUser);
        _memberLabel.Text = _isMember ? $"Welcome back, {status.LoggedInUser}" : "Guest session";
        _memberBadge.Visible = _isMember;
        _pointsLabel.Visible = _isMember;
        _pointsLabel.Text = _isMember ? $"{status.LoggedInPoints ?? 0} points" : "";
        _navButtons["rewards"].Visible = _isMember;
        RepositionTopBarRight();

        _mySessionPage.UpdateFromStatus(status);
        ApplyPreferences();
        CheckSessionReminder(status.MinutesRemaining);
    }

    private void CheckSessionReminder(double minutesRemaining)
    {
        if (!_prefs.SessionReminderEnabled) { _sessionReminderShown = false; return; }
        if (minutesRemaining > _prefs.SessionReminderMinutesBefore) { _sessionReminderShown = false; return; }
        if (_sessionReminderShown || !Visible) return;
        _sessionReminderShown = true;
        MessageBox.Show($"Your session ends in about {_prefs.SessionReminderMinutesBefore} minutes. Add more time from the top bar if you'd like to keep playing.",
            "Session ending soon", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task OnIdleTimeoutAsync()
    {
        if (!_isMember) return; // no session to auto-logout for a guest
        await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
        // Next poll picks up the logged-out state - no need to duplicate
        // that transition here.
    }

    private void ShowTopBarCoinPanel()
    {
        _addTimeButton.Visible = false;
        _topBarCoinPanel = new CoinInsertPanel(_api, _config, "pc_rental") { Left = 150, Top = 8, Width = 260 };
        _topBarCoinPanel.Cancelled += HideTopBarCoinPanel;
        _topBarCoinPanel.Completed += _ => HideTopBarCoinPanel();
        _topBar.Controls.Add(_topBarCoinPanel);
        _topBarCoinPanel.BringToFront();
    }

    private void HideTopBarCoinPanel()
    {
        _topBarCoinPanel?.Dispose();
        _topBarCoinPanel = null;
        _addTimeButton.Visible = true;
    }

    // Clean Up on Exit (Settings > General) - called from Program.cs
    // when a session ends (member logout or guest time hits 0). Closes
    // any running process not on the server's whitelisted-apps allow-
    // list, unless the operator has turned this off.
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
