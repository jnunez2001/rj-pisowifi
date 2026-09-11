using System.Drawing.Drawing2D;
using StarkFiRentalClient.UI;
using StarkFiRentalClient.Pages;

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
    private readonly ClientPreferences _prefs;
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

    // Member No-Time view: shown whenever a logged-in member has 0 minutes
    // remaining, whether that's discovered right after MemberLoginAsync or
    // on a later status poll (see ShowLock). Added directly to the Form's
    // Controls (like _staffLink), NOT as a child of _centerPanel - its
    // content (heading + balance + message + a full large-mode
    // CoinInsertPanel + a redeem list) is taller than _centerPanel's fixed
    // 480x620 bounds and would be silently clipped by it (a Windows child
    // control is clipped to its immediate parent's client area). Instead
    // it's its own AutoScroll panel, sized to the visible screen at show
    // time (see RepositionNoTimeView), so content that doesn't fit simply
    // scrolls rather than getting cut off invisibly.
    private Panel _noTimeView = null!;
    private Label _noTimeCloseX = null!;
    private Label _noTimeTitleLabel = null!;
    private Label _noTimeBalanceLabel = null!;
    private Label _noTimeMessageLabel = null!;
    private Label _noTimeRedeemTitleLabel = null!;
    private Label _noTimeRedeemStatusLabel = null!;
    private FlowLayoutPanel _noTimeRatesPanel = null!;
    private CoinInsertPanel? _noTimeCoinPanel;
    private string? _noTimeUsername;

    private string? _instructionsText;
    private bool _connected = true;

    public LockForm(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
    {
        _api = api;
        _config = config;
        _prefs = prefs;
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
        BuildNoTimeView();

        FormClosing += (_, e) => { /* prevent Alt+F4 closing the lock while it's supposed to be showing */
            // AppShutdown.AllowExit (Program.cs) lets Admin Panel's
            // Uninstall/Update handlers actually close this process via
            // Application.Exit() - see CafeHomeForm's matching guard.
            if (Visible && !AppShutdown.AllowExit) e.Cancel = true;
        };
        Resize += (_, _) => { RecenterHomeView(); RepositionNoTimeView(); };

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

    // All Top offsets below are relative to _noTimeView's own (scrollable)
    // coordinate space, width 480 throughout to match _centerPanel's own
    // width so it reads as the same column even though it isn't a child
    // of _centerPanel. Geometry (Top, Height, computed Bottom):
    //   _noTimeCloseX          Top=12   H=28   -> Bottom=40
    //   _noTimeTitleLabel      Top=54   H=30   -> Bottom=84
    //   _noTimeBalanceLabel    Top=90   H=50   -> Bottom=140
    //   _noTimeMessageLabel    Top=146  H=24   -> Bottom=170
    //   _noTimeCoinPanel       Top=180  H=500  -> Bottom=680  (large CoinInsertPanel, added in EmbedNoTimeCoinPanel)
    //   _noTimeRedeemTitleLabel Top=696 H=26   -> Bottom=722
    //   _noTimeRedeemStatusLabel Top=726 H=20  -> Bottom=746
    //   _noTimeRatesPanel      Top=750  H=230+ -> Bottom=980+ (grows with rate count)
    // Total content (~980px) exceeds every child's Top+Height <= parent's
    // assigned Height once the assigned Height is capped to fit the
    // screen (see RepositionNoTimeView) - that's expected and handled by
    // _noTimeView.AutoScroll = true below, not a clipping bug: nothing is
    // rendered outside a scrollable, reachable area.
    private void BuildNoTimeView()
    {
        _noTimeView = new Panel { Width = 480, AutoScroll = true, Visible = false };
        Controls.Add(_noTimeView);

        // Left pulled in by the vertical scrollbar's reserved width - this
        // panel is always AutoScroll=true with content taller than its
        // visible area (see the class-level geometry comment), so a
        // scrollbar reliably renders starting around
        // (Width - VerticalScrollBarWidth). At the default Width=480 with
        // a typical ~17px scrollbar, the close X's old Left=440/Width=28
        // (spanning to x=468) overlapped the scrollbar's reserved area
        // (starting ~x=463) by several pixels, partially covering the
        // member's only way to log out of this screen. Shifting left by
        // the same VerticalScrollBarWidth keeps its right edge clear of
        // the scrollbar with margin to spare.
        _noTimeCloseX = new Label { Text = "✕", AutoSize = false, Width = 28, Height = 28, Left = 440 - SystemInformation.VerticalScrollBarWidth, Top = 12, Font = new Font("Segoe UI", 12), TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
        _noTimeCloseX.Click += async (_, _) => await OnNoTimeCloseClicked();
        _noTimeView.Controls.Add(_noTimeCloseX);

        _noTimeTitleLabel = new Label { Text = "WELCOME, MEMBER", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = false, Width = 480, Height = 30, Top = 54, TextAlign = ContentAlignment.MiddleCenter };
        _noTimeView.Controls.Add(_noTimeTitleLabel);

        _noTimeBalanceLabel = new Label { Text = "-- POINTS", Font = new Font("Segoe UI", 32, FontStyle.Bold), AutoSize = false, Width = 480, Height = 50, Top = 90, TextAlign = ContentAlignment.MiddleCenter };
        _noTimeView.Controls.Add(_noTimeBalanceLabel);

        _noTimeMessageLabel = new Label { Text = "You have no remaining time", Font = new Font("Segoe UI", 10), AutoSize = false, Width = 480, Height = 24, Top = 146, TextAlign = ContentAlignment.MiddleCenter };
        _noTimeView.Controls.Add(_noTimeMessageLabel);

        // The embedded large-mode CoinInsertPanel goes at Top=180 (added
        // dynamically by EmbedNoTimeCoinPanel, disposed/recreated per
        // show - same pattern ShowCoinPanel already uses for _coinPanel).

        _noTimeRedeemTitleLabel = new Label { Text = "REDEEM POINTS", Font = new Font("Segoe UI", 12, FontStyle.Bold), AutoSize = false, Width = 480, Height = 26, Top = 696, TextAlign = ContentAlignment.MiddleCenter };
        _noTimeView.Controls.Add(_noTimeRedeemTitleLabel);

        _noTimeRedeemStatusLabel = new Label { Font = new Font("Segoe UI", 9), AutoSize = false, Width = 460, Left = 10, Height = 20, Top = 726, TextAlign = ContentAlignment.MiddleCenter };
        _noTimeView.Controls.Add(_noTimeRedeemStatusLabel);

        // AutoScroll = true (ported from Pages/RewardsPage.cs's
        // _ratesPanel) - the fixed 230px height only fits 3 of the 60px
        // rows (50px row + 10px bottom margin) before clipping the rest
        // with no way to reach them.
        _noTimeRatesPanel = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown, AutoScroll = true, WrapContents = false,
            Left = 10, Top = 750, Width = 460, Height = 230
        };
        _noTimeView.Controls.Add(_noTimeRatesPanel);
    }

    // Sizes/centers _noTimeView against the current screen bounds rather
    // than _centerPanel's fixed 480x620 (see the field comment above for
    // why). Capped at 760 tall so it never exceeds a small screen; content
    // beyond that scrolls (_noTimeView.AutoScroll = true).
    private void RepositionNoTimeView()
    {
        var maxHeight = Math.Max(300, Bounds.Height - 80);
        _noTimeView.Height = Math.Min(760, maxHeight);
        _noTimeView.Left = (Bounds.Width - _noTimeView.Width) / 2;
        _noTimeView.Top = (Bounds.Height - _noTimeView.Height) / 2;
    }

    // (Re)creates the embedded large-mode CoinInsertPanel - same mode
    // ("pc_rental") and large:true the top-bar "Add Time" flow already
    // uses elsewhere, so adding time to an already-logged-in zero-balance
    // member goes through the exact same server-side coin-insert path,
    // nothing new. Recreated (rather than reused) after Cancelled/
    // Completed because CoinInsertPanel doesn't reset its own UI back to
    // a fresh state after either - same reason ShowCoinPanel() below
    // always builds a new instance instead of reusing one.
    private void EmbedNoTimeCoinPanel()
    {
        _noTimeCoinPanel?.Dispose();
        var panel = new CoinInsertPanel(_api, _config, "pc_rental", large: true)
        {
            Left = 0,
            Top = 180
        };
        // Deferred via BeginInvoke: both events fire from inside this same
        // panel's own click/timer handlers, so disposing it synchronously
        // inside its own event would tear down the control mid-callback.
        panel.Cancelled += () => BeginInvoke(new Action(EmbedNoTimeCoinPanel));
        panel.Completed += (_) => BeginInvoke(new Action(EmbedNoTimeCoinPanel));
        _noTimeCoinPanel = panel;
        _noTimeView.Controls.Add(panel);
    }

    // Shows (or refreshes) the Member No-Time panel. Called both right
    // after a fresh zero-balance login (OnLoginClicked) and from every
    // status poll while a member is logged in at zero minutes (ShowLock) -
    // guarded so a same-member repeat call (the normal ~5s poll case)
    // doesn't recreate the embedded coin panel/redeem list and blow away
    // an in-progress coin insertion the customer is mid-way through.
    private void ShowNoTimeView(string username, int? knownPoints)
    {
        if (_noTimeView.Visible && _noTimeUsername == username)
        {
            return; // already showing for this member - leave it alone
        }
        _noTimeUsername = username;
        _coinPanel?.Dispose();
        _coinPanel = null;
        _homeView.Visible = false;
        _loginView.Visible = false;

        _noTimeTitleLabel.Text = $"WELCOME, {username.ToUpperInvariant()}";
        _noTimeBalanceLabel.Text = knownPoints.HasValue ? $"{knownPoints} POINTS" : "-- POINTS";
        // _noTimeView is a sibling of _centerPanel (added straight to the
        // Form's Controls, not to _centerPanel - see the field comment),
        // so it needs its own BringToFront: otherwise it sits behind the
        // always-Dock=Fill _wallpaperBox whenever a wallpaper is set, and
        // behind the opaque _centerPanel even without one. Every other
        // sub-view here (login, coin panel) lives INSIDE _centerPanel, so
        // hiding _homeView/_loginView was enough for them - _centerPanel
        // itself also has to be hidden explicitly for this one.
        _centerPanel.Visible = false;
        _noTimeView.Visible = true;
        _noTimeView.BringToFront();
        RepositionNoTimeView();
        EmbedNoTimeCoinPanel();
        _ = RefreshNoTimeRedeemAsync();
    }

    // Ported from Pages/RewardsPage.cs's RefreshAsync() - same balance +
    // redeem-rate-list + affordability logic, rendered into _noTimeRatesPanel
    // instead of a full page.
    private async Task RefreshNoTimeRedeemAsync()
    {
        var result = await _api.GetMemberPointsAsync(_config.Mac, _config.DeviceSecret);
        if (!_noTimeView.Visible || IsDisposed) return; // left the view while this was in flight

        _noTimeRatesPanel.Controls.Clear();
        if (result == null || !result.Success)
        {
            _noTimeBalanceLabel.Text = "-- POINTS";
            _noTimeRedeemStatusLabel.Text = result?.Message ?? "Could not load rewards.";
            return;
        }

        _noTimeBalanceLabel.Text = $"{result.Points} POINTS";
        var rates = result.RedeemRates ?? new List<RedeemRate>();
        _noTimeRedeemStatusLabel.Text = rates.Count == 0 ? "No promos set up yet." : "";

        foreach (var rate in rates)
        {
            var minutes = rate.RewardSeconds / 60;
            var row = new RoundedPanel { Width = 440, Height = 50, Margin = new Padding(0, 0, 0, 10), BackColor = Theme.Surface, CornerRadius = 8 };
            var label = new Label { Text = $"{rate.Points} pts  →  {minutes} min", ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 10), Left = 16, Top = 14, AutoSize = true };
            var claimButton = new CardButton { Text = "CLAIM", Width = 90, Height = 34, Left = 440 - 106, Top = 8, CornerRadius = 6, BackColor = Theme.Accent, Enabled = result.Points >= rate.Points };
            claimButton.Click += async (_, _) => await OnNoTimeClaimClicked(rate, claimButton);
            row.Controls.Add(label);
            row.Controls.Add(claimButton);
            _noTimeRatesPanel.Controls.Add(row);
        }
    }

    // Ported from Pages/RewardsPage.cs's OnClaimClicked().
    private async Task OnNoTimeClaimClicked(RedeemRate rate, CardButton claimButton)
    {
        claimButton.Enabled = false;
        var result = await _api.RedeemAsync(_config.Mac, _config.DeviceSecret, rate.Id);
        if (!_noTimeView.Visible || IsDisposed) return;

        if (result != null && result.Success)
        {
            _noTimeBalanceLabel.Text = $"{result.RemainingPoints} POINTS";
            foreach (Control c in _noTimeRatesPanel.Controls)
            {
                if (c is RoundedPanel row)
                {
                    foreach (Control rc in row.Controls)
                    {
                        if (rc is CardButton b) b.Enabled = false;
                    }
                }
            }
            await RefreshNoTimeRedeemAsync(); // re-evaluate affordability against the new balance
            // If this claim brought the balance above zero, the next
            // status poll (~5s) picks that up and unlocks normally (see
            // ShowLock) - no need to force a transition here.
        }
        else
        {
            MessageBox.Show(result?.Message ?? "Claim failed", "Rewards", MessageBoxButtons.OK, MessageBoxIcon.Error);
            claimButton.Enabled = true;
        }
    }

    // The only "cancel" affordance on this panel is logging the member
    // out entirely - there's nothing to fall back to since they got here
    // by successfully authenticating with zero balance, not by choosing
    // an option from Home.
    private async Task OnNoTimeCloseClicked()
    {
        await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
        ShowHomeView();
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

        _noTimeView.BackColor = Theme.Background;
        _noTimeCloseX.ForeColor = Theme.TextMuted;
        _noTimeTitleLabel.ForeColor = Theme.TextPrimary;
        _noTimeBalanceLabel.ForeColor = Theme.Accent;
        _noTimeMessageLabel.ForeColor = Theme.TextMuted;
        _noTimeRedeemTitleLabel.ForeColor = Theme.TextPrimary;
        _noTimeRedeemStatusLabel.ForeColor = Theme.TextMuted;
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

        // Make sure the No-Time panel doesn't get "stuck" visually once
        // the member logs out or the balance is topped up (this is the
        // one place both OnNoTimeCloseClicked and the poll-driven "member
        // no longer needs it" branch in ShowLock route back through).
        _noTimeCoinPanel?.Dispose();
        _noTimeCoinPanel = null;
        _noTimeView.Visible = false;
        _noTimeUsername = null;
        _centerPanel.Visible = true;

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

        // ShowNoTimeView()'s repeat-call guard (`_noTimeView.Visible &&
        // _noTimeUsername == username`) exists to avoid tearing down an
        // in-progress coin insertion on every ~5s poll while it's showing
        // - but that guard reads state this method never used to clear.
        // Without resetting it here, a member who redeems/unlocks/plays
        // and later runs out of time again in the SAME login session hits
        // that guard on their first zero-balance poll after the restart
        // and gets a stale panel back (old points balance, old claim
        // affordability, a leftover CoinInsertPanel) instead of a fresh
        // rebuild. Dispose the embedded coin panel and clear the tracked
        // username/visibility so the next ShowNoTimeView() call always
        // rebuilds from scratch.
        _noTimeCoinPanel?.Dispose();
        _noTimeCoinPanel = null;
        _noTimeView.Visible = false;
        _noTimeUsername = null;
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

        // A member logged in at zero minutes stays logged in (locked, not
        // logged out - see the matching GET /status change in
        // server/routes/rental.js), so this has to be checked on every
        // poll, not just right after a fresh login: they may have run out
        // mid-session, or the app may have restarted while they were
        // already at zero. ShowNoTimeView() itself no-ops on a repeat call
        // for the same member so this doesn't fight an in-progress coin
        // insertion. Checked BEFORE the "!Visible -> ShowHomeView()" fresh-
        // open fallback below (Form.Visible is still false at that point
        // on the very first poll after a restart) so a zero-balance member
        // discovered on app start lands on the No-Time panel, not Home.
        var isZeroBalanceMember = !string.IsNullOrEmpty(status.LoggedInUser) && status.MinutesRemaining <= 0;
        if (isZeroBalanceMember)
        {
            ShowNoTimeView(status.LoggedInUser!, status.LoggedInPoints);
        }
        else if (_noTimeView.Visible)
        {
            // Member added time, redeemed enough points, or logged out
            // elsewhere while this panel was showing - fall back to Home
            // (in practice the form itself is about to be hidden by the
            // caller once `locked` goes false, this just avoids leaving
            // the No-Time panel visible underneath in the meantime).
            ShowHomeView();
        }
        else if (!Visible)
        {
            ShowHomeView();
        }

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
            // Trimmed to match the canonical username the server returns
            // (server/routes/rental.js trims on login and GET /status
            // echoes back the trimmed value as LoggedInUser) - otherwise a
            // trailing space typed into the login form would make
            // ShowNoTimeView's repeat-call guard (_noTimeUsername ==
            // username) mismatch on the very next poll and force one
            // avoidable rebuild.
            var username = _usernameBox.Text.Trim();
            var result = await _api.MemberLoginAsync(_config.Mac, _config.DeviceSecret, username, _passwordBox.Text);
            if (result == null || !result.Success)
            {
                _loginErrorLabel.Text = result?.Message ?? "Login failed";
                return;
            }
            _passwordBox.Text = "";

            if (result.MinutesRemaining <= 0)
            {
                // Login now always succeeds regardless of balance (see the
                // matching server/routes/rental.js change) - a member with
                // nothing left shouldn't just sit on a blank screen waiting
                // for the next poll, show the No-Time panel immediately.
                // MemberLoginAsync's response has no points field (only
                // minutes_remaining), so pass null and let
                // RefreshNoTimeRedeemAsync fetch the real balance.
                ShowNoTimeView(username, null);
            }
            // Otherwise the next status poll (within ~5s) will pick up the
            // newly-unlocked state and transition away from this screen -
            // no need to duplicate that logic here.
        }
        finally
        {
            _loginButton.Enabled = true;
        }
    }

    // Staff Access stays reachable but out of the way (small corner text
    // link, matching the mockup's "Staff / Admin" corner link). Two
    // completely different authenticated flows live behind this one link
    // now, gated by two different passwords (rental_app_password for
    // Force-Unlock/Pause vs. the separate rental_admin_panel_password for
    // the real Admin Panel), so an upfront 3-way choice picks which one
    // to run before either password is ever asked for - they must not be
    // conflated into a single prompt. The Force-Unlock/Pause branch below
    // (Yes) is completely unchanged from before this task.
    public async Task OnStaffClicked()
    {
        var choice = MessageBox.Show(
            "Staff Access (Force Unlock / Pause) or Admin Panel?\n\nYes = Staff Access, No = Admin Panel, Cancel to close.",
            "Staff Access", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
        if (choice == DialogResult.Cancel) return;

        if (choice == DialogResult.No)
        {
            await OnAdminPanelClicked();
            return;
        }

        var password = PromptDialog.Show("Staff Access", "Enter the app password:", isPassword: true);
        if (string.IsNullOrEmpty(password)) return;

        var action = MessageBox.Show(
            "Force Unlock now (temporary, re-locks on the next status check)?\n\nChoose No to Pause instead - suspends enforcement until resumed from here or from the admin panel.",
            "Staff Access", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
        if (action == DialogResult.Cancel) return;

        if (action == DialogResult.Yes)
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

    // Real Admin Panel entry point, reached from the Staff / Admin corner
    // link's "Admin Panel" choice above. Mirrors CafeHomeForm's own
    // OnAdminPanelClicked() (same AdminLoginForm -> AdminPanelPage flow,
    // same host Form setup) - kept as a small duplicate here rather than
    // extracting a shared helper, since there's no existing shared static
    // helper class between the two forms and this is the only piece they'd
    // need to share.
    private async Task OnAdminPanelClicked()
    {
        using var loginForm = new AdminLoginForm(_api, _config);
        if (loginForm.ShowDialog() != DialogResult.OK || string.IsNullOrEmpty(loginForm.VerifiedPassword))
        {
            return;
        }

        using var host = new Form
        {
            Text = "Admin Panel",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterScreen,
            MaximizeBox = false,
            MinimizeBox = false,
            TopMost = true,
            ClientSize = new Size(720, 640),
        };
        var adminPage = new AdminPanelPage(_api, _config, _prefs, loginForm.VerifiedPassword);
        adminPage.Dock = DockStyle.Fill;
        host.Controls.Add(adminPage);
        host.ShowDialog();
    }
}
