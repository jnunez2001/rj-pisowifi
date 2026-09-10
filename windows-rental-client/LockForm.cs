using System.Drawing.Drawing2D;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

// Full-screen branded locked splash. Rebuilt to match the original design
// mockup's own Lock Screen composition 1:1 (single centered vertical
// stack - logo mark, wordmark, PC pill, stacked Guest/Member buttons,
// "New here?" CTA - rather than the earlier two-card side-by-side layout),
// per an explicit "make it identical to the mockup" request.
//
// A few deliberate departures from the mockup, all preserving real,
// already-shipped functionality the mockup itself never had to account
// for (documented here rather than silently dropped):
// - Call Staff / How to Play: kept as small secondary text links below the
//   main stack. The mockup has no equivalent anywhere on this screen, but
//   dropping them removes a genuinely used "I'm stuck, get a human" path
//   with nothing to replace it.
// - The admin-configurable lock announcement (Settings > Lock Screen
//   Announcement) is kept, shown small and muted below the café name -
//   real, operator-set content, not decorative mockup text.
// - The live clock, LOCKED/AVAILABLE status dot, and the bottom
//   Server/Secure/Network/version status footer are removed entirely to
//   match the mockup, which has none of these. This is a real loss of
//   at-a-glance operator diagnostics on this specific screen - flagged
//   here rather than assumed unnoticed.
// - Member Login's button is now always outlined (white/bordered) on
//   every theme, matching the mockup exactly - this supersedes the
//   previous theme-restyle task's narrower rule (outlined only under
//   LightGaming, solid elsewhere), since full mockup fidelity is this
//   task's explicit goal.
public class LockForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly KeyboardBlocker _keyboardBlocker = new();

    private PictureBox _wallpaperBox = null!;

    private Panel _centerPanel = null!;
    private RoundedPanel _logoMark = null!;
    private RoundedPanel _logoMarkInner = null!;
    private PictureBox _logoBox = null!;
    private Label _cafeNameLabel = null!;
    private Label _announcementLabel = null!;
    private RoundedPanel _pcPill = null!;
    private Label _pcPillLabel = null!;

    // Home view (single-column stack)
    private Panel _homeView = null!;
    private CardButton _guestButton = null!;
    private CardButton _memberButton = null!;
    private Label _createAccountLink = null!;
    private Label _callStaffLink = null!;
    private Label _howToPlayLink = null!;

    // Corner "Staff / Admin" text link (password-gated force-unlock/pause,
    // unchanged behavior - just restyled to a plain text link).
    private Label _staffLink = null!;

    // Login sub-view controls
    private Panel _loginView = null!;
    private Label _loginCloseX = null!;
    private Label _loginTitleLabel = null!;
    private TextBox _usernameBox = null!;
    private TextBox _passwordBox = null!;
    private CardButton _loginButton = null!;
    private Label _loginErrorLabel = null!;

    // Coin-insert sub-view (Insert Coins / Create Account), built fresh
    // each time it's opened so it always starts from a clean state.
    private CoinInsertPanel? _coinPanel;

    private string? _instructionsText;
    private bool _connected = true;

    public LockForm(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
        BuildUi();
    }

    private void BuildUi()
    {
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = Screen.PrimaryScreen!.Bounds;
        ShowInTaskbar = false;
        KeyPreview = true;
        DoubleBuffered = true;

        _wallpaperBox = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.StretchImage, Visible = false };
        Controls.Add(_wallpaperBox);

        BuildStaffLink();
        BuildCenter();

        FormClosing += (_, e) => { /* prevent Alt+F4 closing the lock while it's supposed to be showing */
            if (Visible) e.Cancel = true;
        };
        Resize += (_, _) => RecenterHomeView();

        ApplyTheme();
        ShowHomeView();
    }

    // Soft radial highlight behind the whole screen, matching the
    // mockup's "radial-gradient(circle at 50% 30%, ...)" background -
    // blended from existing Theme tokens (Surface -> Background) rather
    // than adding new one-off color properties for a single screen.
    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var bounds = ClientRectangle;
        if (bounds.Width <= 0 || bounds.Height <= 0) { base.OnPaintBackground(e); return; }

        using var backdrop = new SolidBrush(Theme.Background);
        e.Graphics.FillRectangle(backdrop, bounds);

        var centerX = bounds.Width * 0.5f;
        var centerY = bounds.Height * 0.3f;
        var radius = Math.Max(bounds.Width, bounds.Height) * 0.75f;
        using var path = new GraphicsPath();
        path.AddEllipse(centerX - radius, centerY - radius, radius * 2, radius * 2);
        using var brush = new PathGradientBrush(path)
        {
            CenterColor = Theme.Surface,
            SurroundColors = new[] { Theme.Background }
        };
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.FillPath(brush, path);
    }

    private void BuildStaffLink()
    {
        _staffLink = new Label { Text = "Staff / Admin", AutoSize = true, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 9) };
        _staffLink.Click += async (_, _) => await OnStaffClicked();
        Controls.Add(_staffLink);
        _staffLink.BringToFront();
        Resize += (_, _) => { _staffLink.Location = new Point(Bounds.Width - _staffLink.Width - 48, 40); };
    }

    private void BuildCenter()
    {
        _centerPanel = new Panel { Width = 480, Height = 620 };
        Controls.Add(_centerPanel);
        _centerPanel.BringToFront();

        // Logo mark: an accent-colored rounded square (mockup's default
        // placeholder look), with the real admin-configured logo image
        // layered on top once/if it loads.
        _logoMark = new RoundedPanel { Width = 88, Height = 88, CornerRadius = 20, Left = (_centerPanel.Width - 88) / 2, Top = 0 };
        _centerPanel.Controls.Add(_logoMark);
        _logoMarkInner = new RoundedPanel { Width = 36, Height = 36, CornerRadius = 8, Left = (88 - 36) / 2, Top = (88 - 36) / 2 };
        _logoMark.Controls.Add(_logoMarkInner);
        _logoBox = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Width = 88, Height = 88, Left = 0, Top = 0, Visible = false };
        _logoMark.Controls.Add(_logoBox);

        _cafeNameLabel = new Label { Font = new Font("Segoe UI", 26, FontStyle.Bold), AutoSize = false, Width = _centerPanel.Width, Height = 44, Top = 104, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_cafeNameLabel);

        _announcementLabel = new Label { AutoSize = false, Font = new Font("Segoe UI", 9), Width = _centerPanel.Width, Height = 24, Top = 150, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_announcementLabel);

        _pcPill = new RoundedPanel { Width = 110, Height = 36, CornerRadius = 18, Top = 190, Left = (_centerPanel.Width - 110) / 2 };
        _centerPanel.Controls.Add(_pcPill);
        _pcPillLabel = new Label { Font = new Font("Segoe UI", 10, FontStyle.Bold), AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
        _pcPill.Controls.Add(_pcPillLabel);

        BuildHomeView();
        BuildLoginView();
    }

    private void BuildHomeView()
    {
        _homeView = new Panel { Left = 0, Top = 250, Width = _centerPanel.Width, Height = 300 };
        _centerPanel.Controls.Add(_homeView);

        var buttonWidth = 360;
        var buttonLeft = (_homeView.Width - buttonWidth) / 2;

        _guestButton = new CardButton { Text = "GUEST", Width = buttonWidth, Height = 60, Left = buttonLeft, Top = 0, CornerRadius = 14, Font = new Font("Segoe UI", 15, FontStyle.Bold) };
        _guestButton.Click += (_, _) => ShowCoinPanel("pc_rental");
        _homeView.Controls.Add(_guestButton);

        _memberButton = new CardButton { Text = "MEMBER LOGIN", Width = buttonWidth, Height = 60, Left = buttonLeft, Top = 74, CornerRadius = 14, Font = new Font("Segoe UI", 13, FontStyle.Bold) };
        _memberButton.Click += (_, _) => ShowLoginView();
        _homeView.Controls.Add(_memberButton);

        _createAccountLink = new Label { Text = "New here? Create a member account", AutoSize = false, Width = _homeView.Width, Height = 24, Top = 154, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 9, FontStyle.Bold), Cursor = Cursors.Hand };
        _createAccountLink.Click += (_, _) => ShowCoinPanel("pc_rental_create_account");
        _homeView.Controls.Add(_createAccountLink);

        // Real functionality the mockup has no equivalent for on this
        // screen - kept as small, quiet secondary links rather than
        // dropped (see the class-level comment).
        _callStaffLink = new Label { Text = "Need Help? Call Staff", AutoSize = false, Width = _homeView.Width, Height = 20, Top = 210, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 8), Cursor = Cursors.Hand };
        _callStaffLink.Click += async (_, _) => await OnCallStaffClicked();
        _homeView.Controls.Add(_callStaffLink);

        _howToPlayLink = new Label { Text = "How to Play", AutoSize = false, Width = _homeView.Width, Height = 20, Top = 234, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 8), Cursor = Cursors.Hand };
        _howToPlayLink.Click += (_, _) => ShowInstructions();
        _homeView.Controls.Add(_howToPlayLink);
    }

    private void BuildLoginView()
    {
        // All Top offsets below are relative to _loginView's own bounds
        // (it clips its children) - not to _centerPanel, where the panel
        // itself sits at Top = 200. Panel enlarged to 360 to fit the
        // close X, title, both fields, the button, and the error label
        // with reasonable spacing, all within Top >= 0.
        _loginView = new Panel { Left = 0, Top = 200, Width = _centerPanel.Width, Height = 360, Visible = false };
        _centerPanel.Controls.Add(_loginView);

        _loginCloseX = new Label { Text = "✕", AutoSize = true, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 12), Left = _centerPanel.Width - 40, Top = 10 };
        _loginCloseX.Click += (_, _) => ShowHomeView();
        _loginView.Controls.Add(_loginCloseX);

        _loginTitleLabel = new Label { Text = "MEMBER LOGIN", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = false, Width = _centerPanel.Width, Height = 30, Top = 50, TextAlign = ContentAlignment.MiddleCenter };
        _loginView.Controls.Add(_loginTitleLabel);

        var fieldWidth = 320;
        var fieldLeft = (_centerPanel.Width - fieldWidth) / 2;

        _usernameBox = new TextBox { PlaceholderText = "Username", Width = fieldWidth, Left = fieldLeft, Top = 100, Font = new Font("Segoe UI", 11) };
        _loginView.Controls.Add(_usernameBox);

        _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Width = fieldWidth, Left = fieldLeft, Top = 140, Font = new Font("Segoe UI", 11) };
        _loginView.Controls.Add(_passwordBox);

        _loginButton = new CardButton { Text = "LOG IN", Width = fieldWidth, Height = 48, Left = fieldLeft, Top = 184, CornerRadius = 12, Font = new Font("Segoe UI", 12, FontStyle.Bold) };
        _loginButton.Click += async (_, _) => await OnLoginClicked();
        _loginView.Controls.Add(_loginButton);

        _loginErrorLabel = new Label { ForeColor = Color.OrangeRed, Width = fieldWidth, Left = fieldLeft, Top = 240, TextAlign = ContentAlignment.MiddleCenter, Height = 24 };
        _loginView.Controls.Add(_loginErrorLabel);
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
        Invalidate();
        _logoMark.BackColor = Theme.Accent;
        _logoMarkInner.BackColor = Theme.OnAccent;
        _cafeNameLabel.ForeColor = Theme.TextPrimary;
        _announcementLabel.ForeColor = Theme.TextMuted;
        _pcPill.BackColor = Theme.Surface;
        _pcPillLabel.ForeColor = Theme.TextMuted;
        _staffLink.ForeColor = Theme.TextMuted;

        _guestButton.BackColor = Theme.Accent;
        _guestButton.ForeColor = Theme.OnAccent;
        _guestButton.Outlined = false;

        // Member Login is always outlined now, on every theme - full
        // mockup fidelity supersedes the previous theme-restyle task's
        // LightGaming-only rule (see class-level comment).
        _memberButton.BackColor = Theme.Surface;
        _memberButton.ForeColor = Theme.TextPrimary;
        _memberButton.Outlined = true;

        _createAccountLink.ForeColor = Theme.Accent;
        _callStaffLink.ForeColor = Theme.TextMuted;
        _howToPlayLink.ForeColor = Theme.TextMuted;

        _loginCloseX.ForeColor = Theme.TextMuted;
        _loginTitleLabel.ForeColor = Theme.TextPrimary;
        _loginErrorLabel.ForeColor = Theme.Danger;
        _loginButton.BackColor = Theme.Accent;
        _loginButton.ForeColor = Theme.OnAccent;
        _usernameBox.BackColor = Theme.Surface;
        _usernameBox.ForeColor = Theme.TextPrimary;
        _passwordBox.BackColor = Theme.Surface;
        _passwordBox.ForeColor = Theme.TextPrimary;
    }

    private void ShowHomeView()
    {
        _coinPanel?.Dispose();
        _coinPanel = null;
        _loginErrorLabel.Text = "";
        _usernameBox.Text = "";
        _passwordBox.Text = "";
        _homeView.Visible = true;
        _loginView.Visible = false;
        RecenterHomeView();
    }

    private void RecenterHomeView()
    {
        _centerPanel.Left = (Bounds.Width - _centerPanel.Width) / 2;
        _centerPanel.Top = (Bounds.Height - _centerPanel.Height) / 2;
        _staffLink.Location = new Point(Bounds.Width - _staffLink.Width - 48, 40);
    }

    private void ShowLoginView()
    {
        _homeView.Visible = false;
        _loginView.Visible = true;
    }

    private void ShowCoinPanel(string mode)
    {
        _homeView.Visible = false;
        _loginView.Visible = false;

        // Large mode's panel (480x500) is taller than _centerPanel's own
        // fixed 480x620 bounds would leave room for if placed the same
        // way the small compact panel used to be (Top = 60 would put its
        // bottom at 560, still inside 620 - but centering it properly
        // here rather than reusing the old compact-panel offset, since
        // that offset was sized for the 280x220 panel, not this one).
        var coinPanel = new CoinInsertPanel(_api, _config, mode, large: true);
        coinPanel.Left = (_centerPanel.Width - coinPanel.Width) / 2;
        coinPanel.Top = (_centerPanel.Height - coinPanel.Height) / 2;
        _coinPanel = coinPanel;
        _coinPanel.Cancelled += ShowHomeView;
        _coinPanel.Completed += OnCoinPanelCompleted;
        _centerPanel.Controls.Add(_coinPanel);
        _coinPanel.BringToFront();
    }

    private void OnCoinPanelCompleted(ApiResult result)
    {
        if (result.AccountCreated)
        {
            MessageBox.Show($"Account \"{result.Username}\" created with {result.Seconds / 60} minutes. You can log in now.",
                "Account created", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        // Guest credit and the "username taken, credited as guest
        // instead" fallback both just return to the home view - the next
        // status poll (~5s) picks up the newly-unlocked state on its
        // own, no need to duplicate that transition here.
        ShowHomeView();
    }

    private void ShowInstructions()
    {
        var text = string.IsNullOrWhiteSpace(_instructionsText)
            ? "Insert coins on the Guest card, or log in with your member account. Ask staff if you need help."
            : _instructionsText;
        MessageBox.Show(text, "How to Play", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task OnCallStaffClicked()
    {
        var result = await _api.RequestHelpAsync(_config.Mac, _config.DeviceSecret);
        MessageBox.Show(result?.Message ?? "Staff has been notified.", "Call Staff", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _keyboardBlocker.Install();
        Activate();
        Focus();
    }

    public void HideLock()
    {
        _keyboardBlocker.Uninstall();
        Hide();
    }

    // The mockup this screen was rebuilt to match has no connectivity
    // indicator at all, so there's nothing visible left to update here -
    // state is still tracked in case a later screen (e.g. Staff Mode,
    // planned separately) wants to surface it again.
    public void SetConnected(bool connected)
    {
        _connected = connected;
    }

    public void ShowLock(StatusResponse status)
    {
        _pcPillLabel.Text = string.IsNullOrWhiteSpace(status.PcName) ? "PC" : status.PcName;
        // StatusResponse has no separate café-name field - only PcName.
        // Showing PcName on both the wordmark and the pill duplicated the
        // same string; the wordmark now always shows this fixed brand
        // text (was previously just the empty-name fallback) so it stops
        // repeating the PC's own identifier below it.
        _cafeNameLabel.Text = "STARKFI ESPORTS CAFÉ";
        _announcementLabel.Text = status.LockAnnouncement ?? "";
        _announcementLabel.Visible = !string.IsNullOrWhiteSpace(status.LockAnnouncement);
        _instructionsText = status.InstructionsText;
        LoadImageAsync(_wallpaperBox, status.WallpaperUrl);
        LoadImageAsync(_logoBox, status.LogoUrl, () =>
        {
            _logoBox.Visible = true;
            _logoMarkInner.Visible = false;
        });
        if (!Visible) ShowHomeView();
        Show();
        _keyboardBlocker.Install();
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        RecenterHomeView();
        Activate();
    }

    private async void LoadImageAsync(PictureBox box, string? url, Action? onLoaded = null)
    {
        if (string.IsNullOrEmpty(url))
        {
            box.Image = null;
            box.Visible = false;
            if (box == _logoBox) _logoMarkInner.Visible = true;
            if (box == _wallpaperBox) _wallpaperBox.Visible = false;
            return;
        }
        try
        {
            var fullUrl = url.StartsWith("http") ? url : _config.ServerUrl.TrimEnd('/') + url;
            using var client = new HttpClient();
            var bytes = await client.GetByteArrayAsync(fullUrl);
            using var ms = new MemoryStream(bytes);
            box.Image = Image.FromStream(ms);
            if (box == _wallpaperBox) box.Visible = true;
            onLoaded?.Invoke();
        }
        catch
        {
            // Missing/unreachable branding image shouldn't block the lock
            // screen from showing - just leave that box blank. This also
            // covers a later failed poll after an earlier one succeeded,
            // so a stale image/visibility state isn't left on screen.
            box.Image = null;
            box.Visible = false;
            if (box == _logoBox) _logoMarkInner.Visible = true;
        }
    }

    private async Task OnLoginClicked()
    {
        _loginErrorLabel.Text = "";
        _loginButton.Enabled = false;
        try
        {
            var result = await _api.MemberLoginAsync(_config.Mac, _config.DeviceSecret, _usernameBox.Text, _passwordBox.Text);
            if (result == null || !result.Success)
            {
                _loginErrorLabel.Text = result?.Message ?? "Login failed";
                return;
            }
            _passwordBox.Text = "";
            // The next status poll (within ~5s) will pick up the newly-
            // unlocked state and transition away from this screen - no
            // need to duplicate that logic here.
        }
        finally
        {
            _loginButton.Enabled = true;
        }
    }

    // Staff Access stays reachable but out of the way (small corner text
    // link, matching the mockup's "Staff / Admin" corner link) -
    // password-gated force-unlock/pause, unchanged from before.
    public async Task OnStaffClicked()
    {
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
                return;
            }
            HideLock();
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
}
