namespace StarkFiRentalClient;

// Full-screen branded locked splash - reuses the Lock Screen Logo/
// Wallpaper/Announcement settings already built in the admin panel
// (public/admin/rental > Settings), fetched fresh on every status poll
// via StatusResponse so a branding change in admin shows up here within
// one poll interval, no client restart needed.
public class LockForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly KeyboardBlocker _keyboardBlocker = new();

    private PictureBox _wallpaperBox = null!;
    private PictureBox _logoBox = null!;
    private Label _pcNameLabel = null!;
    private Label _announcementLabel = null!;
    private Label _instructionLabel = null!;
    private TextBox _usernameBox = null!;
    private TextBox _passwordBox = null!;
    private Button _loginButton = null!;
    private Label _loginErrorLabel = null!;
    private Button _staffButton = null!;

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

        var panel = new Panel { Width = 420, Height = 420, BackColor = Color.FromArgb(200, 0, 0, 0) };
        panel.Left = (Bounds.Width - panel.Width) / 2;
        panel.Top = (Bounds.Height - panel.Height) / 2;
        Controls.Add(panel);
        panel.BringToFront();

        _logoBox = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Width = 160, Height = 80, Left = (panel.Width - 160) / 2, Top = 16 };
        panel.Controls.Add(_logoBox);

        _pcNameLabel = new Label { Text = "", ForeColor = Color.White, Font = new Font("Segoe UI", 14, FontStyle.Bold), AutoSize = false, Width = panel.Width, Height = 30, Top = 100, TextAlign = ContentAlignment.MiddleCenter };
        panel.Controls.Add(_pcNameLabel);

        _announcementLabel = new Label { Text = "", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 9), AutoSize = false, Width = panel.Width - 40, Height = 40, Left = 20, Top = 132, TextAlign = ContentAlignment.MiddleCenter };
        panel.Controls.Add(_announcementLabel);

        _usernameBox = new TextBox { PlaceholderText = "Username", Width = 260, Left = (panel.Width - 260) / 2, Top = 190 };
        panel.Controls.Add(_usernameBox);

        _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Width = 260, Left = (panel.Width - 260) / 2, Top = 224 };
        panel.Controls.Add(_passwordBox);

        _loginButton = new Button { Text = "Log In", Width = 260, Left = (panel.Width - 260) / 2, Top = 258, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _loginButton.Click += async (_, _) => await OnLoginClicked();
        panel.Controls.Add(_loginButton);

        _loginErrorLabel = new Label { ForeColor = Color.OrangeRed, Width = panel.Width - 40, Left = 20, Top = 292, TextAlign = ContentAlignment.MiddleCenter, Height = 24 };
        panel.Controls.Add(_loginErrorLabel);

        _instructionLabel = new Label { Text = "Insert coins or see staff to add time", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 9), AutoSize = false, Width = panel.Width - 40, Left = 20, Top = 324, TextAlign = ContentAlignment.MiddleCenter };
        panel.Controls.Add(_instructionLabel);

        _staffButton = new Button { Text = "Staff", Width = 90, Height = 30, Left = Bounds.Width - 110, Top = Bounds.Height - 50, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _staffButton.Click += async (_, _) => await OnStaffClicked();
        Controls.Add(_staffButton);
        _staffButton.BringToFront();

        FormClosing += (_, e) => { /* prevent Alt+F4 closing the lock while it's supposed to be showing */
            if (Visible) e.Cancel = true;
        };
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
        var password = PromptDialog.Show("Staff Override", "Enter the app password:", isPassword: true);
        if (string.IsNullOrEmpty(password)) return;

        var result = await _api.StaffOverrideAsync(_config.Mac, _config.DeviceSecret, password);
        if (result == null || !result.Success)
        {
            MessageBox.Show(result?.Message ?? "Override failed", "Staff Override", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        // Purely local, temporary unlock - server-side credit is
        // untouched (see server/routes/rental.js's staff-override route
        // comment). The very next status poll will re-lock it again
        // unless real credit exists, which is the intended "quick peek/
        // fix something" fail-safe, not a way to grant free time.
        HideLock();
    }
}
