using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Tabbed settings (V1.0.0 mockup rebuild: General/Account/Display/
// Audio/Controls/Network/About). Only General and Account do anything
// real this phase - the rest render honest, mostly-static content
// rather than being hidden outright, since the mockup shows them, but
// never pretend a control does something it doesn't (matches this
// project's own RENTAL_COMING_SOON convention on the admin side).
public class SettingsPage : UserControl
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly ClientPreferences _prefs;
    private readonly TabControl _tabs;

    // General tab controls
    private ComboBox _themeCombo = null!;
    private CheckBox _autoLogoutCheck = null!;
    private NumericUpDown _autoLogoutMinutes = null!;
    private CheckBox _startOnBootCheck = null!;
    private CheckBox _notifySessionCheck = null!;
    private CheckBox _notifyPromosCheck = null!;
    private CheckBox _notifyRewardsCheck = null!;
    private CheckBox _sessionReminderCheck = null!;
    private NumericUpDown _sessionReminderMinutes = null!;
    private CheckBox _cleanUpCheck = null!;

    // Account tab controls
    private TextBox _currentPasswordBox = null!;
    private TextBox _newPasswordBox = null!;
    private Label _accountStatusLabel = null!;

    public event Action<ClientPreferences>? PreferencesSaved;

    public SettingsPage(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
    {
        _api = api;
        _config = config;
        _prefs = prefs;
        Dock = DockStyle.Fill;
        BackColor = Theme.Background;

        _tabs = new TabControl { Dock = DockStyle.Fill };
        Controls.Add(_tabs);

        _tabs.TabPages.Add(BuildGeneralTab());
        _tabs.TabPages.Add(BuildAccountTab());
        _tabs.TabPages.Add(StaticInfoTab("Display", "Display settings (resolution, brightness) are managed by Windows on this PC - not yet configurable from here."));
        _tabs.TabPages.Add(StaticInfoTab("Audio", "Volume and audio device selection are managed by Windows on this PC - not yet configurable from here."));
        _tabs.TabPages.Add(StaticInfoTab("Controls", "Controller/keyboard remapping isn't built yet."));
        _tabs.TabPages.Add(BuildNetworkTab());
        _tabs.TabPages.Add(StaticInfoTab("About", $"StarkFi Rental Client\nv1.0.0"));

        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
    }

    private TabPage BuildGeneralTab()
    {
        var tab = new TabPage("General");
        var y = 20;
        const int rowHeight = 44;

        var themeLabel = new Label { Text = "Theme", AutoSize = true, Left = 20, Top = y + 4 };
        _themeCombo = new ComboBox { Left = 220, Top = y, Width = 200, DropDownStyle = ComboBoxStyle.DropDownList };
        _themeCombo.Items.Add("Dark");
        _themeCombo.Items.Add("Neon Purple");
        _themeCombo.SelectedIndex = _prefs.Theme == ThemeName.NeonPurple ? 1 : 0;
        tab.Controls.Add(themeLabel);
        tab.Controls.Add(_themeCombo);
        y += rowHeight;

        _autoLogoutCheck = new CheckBox { Text = "Auto logout when idle", AutoSize = true, Left = 20, Top = y, Checked = _prefs.AutoLogoutEnabled };
        _autoLogoutMinutes = new NumericUpDown { Left = 320, Top = y - 2, Width = 70, Minimum = 1, Maximum = 180, Value = Math.Clamp(_prefs.AutoLogoutMinutes, 1, 180) };
        var autoLogoutSuffix = new Label { Text = "minutes", AutoSize = true, Left = 396, Top = y + 2 };
        tab.Controls.Add(_autoLogoutCheck);
        tab.Controls.Add(_autoLogoutMinutes);
        tab.Controls.Add(autoLogoutSuffix);
        y += rowHeight;

        _startOnBootCheck = new CheckBox { Text = "Start automatically when Windows starts", AutoSize = true, Left = 20, Top = y, Checked = _prefs.StartOnBoot };
        tab.Controls.Add(_startOnBootCheck);
        y += rowHeight;

        var notifHeader = new Label { Text = "Notifications", Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, Left = 20, Top = y };
        tab.Controls.Add(notifHeader);
        y += 30;
        _notifySessionCheck = new CheckBox { Text = "Session alerts", AutoSize = true, Left = 20, Top = y, Checked = _prefs.NotifySessionAlerts };
        tab.Controls.Add(_notifySessionCheck);
        y += 30;
        _notifyPromosCheck = new CheckBox { Text = "Promotions & announcements", AutoSize = true, Left = 20, Top = y, Checked = _prefs.NotifyPromotions };
        tab.Controls.Add(_notifyPromosCheck);
        y += 30;
        _notifyRewardsCheck = new CheckBox { Text = "Rewards & points updates", AutoSize = true, Left = 20, Top = y, Checked = _prefs.NotifyRewardsUpdates };
        tab.Controls.Add(_notifyRewardsCheck);
        y += rowHeight;

        _sessionReminderCheck = new CheckBox { Text = "Remind me before my session ends", AutoSize = true, Left = 20, Top = y, Checked = _prefs.SessionReminderEnabled };
        _sessionReminderMinutes = new NumericUpDown { Left = 320, Top = y - 2, Width = 70, Minimum = 1, Maximum = 60, Value = Math.Clamp(_prefs.SessionReminderMinutesBefore, 1, 60) };
        var reminderSuffix = new Label { Text = "minutes before", AutoSize = true, Left = 396, Top = y + 2 };
        tab.Controls.Add(_sessionReminderCheck);
        tab.Controls.Add(_sessionReminderMinutes);
        tab.Controls.Add(reminderSuffix);
        y += rowHeight;

        _cleanUpCheck = new CheckBox { Text = "Clean up on exit (close apps, clear temp files when session ends)", AutoSize = true, Left = 20, Top = y, Checked = _prefs.CleanUpOnExit };
        tab.Controls.Add(_cleanUpCheck);
        y += rowHeight;

        var saveButton = new CardButton { Text = "SAVE CHANGES", Width = 180, Height = 40, Left = 20, Top = y + 10, CornerRadius = 8, BackColor = Theme.Accent };
        saveButton.Click += (_, _) => SaveGeneral();
        tab.Controls.Add(saveButton);

        return tab;
    }

    private void SaveGeneral()
    {
        _prefs.Theme = _themeCombo.SelectedIndex == 1 ? ThemeName.NeonPurple : ThemeName.Dark;
        _prefs.AutoLogoutEnabled = _autoLogoutCheck.Checked;
        _prefs.AutoLogoutMinutes = (int)_autoLogoutMinutes.Value;
        _prefs.StartOnBoot = _startOnBootCheck.Checked;
        _prefs.NotifySessionAlerts = _notifySessionCheck.Checked;
        _prefs.NotifyPromotions = _notifyPromosCheck.Checked;
        _prefs.NotifyRewardsUpdates = _notifyRewardsCheck.Checked;
        _prefs.SessionReminderEnabled = _sessionReminderCheck.Checked;
        _prefs.SessionReminderMinutesBefore = (int)_sessionReminderMinutes.Value;
        _prefs.CleanUpOnExit = _cleanUpCheck.Checked;
        _prefs.Save();

        StartupManager.SetEnabled(_prefs.StartOnBoot);
        Theme.Apply(_prefs.Theme);
        PreferencesSaved?.Invoke(_prefs);

        MessageBox.Show("Settings saved.", "Settings", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private TabPage BuildAccountTab()
    {
        var tab = new TabPage("Account");
        var title = new Label { Text = "Change password", Font = new Font("Segoe UI", 11, FontStyle.Bold), AutoSize = true, Left = 20, Top = 20 };
        _currentPasswordBox = new TextBox { PlaceholderText = "Current password", PasswordChar = '*', Left = 20, Top = 56, Width = 260 };
        _newPasswordBox = new TextBox { PlaceholderText = "New password", PasswordChar = '*', Left = 20, Top = 90, Width = 260 };
        _accountStatusLabel = new Label { ForeColor = Theme.Danger, AutoSize = true, Left = 20, Top = 124, Width = 400 };
        var saveButton = new CardButton { Text = "SAVE", Width = 260, Height = 36, Left = 20, Top = 154, CornerRadius = 8, BackColor = Theme.Accent };
        saveButton.Click += async (_, _) => await OnChangePasswordClicked();

        var note = new Label { Text = "Only applies to member accounts - not shown for a guest session.", AutoSize = true, Left = 20, Top = 210, ForeColor = Theme.TextMuted };

        tab.Controls.Add(title);
        tab.Controls.Add(_currentPasswordBox);
        tab.Controls.Add(_newPasswordBox);
        tab.Controls.Add(_accountStatusLabel);
        tab.Controls.Add(saveButton);
        tab.Controls.Add(note);
        return tab;
    }

    private async Task OnChangePasswordClicked()
    {
        _accountStatusLabel.ForeColor = Theme.Danger;
        var result = await _api.ChangePasswordAsync(_config.Mac, _config.DeviceSecret, _currentPasswordBox.Text, _newPasswordBox.Text);
        if (result != null && result.Success)
        {
            _accountStatusLabel.ForeColor = Theme.Success;
            _accountStatusLabel.Text = "Password changed.";
            _currentPasswordBox.Text = "";
            _newPasswordBox.Text = "";
        }
        else
        {
            _accountStatusLabel.Text = result?.Message ?? "Could not change password.";
        }
    }

    private TabPage BuildNetworkTab()
    {
        var tab = new TabPage("Network");
        var label = new Label { Text = "Server address", Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, Left = 20, Top = 20 };
        var urlBox = new TextBox { Text = _config.ServerUrl, Left = 20, Top = 46, Width = 400, ReadOnly = true };
        var note = new Label { Text = "Read-only here - changing the server address requires re-running setup.", AutoSize = true, Left = 20, Top = 80, ForeColor = Theme.TextMuted };
        tab.Controls.Add(label);
        tab.Controls.Add(urlBox);
        tab.Controls.Add(note);
        return tab;
    }

    private TabPage StaticInfoTab(string title, string body)
    {
        var tab = new TabPage(title);
        var label = new Label { Text = body, AutoSize = true, Left = 20, Top = 20, MaximumSize = new Size(500, 0) };
        tab.Controls.Add(label);
        return tab;
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
    }
}
