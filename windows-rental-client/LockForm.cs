using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

// Full-screen branded locked splash (V1.0.0 mockup rebuild) - reuses
// the Lock Screen Logo/Wallpaper/Announcement settings already built in
// the admin panel (public/admin/rental > Settings), fetched fresh on
// every status poll via StatusResponse so a branding change in admin
// shows up here within one poll interval, no client restart needed.
//
// Default view is the mockup's two-card layout (Guest / Member Login);
// each swaps the panel's content in place rather than opening a
// separate window, so the keyboard-hook/topmost/borderless lock stays
// intact throughout every sub-view - same principle the original menu-
// based layout already used, just restyled.
public class LockForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly KeyboardBlocker _keyboardBlocker = new();
    private readonly System.Windows.Forms.Timer _clockTimer;

    private PictureBox _wallpaperBox = null!;

    // Header
    private Label _pcNameLabel = null!;
    private Label _statusDotLabel = null!;
    private Label _clockLabel = null!;

    private Panel _centerPanel = null!;
    private PictureBox _logoBox = null!;
    private Label _welcomeLabel = null!;
    private Label _cafeNameLabel = null!;
    private Label _announcementLabel = null!;

    // Home view (two cards)
    private Panel _homeView = null!;
    private RoundedPanel _guestCard = null!;
    private RoundedPanel _memberCard = null!;

    // Footer row (Register / How to Play / Call Staff)
    private FlowLayoutPanel _footerRow = null!;

    // Status footer (Server/Secure/Network)
    private Label _serverStatusLabel = null!;
    private Label _networkStatusLabel = null!;

    // Login sub-view controls
    private Panel _loginView = null!;
    private TextBox _usernameBox = null!;
    private TextBox _passwordBox = null!;
    private Button _loginButton = null!;
    private Button _loginBackButton = null!;
    private Label _loginErrorLabel = null!;

    // Coin-insert sub-view (Insert Coins / Create Account), built fresh
    // each time it's opened so it always starts from a clean state.
    private CoinInsertPanel? _coinPanel;

    private bool _connected = true;
    private string? _instructionsText;

    public LockForm(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        _clockTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        _clockTimer.Tick += (_, _) => _clockLabel.Text = DateTime.Now.ToString("hh:mm tt\nMMM d, yyyy");
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

        _wallpaperBox = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.StretchImage };
        Controls.Add(_wallpaperBox);

        BuildHeader();
        BuildCenter();
        BuildFooter();

        FormClosing += (_, e) => { /* prevent Alt+F4 closing the lock while it's supposed to be showing */
            if (Visible) e.Cancel = true;
        };

        _clockTimer.Start();
        _clockLabel.Text = DateTime.Now.ToString("hh:mm tt\nMMM d, yyyy");
        ApplyTheme();
        ShowHomeView();
    }

    private void BuildHeader()
    {
        var header = new Panel { Dock = DockStyle.Top, Height = 70 };
        Controls.Add(header);

        _pcNameLabel = new Label { Font = new Font("Segoe UI", 13, FontStyle.Bold), AutoSize = true, Left = 24, Top = 22 };
        header.Controls.Add(_pcNameLabel);

        _statusDotLabel = new Label { Font = new Font("Segoe UI", 10, FontStyle.Bold), AutoSize = true, Top = 26 };
        header.Controls.Add(_statusDotLabel);

        _clockLabel = new Label { Font = new Font("Segoe UI", 10), AutoSize = false, Width = 220, Height = 44, TextAlign = ContentAlignment.MiddleRight, Top = 12 };
        header.Controls.Add(_clockLabel);
        header.Resize += (_, _) => { _clockLabel.Left = header.Width - _clockLabel.Width - 24; };
        header.Resize += (_, _) => RepositionStatusDot();

        header.BringToFront();
        _wallpaperBox.SendToBack();
    }

    private void RepositionStatusDot()
    {
        _statusDotLabel.Left = _pcNameLabel.Right + 14;
    }

    private void BuildCenter()
    {
        _centerPanel = new Panel { Width = 900, Height = 560 };
        Controls.Add(_centerPanel);
        _centerPanel.BringToFront();

        _logoBox = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Width = 140, Height = 70, Left = (_centerPanel.Width - 140) / 2, Top = 0 };
        _centerPanel.Controls.Add(_logoBox);

        _welcomeLabel = new Label { Text = "WELCOME TO", Font = new Font("Segoe UI", 11, FontStyle.Bold), AutoSize = false, Width = _centerPanel.Width, Height = 24, Top = 82, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_welcomeLabel);

        _cafeNameLabel = new Label { Font = new Font("Segoe UI", 24, FontStyle.Bold), AutoSize = false, Width = _centerPanel.Width, Height = 44, Top = 106, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_cafeNameLabel);

        _announcementLabel = new Label { Font = new Font("Segoe UI", 9), AutoSize = false, Width = _centerPanel.Width - 80, Height = 30, Left = 40, Top = 154, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_announcementLabel);

        BuildHomeView();
        BuildLoginView();
    }

    private void BuildHomeView()
    {
        _homeView = new Panel { Left = 0, Top = 200, Width = _centerPanel.Width, Height = 320 };
        _centerPanel.Controls.Add(_homeView);

        var cardWidth = 420;
        var cardHeight = 300;
        var gap = 40;
        var totalWidth = cardWidth * 2 + gap;
        var startLeft = (_homeView.Width - totalWidth) / 2;

        _guestCard = BuildCard("GUEST", "Play without an account", "Insert credits and start playing", "CONTINUE AS GUEST",
            startLeft, cardWidth, cardHeight, () => ShowCoinPanel("pc_rental"));

        _memberCard = BuildCard("MEMBER LOGIN", "Login to your account", "Save time, earn points, unlock rewards", "LOGIN",
            startLeft + cardWidth + gap, cardWidth, cardHeight, ShowLoginView);

        _homeView.Controls.Add(_guestCard);
        _homeView.Controls.Add(_memberCard);
    }

    // Every child control in the card needs the same click handler as the
    // card itself, since a click on a label/button doesn't bubble up to
    // the parent Panel's own Click event in WinForms - onClick is applied
    // directly to the card and every child, rather than trying to
    // forward through Control.OnClick (protected, not callable from here).
    private RoundedPanel BuildCard(string title, string subtitle, string description, string buttonText, int left, int width, int height, Action onClick)
    {
        var card = new RoundedPanel { Left = left, Top = 0, Width = width, Height = height, Cursor = Cursors.Hand, CornerRadius = 16 };

        var titleLabel = new Label { Text = title, Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = false, Width = width, Height = 30, Top = 90, TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
        var subtitleLabel = new Label { Text = subtitle, Font = new Font("Segoe UI", 10, FontStyle.Bold), AutoSize = false, Width = width, Height = 22, Top = 130, TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
        var descLabel = new Label { Text = description, Font = new Font("Segoe UI", 8), AutoSize = false, Width = width, Height = 20, Top = 152, TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
        var button = new CardButton { Text = buttonText, Width = width - 60, Height = 42, Left = 30, Top = 220, CornerRadius = 8 };

        card.Controls.Add(titleLabel);
        card.Controls.Add(subtitleLabel);
        card.Controls.Add(descLabel);
        card.Controls.Add(button);

        card.Click += (_, _) => onClick();
        titleLabel.Click += (_, _) => onClick();
        subtitleLabel.Click += (_, _) => onClick();
        descLabel.Click += (_, _) => onClick();
        button.Click += (_, _) => onClick();

        return card;
    }

    private void BuildLoginView()
    {
        _loginView = new Panel { Left = 0, Top = 200, Width = _centerPanel.Width, Height = 320, Visible = false };
        _centerPanel.Controls.Add(_loginView);

        var fieldWidth = 320;
        var fieldLeft = (_centerPanel.Width - fieldWidth) / 2;

        _usernameBox = new TextBox { PlaceholderText = "Username", Width = fieldWidth, Left = fieldLeft, Top = 20, Font = new Font("Segoe UI", 11) };
        _loginView.Controls.Add(_usernameBox);

        _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Width = fieldWidth, Left = fieldLeft, Top = 60, Font = new Font("Segoe UI", 11) };
        _loginView.Controls.Add(_passwordBox);

        _loginButton = new CardButton { Text = "LOG IN", Width = fieldWidth, Height = 42, Left = fieldLeft, Top = 100, CornerRadius = 8 };
        _loginButton.Click += async (_, _) => await OnLoginClicked();
        _loginView.Controls.Add(_loginButton);

        _loginErrorLabel = new Label { ForeColor = Color.OrangeRed, Width = fieldWidth, Left = fieldLeft, Top = 150, TextAlign = ContentAlignment.MiddleCenter, Height = 24 };
        _loginView.Controls.Add(_loginErrorLabel);

        _loginBackButton = new Button { Text = "Back", Width = fieldWidth, Left = fieldLeft, Top = 184, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 } };
        _loginBackButton.Click += (_, _) => ShowHomeView();
        _loginView.Controls.Add(_loginBackButton);
    }

    private void BuildFooter()
    {
        _footerRow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false,
            Width = 700, Height = 60
        };
        Controls.Add(_footerRow);
        _footerRow.Location = new Point((Bounds.Width - _footerRow.Width) / 2, Bounds.Height - 180);

        var registerBtn = SmallFooterButton("REGISTER\nAS MEMBER");
        registerBtn.Click += (_, _) => ShowCoinPanel("pc_rental_create_account");
        var howToBtn = SmallFooterButton("HOW TO PLAY\n(INSTRUCTIONS)");
        howToBtn.Click += (_, _) => ShowInstructions();
        var callStaffBtn = SmallFooterButton("NEED HELP?\nCALL STAFF");
        callStaffBtn.Click += async (_, _) => await OnCallStaffClicked();

        _footerRow.Controls.Add(registerBtn);
        _footerRow.Controls.Add(howToBtn);
        _footerRow.Controls.Add(callStaffBtn);
        _footerRow.BringToFront();

        var statusFooter = new Panel { Dock = DockStyle.Bottom, Height = 44 };
        Controls.Add(statusFooter);
        _serverStatusLabel = new Label { Font = new Font("Segoe UI", 8, FontStyle.Bold), AutoSize = true, Left = 24, Top = 14 };
        statusFooter.Controls.Add(_serverStatusLabel);
        var secureLabel = new Label { Text = "SECURE ENVIRONMENT - MONITORED & PROTECTED", Font = new Font("Segoe UI", 8), AutoSize = true, Top = 14 };
        statusFooter.Controls.Add(secureLabel);
        statusFooter.Resize += (_, _) => { secureLabel.Left = (statusFooter.Width - secureLabel.Width) / 2; };
        _networkStatusLabel = new Label { Font = new Font("Segoe UI", 8, FontStyle.Bold), AutoSize = true, Top = 14 };
        statusFooter.Controls.Add(_networkStatusLabel);
        statusFooter.Resize += (_, _) => { _networkStatusLabel.Left = statusFooter.Width - _networkStatusLabel.Width - 100; };
        var versionLabel = new Label { Text = "v1.0.0", Font = new Font("Segoe UI", 8), AutoSize = true, Top = 14 };
        statusFooter.Controls.Add(versionLabel);
        statusFooter.Resize += (_, _) => { versionLabel.Left = statusFooter.Width - 60; };
        statusFooter.BringToFront();

        // Small, unobtrusive - not part of the mockup's own customer-
        // facing footer row (that's Register/How to Play/Call Staff),
        // this is the pre-existing password-gated force-unlock/pause for
        // staff, kept out of the way in the corner.
        var staffButton = new Button { Text = "Staff", Width = 70, Height = 26, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 } };
        staffButton.Click += async (_, _) => await OnStaffClicked();
        Controls.Add(staffButton);
        staffButton.Location = new Point(Bounds.Width - 90, 20);
        staffButton.BringToFront();
    }

    private CardButton SmallFooterButton(string text)
    {
        return new CardButton
        {
            Text = text, Width = 180, Height = 56, Margin = new Padding(10, 0, 10, 0),
            Font = new Font("Segoe UI", 8, FontStyle.Bold), CornerRadius = 8
        };
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
        _pcNameLabel.ForeColor = Theme.TextPrimary;
        _clockLabel.ForeColor = Theme.TextMuted;
        _welcomeLabel.ForeColor = Theme.TextMuted;
        _cafeNameLabel.ForeColor = Theme.TextPrimary;
        _announcementLabel.ForeColor = Theme.TextMuted;
        _guestCard.BackColor = Theme.Surface;
        _guestCard.BorderColor = Theme.Accent;
        _memberCard.BackColor = Theme.Surface;
        _memberCard.BorderColor = Theme.AccentAlt;
        foreach (Control c in _guestCard.Controls)
        {
            if (c is Label l) l.ForeColor = Theme.TextPrimary;
            if (c is CardButton b) { b.BackColor = Theme.Accent; b.ForeColor = Color.White; }
        }
        foreach (Control c in _memberCard.Controls)
        {
            if (c is Label l) l.ForeColor = Theme.TextPrimary;
            if (c is CardButton b) { b.BackColor = Theme.AccentAlt; b.ForeColor = Color.White; }
        }
        _loginErrorLabel.ForeColor = Theme.Danger;
        _loginButton.BackColor = Theme.Accent;
        _usernameBox.BackColor = Theme.Surface;
        _usernameBox.ForeColor = Theme.TextPrimary;
        _passwordBox.BackColor = Theme.Surface;
        _passwordBox.ForeColor = Theme.TextPrimary;
        foreach (Control c in _footerRow.Controls)
        {
            if (c is CardButton b) { b.BackColor = Theme.Surface; b.ForeColor = Theme.TextPrimary; }
        }
        RefreshStatusLabels();
    }

    private void RefreshStatusLabels()
    {
        _serverStatusLabel.Text = _connected ? "SERVER STATUS: ONLINE" : "SERVER STATUS: OFFLINE";
        _serverStatusLabel.ForeColor = _connected ? Theme.Success : Theme.Danger;
        _networkStatusLabel.Text = _connected ? "NETWORK: CONNECTED" : "NETWORK: DISCONNECTED";
        _networkStatusLabel.ForeColor = _connected ? Theme.Success : Theme.Danger;
    }

    // Called by StatusPoller's ConnectionLost/recovered signal via
    // Program.cs, so the status footer reflects reality instead of
    // always claiming "Online."
    public void SetConnected(bool connected)
    {
        if (_connected == connected) return;
        _connected = connected;
        RefreshStatusLabels();
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
        _centerPanel.Top = (Bounds.Height - _centerPanel.Height) / 2 - 40;
        RepositionStatusDot();
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

        _coinPanel = new CoinInsertPanel(_api, _config, mode) { Left = (_centerPanel.Width - 280) / 2, Top = 20 };
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

    public void ShowLock(StatusResponse status)
    {
        _pcNameLabel.Text = status.PcName;
        _statusDotLabel.Text = status.Locked ? "● LOCKED" : "● AVAILABLE";
        _statusDotLabel.ForeColor = status.Locked ? Theme.Danger : Theme.Success;
        RepositionStatusDot();
        _cafeNameLabel.Text = string.IsNullOrWhiteSpace(status.PcName) ? "STARKFI ESPORTS CAFÉ" : status.PcName;
        _announcementLabel.Text = status.LockAnnouncement ?? "";
        _instructionsText = status.InstructionsText;
        LoadImageAsync(_wallpaperBox, status.WallpaperUrl);
        LoadImageAsync(_logoBox, status.LogoUrl);
        if (!Visible) ShowHomeView();
        Show();
        _keyboardBlocker.Install();
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        RecenterHomeView();
        Activate();
    }

    private async void LoadImageAsync(PictureBox box, string? url)
    {
        if (string.IsNullOrEmpty(url)) { box.Image = null; return; }
        try
        {
            var fullUrl = url.StartsWith("http") ? url : _config.ServerUrl.TrimEnd('/') + url;
            using var client = new HttpClient();
            var bytes = await client.GetByteArrayAsync(fullUrl);
            using var ms = new MemoryStream(bytes);
            box.Image = Image.FromStream(ms);
        }
        catch
        {
            // Missing/unreachable branding image shouldn't block the lock
            // screen from showing - just leave that box blank.
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

    // Staff Access stays reachable but out of the way (small corner
    // button, not part of the mockup's own customer-facing footer row) -
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
