namespace StarkFiRentalClient;

// Full-screen branded locked splash - reuses the Lock Screen Logo/
// Wallpaper/Announcement settings already built in the admin panel
// (public/admin/rental > Settings), fetched fresh on every status poll
// via StatusResponse so a branding change in admin shows up here within
// one poll interval, no client restart needed.
//
// Default view is a 3-button menu (Insert Coins / Create Account /
// Log In); each swaps the panel's content in place rather than opening
// a separate window, so the keyboard-hook/topmost/borderless lock stays
// intact throughout every sub-view.
public class LockForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly KeyboardBlocker _keyboardBlocker = new();

    private PictureBox _wallpaperBox = null!;
    private Panel _centerPanel = null!;
    private PictureBox _logoBox = null!;
    private Label _pcNameLabel = null!;
    private Label _announcementLabel = null!;
    private Button _staffButton = null!;

    // Menu view controls
    private Panel _menuView = null!;
    private Button _insertCoinsButton = null!;
    private Button _createAccountButton = null!;
    private Button _loginMenuButton = null!;
    private Label _instructionLabel = null!;

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

    public LockForm(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        BuildUi();
    }

    private void BuildUi()
    {
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        BackColor = Color.FromArgb(12, 143, 109); // StarkFi teal fallback (--brand-teal)
        StartPosition = FormStartPosition.Manual;
        Bounds = Screen.PrimaryScreen!.Bounds;
        ShowInTaskbar = false;
        KeyPreview = true;

        _wallpaperBox = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.StretchImage };
        Controls.Add(_wallpaperBox);

        _centerPanel = new Panel { Width = 420, Height = 460, BackColor = Color.FromArgb(200, 0, 0, 0) };
        _centerPanel.Left = (Bounds.Width - _centerPanel.Width) / 2;
        _centerPanel.Top = (Bounds.Height - _centerPanel.Height) / 2;
        Controls.Add(_centerPanel);
        _centerPanel.BringToFront();

        _logoBox = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Width = 160, Height = 80, Left = (_centerPanel.Width - 160) / 2, Top = 16 };
        _centerPanel.Controls.Add(_logoBox);

        _pcNameLabel = new Label { Text = "", ForeColor = Color.White, Font = new Font("Segoe UI", 14, FontStyle.Bold), AutoSize = false, Width = _centerPanel.Width, Height = 30, Top = 100, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_pcNameLabel);

        _announcementLabel = new Label { Text = "", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 9), AutoSize = false, Width = _centerPanel.Width - 40, Height = 40, Left = 20, Top = 132, TextAlign = ContentAlignment.MiddleCenter };
        _centerPanel.Controls.Add(_announcementLabel);

        BuildMenuView();
        BuildLoginView();

        _staffButton = new Button { Text = "Staff", Width = 90, Height = 30, Left = Bounds.Width - 110, Top = Bounds.Height - 50, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _staffButton.Click += async (_, _) => await OnStaffClicked();
        Controls.Add(_staffButton);
        _staffButton.BringToFront();

        FormClosing += (_, e) => { /* prevent Alt+F4 closing the lock while it's supposed to be showing */
            if (Visible) e.Cancel = true;
        };

        ShowMenuView();
    }

    private void BuildMenuView()
    {
        _menuView = new Panel { Left = 0, Top = 180, Width = _centerPanel.Width, Height = 220 };
        _centerPanel.Controls.Add(_menuView);

        _insertCoinsButton = new Button { Text = "Insert Coins", Width = 260, Height = 34, Left = (_centerPanel.Width - 260) / 2, Top = 0, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _insertCoinsButton.Click += (_, _) => ShowCoinPanel("pc_rental");
        _menuView.Controls.Add(_insertCoinsButton);

        _createAccountButton = new Button { Text = "Create Account", Width = 260, Height = 34, Left = (_centerPanel.Width - 260) / 2, Top = 44, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _createAccountButton.Click += (_, _) => ShowCoinPanel("pc_rental_create_account");
        _menuView.Controls.Add(_createAccountButton);

        _loginMenuButton = new Button { Text = "Log In", Width = 260, Height = 34, Left = (_centerPanel.Width - 260) / 2, Top = 88, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _loginMenuButton.Click += (_, _) => ShowLoginView();
        _menuView.Controls.Add(_loginMenuButton);

        _instructionLabel = new Label { Text = "Insert coins or see staff to add time", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 9), AutoSize = false, Width = _menuView.Width - 40, Left = 20, Top = 140, TextAlign = ContentAlignment.MiddleCenter };
        _menuView.Controls.Add(_instructionLabel);
    }

    private void BuildLoginView()
    {
        _loginView = new Panel { Left = 0, Top = 180, Width = _centerPanel.Width, Height = 220, Visible = false };
        _centerPanel.Controls.Add(_loginView);

        _usernameBox = new TextBox { PlaceholderText = "Username", Width = 260, Left = (_centerPanel.Width - 260) / 2, Top = 0 };
        _loginView.Controls.Add(_usernameBox);

        _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Width = 260, Left = (_centerPanel.Width - 260) / 2, Top = 34 };
        _loginView.Controls.Add(_passwordBox);

        _loginButton = new Button { Text = "Log In", Width = 260, Left = (_centerPanel.Width - 260) / 2, Top = 68, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _loginButton.Click += async (_, _) => await OnLoginClicked();
        _loginView.Controls.Add(_loginButton);

        _loginErrorLabel = new Label { ForeColor = Color.OrangeRed, Width = _loginView.Width - 40, Left = 20, Top = 102, TextAlign = ContentAlignment.MiddleCenter, Height = 24 };
        _loginView.Controls.Add(_loginErrorLabel);

        _loginBackButton = new Button { Text = "Back", Width = 260, Left = (_centerPanel.Width - 260) / 2, Top = 136, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _loginBackButton.Click += (_, _) => ShowMenuView();
        _loginView.Controls.Add(_loginBackButton);
    }

    private void ShowMenuView()
    {
        _coinPanel?.Dispose();
        _coinPanel = null;
        _loginErrorLabel.Text = "";
        _usernameBox.Text = "";
        _passwordBox.Text = "";
        _menuView.Visible = true;
        _loginView.Visible = false;
    }

    private void ShowLoginView()
    {
        _menuView.Visible = false;
        _loginView.Visible = true;
    }

    private void ShowCoinPanel(string mode)
    {
        _menuView.Visible = false;
        _loginView.Visible = false;

        _coinPanel = new CoinInsertPanel(_api, _config, mode) { Left = (_centerPanel.Width - 280) / 2, Top = 180 };
        _coinPanel.Cancelled += ShowMenuView;
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
        // instead" fallback both just return to the menu - the next
        // status poll (~5s) picks up the newly-unlocked state on its
        // own, no need to duplicate that transition here.
        ShowMenuView();
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
        _announcementLabel.Text = status.LockAnnouncement ?? "";
        LoadImageAsync(_wallpaperBox, status.WallpaperUrl);
        LoadImageAsync(_logoBox, status.LogoUrl);
        if (!Visible) ShowMenuView();
        Show();
        _keyboardBlocker.Install();
        WindowState = FormWindowState.Maximized;
        TopMost = true;
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

    private async Task OnStaffClicked()
    {
        var password = PromptDialog.Show("Staff Access", "Enter the app password:", isPassword: true);
        if (string.IsNullOrEmpty(password)) return;

        // Two different things staff might want, both gated by the same
        // password: a quick unlock that never touches server state (Yes),
        // or a real maintenance pause recorded server-side until someone
        // explicitly resumes it (No) - see the doc comments on
        // POST /staff-override vs POST /pause in server/routes/rental.js.
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
                return;
            }
            // The next status poll picks up paused:true and Program.cs's
            // HandleStatus swaps to the paused indicator - no need to
            // duplicate that transition here.
        }
    }
}
