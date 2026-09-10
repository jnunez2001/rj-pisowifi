using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// The real Admin Panel (mockup) - replaces CafeHomeForm's old temporary
// Force-Unlock/Pause placeholder for the dropdown's "Admin Panel" item.
// Gated by AdminLoginForm (a separate, narrower rental_admin_panel_password,
// never the site's real admin password) - the verified password is passed
// in here and re-sent on every admin-panel/* call below, since the server
// re-checks it per-request rather than issuing a session token.
//
// Deliberately dark regardless of the app's active Theme (LightGaming/
// NeonPurple/Dark) - the mockup's Admin Panel is intentionally a visually
// distinct "you are now in a different, more powerful mode" screen, so this
// hardcodes its own small fixed dark palette rather than hooking into
// Theme.Changed. Simpler and more predictable than trying to keep an
// "always dark" screen correct against a live theme-swap event, and the
// mockup's own intent is a fixed look, not a theme-following one.
//
// Layout: one AutoScroll content panel (_scroll, Dock=Fill) holding six
// stacked "card" sections (RoundedPanel, CornerRadius=8, 660 wide, Left=10),
// laid out top-to-bottom by a running `y` cursor computed once in BuildUi.
// Exact geometry per section is documented on each Build*Section method.
public class AdminPanelPage : UserControl
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly ClientPreferences _prefs;
    private readonly string _password;

    // Fixed dark palette - independent of UI/Theme.cs on purpose (see class
    // comment above).
    private static readonly Color DarkBg = Color.FromArgb(18, 18, 24);
    private static readonly Color DarkSurface = Color.FromArgb(28, 28, 36);
    private static readonly Color DarkBorder = Color.FromArgb(52, 52, 64);
    private static readonly Color DarkTextPrimary = Color.White;
    private static readonly Color DarkTextMuted = Color.FromArgb(150, 150, 168);
    private static readonly Color DarkAccent = Color.FromArgb(66, 133, 244);
    private static readonly Color DarkDanger = Color.FromArgb(239, 83, 80);
    private static readonly Color DarkSuccess = Color.FromArgb(102, 187, 106);

    private const int CardWidth = 660;
    private const int CardLeft = 10;

    private Panel _scroll = null!;
    private System.Windows.Forms.Timer? _pingTimer;

    // Server Connection
    private Label _connectionUrlLabel = null!;
    private Label _connectionStatusLabel = null!;
    private Label _pingLabel = null!;

    // Payment & Time Rules (read-only)
    private Label _minCreditLabel = null!;
    private Label _idleShutdownLabel = null!;

    // Guest -> Member Conversion
    private CheckBox _guestConversionCheck = null!;
    private NumericUpDown _guestConversionMinutes = null!;
    private Label _conversionStatusLabel = null!;
    private bool _loadedGuestConversionEnabled;
    private int _loadedGuestConversionMinutes;

    // Points Redemption Tiers
    private FlowLayoutPanel _ratesList = null!;
    private NumericUpDown _newRatePoints = null!;
    private NumericUpDown _newRateSeconds = null!;
    private Label _ratesStatusLabel = null!;

    // Security
    private CheckBox _taskMgrCheck = null!;
    private CheckBox _usbCheck = null!;
    private CheckBox _protectFolderCheck = null!;
    private Label _securityStatusLabel = null!;
    private bool _loadingSecurity = true; // guards CheckedChanged from firing writes while we set initial state

    // Client Status
    private CheckBox _clientEnabledCheck = null!;

    public AdminPanelPage(RentalApiClient api, ClientConfig config, ClientPreferences prefs, string password)
    {
        _api = api;
        _config = config;
        _prefs = prefs;
        _password = password;

        Dock = DockStyle.Fill;
        BackColor = DarkBg;

        BuildUi();
        LoadSecuritySection();
        _ = LoadSettingsAsync();

        UpdateConnectionIndicator(ConnectionStatus.IsConnected);
        ConnectionStatus.Changed += OnConnectionStatusChanged;
        _pingTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        _pingTimer.Tick += async (_, _) => await RefreshPingAsync();
        _pingTimer.Start();
        _ = RefreshPingAsync();

        Disposed += (_, _) =>
        {
            ConnectionStatus.Changed -= OnConnectionStatusChanged;
            _pingTimer?.Stop();
            _pingTimer?.Dispose();
        };
    }

    private void BuildUi()
    {
        _scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = DarkBg };
        Controls.Add(_scroll);

        var y = 16;
        y = BuildServerConnectionSection(y);
        y = BuildPaymentRulesSection(y);
        y = BuildGuestConversionSection(y);
        y = BuildRedeemTiersSection(y);
        y = BuildSecuritySection(y);
        BuildClientStatusSection(y);
    }

    // ---- shared card/label helpers ----

    private RoundedPanel AddCard(int top, int height)
    {
        var card = new RoundedPanel
        {
            Left = CardLeft, Top = top, Width = CardWidth, Height = height,
            CornerRadius = 8, BackColor = DarkSurface, BorderColor = DarkBorder, BorderWidth = 1,
        };
        _scroll.Controls.Add(card);
        return card;
    }

    private static Label AddHeader(Control parent, string text)
    {
        var label = new Label
        {
            Text = text, Font = new Font("Segoe UI", 11, FontStyle.Bold),
            ForeColor = DarkTextPrimary, AutoSize = false,
            Left = 16, Top = 12, Width = CardWidth - 32, Height = 22,
        };
        parent.Controls.Add(label);
        return label;
    }

    // ---- Section 1: Server Connection ----
    // Card: Top=y, Height=110.
    //   header                Top=12 H=22 -> bottom=34
    //   _connectionUrlLabel   Top=40 H=20 -> bottom=60
    //   _connectionStatusLabel Top=64 H=22, Left=16 W=300 -> bottom=86
    //   _pingLabel            Top=64 H=22, Left=336 W=300 -> bottom=86
    private int BuildServerConnectionSection(int y)
    {
        const int height = 110;
        var card = AddCard(y, height);
        AddHeader(card, "SERVER CONNECTION");

        _connectionUrlLabel = new Label
        {
            Text = $"Server: {_config.ServerUrl}", ForeColor = DarkTextMuted,
            AutoSize = false, Left = 16, Top = 40, Width = CardWidth - 32, Height = 20,
        };
        card.Controls.Add(_connectionUrlLabel);

        _connectionStatusLabel = new Label
        {
            AutoSize = false, Left = 16, Top = 64, Width = 300, Height = 22,
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
        };
        card.Controls.Add(_connectionStatusLabel);

        _pingLabel = new Label
        {
            AutoSize = false, Left = 336, Top = 64, Width = 300, Height = 22,
            ForeColor = DarkTextMuted,
        };
        card.Controls.Add(_pingLabel);

        return y + height + 16;
    }

    private void OnConnectionStatusChanged(bool connected)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(new Action(() => UpdateConnectionIndicator(connected)));
    }

    private void UpdateConnectionIndicator(bool connected)
    {
        _connectionStatusLabel.Text = connected ? "● Connected" : "● Disconnected";
        _connectionStatusLabel.ForeColor = connected ? DarkSuccess : DarkDanger;
    }

    // Direct round-trip timing to the server root - deliberately separate
    // from ConnectionStatus (which mirrors StatusPoller's own "3 failed
    // polls" defensive signal) - this is the "+ ping" ask, a live number,
    // not just a boolean.
    private async Task RefreshPingAsync()
    {
        if (IsDisposed) return;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var response = await http.GetAsync(_config.ServerUrl);
            sw.Stop();
            if (IsDisposed) return;
            _pingLabel.Text = $"Ping: {sw.ElapsedMilliseconds} ms";
            _pingLabel.ForeColor = DarkTextMuted;
        }
        catch
        {
            if (IsDisposed) return;
            _pingLabel.Text = "Ping: timeout";
            _pingLabel.ForeColor = DarkDanger;
        }
    }

    // ---- Section 2: Payment & Time Rules (read-only) ----
    // Card: Top=y, Height=94.
    //   header             Top=12 H=22 -> bottom=34
    //   _minCreditLabel    Top=40 H=22 -> bottom=62
    //   _idleShutdownLabel Top=64 H=22 -> bottom=86
    private int BuildPaymentRulesSection(int y)
    {
        const int height = 94;
        var card = AddCard(y, height);
        AddHeader(card, "PAYMENT & TIME RULES");

        _minCreditLabel = new Label
        {
            Text = "Minimum credits to register: --", ForeColor = DarkTextPrimary,
            AutoSize = false, Left = 16, Top = 40, Width = CardWidth - 32, Height = 22,
        };
        card.Controls.Add(_minCreditLabel);

        _idleShutdownLabel = new Label
        {
            Text = "Idle shutdown: -- seconds", ForeColor = DarkTextPrimary,
            AutoSize = false, Left = 16, Top = 64, Width = CardWidth - 32, Height = 22,
        };
        card.Controls.Add(_idleShutdownLabel);

        return y + height + 16;
    }

    // ---- Section 3: Guest -> Member Conversion ----
    // Card: Top=y, Height=140.
    //   header                    Top=12  H=22 -> bottom=34
    //   _guestConversionCheck     Top=44  H=24, Left=16  W=300 -> bottom=68
    //   "minimum minutes" label   Top=76  H=24, Left=16  W=200 -> bottom=100
    //   _guestConversionMinutes   Top=74  H=24, Left=220 W=80  -> bottom=98
    //   _saveConversionButton     Top=104 H=32, Left=16  W=120 -> bottom=136
    //   _conversionStatusLabel    Top=108 H=24, Left=150 W=494 -> bottom=132
    private int BuildGuestConversionSection(int y)
    {
        const int height = 140;
        var card = AddCard(y, height);
        AddHeader(card, "GUEST -> MEMBER CONVERSION");

        _guestConversionCheck = new CheckBox
        {
            Text = "Enabled", ForeColor = DarkTextPrimary, BackColor = DarkSurface,
            AutoSize = false, Left = 16, Top = 44, Width = 300, Height = 24,
        };
        card.Controls.Add(_guestConversionCheck);

        var minutesLabel = new Label
        {
            Text = "Minimum minutes played:", ForeColor = DarkTextPrimary,
            AutoSize = false, Left = 16, Top = 76, Width = 200, Height = 24,
        };
        card.Controls.Add(minutesLabel);

        _guestConversionMinutes = new NumericUpDown
        {
            Left = 220, Top = 74, Width = 80, Height = 24,
            Minimum = 0, Maximum = 100000,
            BackColor = DarkBg, ForeColor = DarkTextPrimary,
        };
        card.Controls.Add(_guestConversionMinutes);

        var saveButton = new CardButton
        {
            Text = "SAVE", Left = 16, Top = 104, Width = 120, Height = 32,
            CornerRadius = 6, BackColor = DarkAccent, ForeColor = Color.White,
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
        };
        saveButton.Click += async (_, _) => await OnSaveGuestConversionAsync();
        card.Controls.Add(saveButton);

        _conversionStatusLabel = new Label
        {
            AutoSize = false, Left = 150, Top = 108, Width = CardWidth - 150 - 16, Height = 24,
            ForeColor = DarkTextMuted,
        };
        card.Controls.Add(_conversionStatusLabel);

        return y + height + 16;
    }

    private async Task OnSaveGuestConversionAsync()
    {
        _conversionStatusLabel.ForeColor = DarkTextMuted;
        _conversionStatusLabel.Text = "Saving...";

        // Partial update - only send whichever field actually changed
        // since the load, matching the endpoint's partial-update contract
        // (server/routes/rental.js's POST /admin-panel/settings).
        var enabled = _guestConversionCheck.Checked;
        var minutes = (int)_guestConversionMinutes.Value;
        bool? enabledArg = enabled != _loadedGuestConversionEnabled ? enabled : null;
        int? minutesArg = minutes != _loadedGuestConversionMinutes ? minutes : null;

        if (enabledArg == null && minutesArg == null)
        {
            _conversionStatusLabel.Text = "Nothing changed.";
            return;
        }

        var result = await _api.SaveAdminPanelSettingsAsync(_config.Mac, _config.DeviceSecret, _password, enabledArg, minutesArg);
        if (result != null && result.Success)
        {
            _loadedGuestConversionEnabled = enabled;
            _loadedGuestConversionMinutes = minutes;
            _conversionStatusLabel.ForeColor = DarkSuccess;
            _conversionStatusLabel.Text = "Saved.";
        }
        else
        {
            _conversionStatusLabel.ForeColor = DarkDanger;
            _conversionStatusLabel.Text = result?.Message ?? "Could not save.";
        }
    }

    // ---- Section 4: Points Redemption Tiers ----
    // Card: Top=y, Height=330.
    //   header               Top=12  H=22          -> bottom=34
    //   _ratesStatusLabel    Top=38  H=20           -> bottom=58
    //   _ratesList           Top=62  H=180, Left=16 W=628 (AutoScroll)  -> bottom=242
    //   add-row controls     Top=252..288 (36 tall) -> bottom=308
    private int BuildRedeemTiersSection(int y)
    {
        const int height = 330;
        var card = AddCard(y, height);
        AddHeader(card, "POINTS REDEMPTION TIERS");

        _ratesStatusLabel = new Label
        {
            AutoSize = false, Left = 16, Top = 38, Width = CardWidth - 32, Height = 20,
            ForeColor = DarkTextMuted,
        };
        card.Controls.Add(_ratesStatusLabel);

        _ratesList = new FlowLayoutPanel
        {
            Left = 16, Top = 62, Width = CardWidth - 32, Height = 180,
            FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true,
            BackColor = DarkSurface,
        };
        card.Controls.Add(_ratesList);

        var pointsLabel = new Label { Text = "Points:", ForeColor = DarkTextPrimary, AutoSize = false, Left = 16, Top = 268, Width = 50, Height = 24 };
        card.Controls.Add(pointsLabel);

        _newRatePoints = new NumericUpDown
        {
            Left = 70, Top = 266, Width = 80, Height = 24,
            Minimum = 1, Maximum = 1000000, Value = 100,
            BackColor = DarkBg, ForeColor = DarkTextPrimary,
        };
        card.Controls.Add(_newRatePoints);

        var secondsLabel = new Label { Text = "Reward seconds:", ForeColor = DarkTextPrimary, AutoSize = false, Left = 166, Top = 268, Width = 110, Height = 24 };
        card.Controls.Add(secondsLabel);

        _newRateSeconds = new NumericUpDown
        {
            Left = 280, Top = 266, Width = 90, Height = 24,
            Minimum = 1, Maximum = 100000000, Value = 600,
            BackColor = DarkBg, ForeColor = DarkTextPrimary,
        };
        card.Controls.Add(_newRateSeconds);

        var addButton = new CardButton
        {
            Text = "ADD TIER", Left = 390, Top = 262, Width = 120, Height = 34,
            CornerRadius = 6, BackColor = DarkAccent, ForeColor = Color.White,
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
        };
        addButton.Click += async (_, _) => await OnAddRateAsync();
        card.Controls.Add(addButton);

        return y + height + 16;
    }

    private async Task OnAddRateAsync()
    {
        var points = (int)_newRatePoints.Value;
        var seconds = (int)_newRateSeconds.Value;
        _ratesStatusLabel.ForeColor = DarkTextMuted;
        _ratesStatusLabel.Text = "Adding...";

        var result = await _api.AddAdminPanelRedeemRateAsync(_config.Mac, _config.DeviceSecret, _password, points, seconds);
        if (result != null && result.Success)
        {
            _ratesStatusLabel.Text = "";
            await RefreshRatesAsync();
        }
        else
        {
            _ratesStatusLabel.ForeColor = DarkDanger;
            _ratesStatusLabel.Text = result?.Message ?? "Could not add tier.";
        }
    }

    private async Task RefreshRatesAsync()
    {
        var result = await _api.GetAdminPanelSettingsAsync(_config.Mac, _config.DeviceSecret, _password);
        if (IsDisposed) return;
        if (result == null || !result.Success)
        {
            _ratesStatusLabel.ForeColor = DarkDanger;
            _ratesStatusLabel.Text = result?.Message ?? "Could not load redemption tiers.";
            return;
        }
        RenderRates(result.RedeemRates);
    }

    // Row layout (mirrors LockForm's _noTimeRatesPanel/RewardsPage
    // convention): RoundedPanel row, Width=608 (628 list width minus a
    // ~20px scrollbar allowance), Height=46, 8px bottom margin.
    //   label        Left=12  Top=13 AutoSize
    //   DELETE button Left=508 Top=7  Width=90 Height=32
    private void RenderRates(List<RedeemRate> rates)
    {
        _ratesList.Controls.Clear();
        _ratesStatusLabel.Text = rates.Count == 0 ? "No tiers set up yet." : "";

        foreach (var rate in rates)
        {
            var minutes = rate.RewardSeconds / 60;
            var row = new RoundedPanel
            {
                Width = 608, Height = 46, Margin = new Padding(0, 0, 0, 8),
                CornerRadius = 6, BackColor = DarkBg, BorderColor = DarkBorder, BorderWidth = 1,
            };
            var label = new Label
            {
                Text = $"{rate.Points} pts  ->  {rate.RewardSeconds}s ({minutes} min)",
                ForeColor = DarkTextPrimary, AutoSize = true, Left = 12, Top = 13,
            };
            var deleteButton = new CardButton
            {
                Text = "DELETE", Left = 508, Top = 7, Width = 90, Height = 32,
                CornerRadius = 6, BackColor = DarkDanger, ForeColor = Color.White,
                Font = new Font("Segoe UI", 8, FontStyle.Bold),
            };
            var rateId = rate.Id;
            deleteButton.Click += async (_, _) => await OnDeleteRateAsync(rateId);
            row.Controls.Add(label);
            row.Controls.Add(deleteButton);
            _ratesList.Controls.Add(row);
        }
    }

    private async Task OnDeleteRateAsync(int id)
    {
        _ratesStatusLabel.ForeColor = DarkTextMuted;
        _ratesStatusLabel.Text = "Deleting...";
        var result = await _api.DeleteAdminPanelRedeemRateAsync(_config.Mac, _config.DeviceSecret, _password, id);
        if (result != null && result.Success)
        {
            await RefreshRatesAsync();
        }
        else
        {
            _ratesStatusLabel.ForeColor = DarkDanger;
            _ratesStatusLabel.Text = result?.Message ?? "Could not delete tier.";
        }
    }

    // ---- Section 5: Security ----
    // Card: Top=y, Height=190.
    //   header                 Top=12  H=22 -> bottom=34
    //   _taskMgrCheck          Top=44  H=24 -> bottom=68
    //   _usbCheck              Top=76  H=24 -> bottom=100
    //   _protectFolderCheck    Top=108 H=24 -> bottom=132
    //   _securityStatusLabel   Top=140 H=40 -> bottom=180
    private int BuildSecuritySection(int y)
    {
        const int height = 190;
        var card = AddCard(y, height);
        AddHeader(card, "SECURITY");

        _taskMgrCheck = new CheckBox
        {
            Text = "Disable Task Manager", ForeColor = DarkTextPrimary, BackColor = DarkSurface,
            AutoSize = false, Left = 16, Top = 44, Width = 500, Height = 24,
        };
        _taskMgrCheck.CheckedChanged += async (_, _) => await OnTaskManagerToggledAsync();
        card.Controls.Add(_taskMgrCheck);

        _usbCheck = new CheckBox
        {
            Text = "Disable USB mass storage (flash drives) - keyboard/mouse/coin acceptor unaffected",
            ForeColor = DarkTextPrimary, BackColor = DarkSurface,
            AutoSize = false, Left = 16, Top = 76, Width = 620, Height = 24,
        };
        _usbCheck.CheckedChanged += async (_, _) => await OnUsbToggledAsync();
        card.Controls.Add(_usbCheck);

        _protectFolderCheck = new CheckBox
        {
            Text = "Protect install folder (block writing/deleting its files)",
            ForeColor = DarkTextPrimary, BackColor = DarkSurface,
            AutoSize = false, Left = 16, Top = 108, Width = 500, Height = 24,
        };
        _protectFolderCheck.CheckedChanged += async (_, _) => await OnProtectFolderToggledAsync();
        card.Controls.Add(_protectFolderCheck);

        _securityStatusLabel = new Label
        {
            AutoSize = false, Left = 16, Top = 140, Width = CardWidth - 32, Height = 40,
            ForeColor = DarkTextMuted,
        };
        card.Controls.Add(_securityStatusLabel);

        return y + height + 16;
    }

    // Reads the ACTUAL current state of all three registry/ACL toggles
    // (never a remembered preference) and reflects it in the checkboxes.
    // USB/Protect Folder are disabled outright when not elevated, since
    // writing them would just fail - the status label explains why.
    private void LoadSecuritySection()
    {
        _loadingSecurity = true;

        _taskMgrCheck.Checked = SecurityToggles.IsTaskManagerDisabled();

        var elevated = SecurityToggles.IsElevated();
        var usbState = SecurityToggles.IsUsbStorageDisabled();
        _usbCheck.Checked = usbState ?? false;
        _usbCheck.Enabled = elevated;

        var folder = SecurityToggles.GetInstallFolder();
        var protectState = SecurityToggles.IsInstallFolderProtected(folder);
        _protectFolderCheck.Checked = protectState ?? false;
        _protectFolderCheck.Enabled = elevated;

        if (!elevated)
        {
            _securityStatusLabel.ForeColor = DarkDanger;
            _securityStatusLabel.Text = "Running without Administrator rights - USB Ports and Protect Install Folder require the app to be elevated to change.";
        }
        else if (usbState == null || protectState == null)
        {
            _securityStatusLabel.ForeColor = DarkTextMuted;
            _securityStatusLabel.Text = "Some settings' current state could not be read - shown as off until toggled.";
        }

        _loadingSecurity = false;
    }

    private async Task OnTaskManagerToggledAsync()
    {
        if (_loadingSecurity) return;
        var (ok, error) = SecurityToggles.SetTaskManagerDisabled(_taskMgrCheck.Checked);
        if (!ok)
        {
            _loadingSecurity = true;
            _taskMgrCheck.Checked = !_taskMgrCheck.Checked; // revert the checkbox to match reality
            _loadingSecurity = false;
            ShowSecurityError(error);
        }
        else
        {
            ShowSecuritySuccess();
        }
        await Task.CompletedTask;
    }

    private async Task OnUsbToggledAsync()
    {
        if (_loadingSecurity) return;
        var (ok, error) = SecurityToggles.SetUsbStorageDisabled(_usbCheck.Checked);
        if (!ok)
        {
            _loadingSecurity = true;
            _usbCheck.Checked = !_usbCheck.Checked;
            _loadingSecurity = false;
            ShowSecurityError(error);
        }
        else
        {
            ShowSecuritySuccess();
        }
        await Task.CompletedTask;
    }

    private async Task OnProtectFolderToggledAsync()
    {
        if (_loadingSecurity) return;
        var folder = SecurityToggles.GetInstallFolder();
        var (ok, error) = SecurityToggles.SetInstallFolderProtected(folder, _protectFolderCheck.Checked);
        if (!ok)
        {
            _loadingSecurity = true;
            _protectFolderCheck.Checked = !_protectFolderCheck.Checked;
            _loadingSecurity = false;
            ShowSecurityError(error);
        }
        else
        {
            ShowSecuritySuccess();
        }
        await Task.CompletedTask;
    }

    private void ShowSecurityError(string? error)
    {
        _securityStatusLabel.ForeColor = DarkDanger;
        _securityStatusLabel.Text = error ?? "Could not apply that setting.";
    }

    private void ShowSecuritySuccess()
    {
        _securityStatusLabel.ForeColor = DarkSuccess;
        _securityStatusLabel.Text = "Applied.";
    }

    // ---- Section 6: Client Status ----
    // Card: Top=y, Height=110.
    //   header                Top=12 H=22 -> bottom=34
    //   _clientEnabledCheck   Top=44 H=24 -> bottom=68
    //   note label            Top=76 H=28 -> bottom=104
    private void BuildClientStatusSection(int y)
    {
        const int height = 110;
        var card = AddCard(y, height);
        AddHeader(card, "CLIENT STATUS");

        _clientEnabledCheck = new CheckBox
        {
            Text = "Café Client Enabled", ForeColor = DarkTextPrimary, BackColor = DarkSurface,
            AutoSize = false, Left = 16, Top = 44, Width = 300, Height = 24,
            Checked = _prefs.ClientEnabled,
        };
        _clientEnabledCheck.CheckedChanged += (_, _) =>
        {
            _prefs.ClientEnabled = _clientEnabledCheck.Checked;
            _prefs.Save();
        };
        card.Controls.Add(_clientEnabledCheck);

        var note = new Label
        {
            Text = "Unchecking this turns off all lock-screen/session enforcement (customer gets a normal desktop). Takes effect within about 5 seconds - no restart needed.",
            ForeColor = DarkTextMuted, AutoSize = false, Left = 16, Top = 76, Width = CardWidth - 32, Height = 28,
        };
        card.Controls.Add(note);
    }

    private async Task LoadSettingsAsync()
    {
        var result = await _api.GetAdminPanelSettingsAsync(_config.Mac, _config.DeviceSecret, _password);
        if (IsDisposed) return;
        if (result == null || !result.Success)
        {
            _minCreditLabel.Text = "Minimum credits to register: (could not load)";
            _idleShutdownLabel.Text = "Idle shutdown: (could not load)";
            _ratesStatusLabel.ForeColor = DarkDanger;
            _ratesStatusLabel.Text = result?.Message ?? "Could not load admin panel settings.";
            return;
        }

        _minCreditLabel.Text = $"Minimum credits to register: {result.MinCreditToRegister}";
        _idleShutdownLabel.Text = $"Idle shutdown: {result.IdleShutdownSecs} seconds";

        _loadedGuestConversionEnabled = result.GuestConversionEnabled;
        _loadedGuestConversionMinutes = result.GuestConversionMinMinutes;
        _guestConversionCheck.Checked = result.GuestConversionEnabled;
        _guestConversionMinutes.Value = Math.Clamp(result.GuestConversionMinMinutes, (int)_guestConversionMinutes.Minimum, (int)_guestConversionMinutes.Maximum);

        RenderRates(result.RedeemRates);
    }
}
