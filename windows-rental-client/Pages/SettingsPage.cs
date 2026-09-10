using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

public class SettingsPage : UserControl
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly ClientPreferences _prefs;

	private readonly TabControl _tabs;

	private ComboBox _themeCombo;

	private CheckBox _autoLogoutCheck;

	private NumericUpDown _autoLogoutMinutes;

	private CheckBox _startOnBootCheck;

	private CheckBox _notifySessionCheck;

	private CheckBox _notifyPromosCheck;

	private CheckBox _notifyRewardsCheck;

	private CheckBox _sessionReminderCheck;

	private NumericUpDown _sessionReminderMinutes;

	private CheckBox _cleanUpCheck;

	private TextBox _currentPasswordBox;

	private TextBox _newPasswordBox;

	private Label _accountStatusLabel;

	public event Action<ClientPreferences>? PreferencesSaved;

	public SettingsPage(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
	{
		_api = api;
		_config = config;
		_prefs = prefs;
		Dock = DockStyle.Fill;
		BackColor = Theme.Background;
		_tabs = new TabControl
		{
			Dock = DockStyle.Fill
		};
		base.Controls.Add(_tabs);
		_tabs.TabPages.Add(BuildGeneralTab());
		_tabs.TabPages.Add(BuildAccountTab());
		_tabs.TabPages.Add(StaticInfoTab("Display", "Display settings (resolution, brightness) are managed by Windows on this PC - not yet configurable from here."));
		_tabs.TabPages.Add(StaticInfoTab("Audio", "Volume and audio device selection are managed by Windows on this PC - not yet configurable from here."));
		_tabs.TabPages.Add(StaticInfoTab("Controls", "Controller/keyboard remapping isn't built yet."));
		_tabs.TabPages.Add(BuildNetworkTab());
		_tabs.TabPages.Add(StaticInfoTab("About", "StarkFi Rental Client\nv1.0.0"));
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ApplyTheme);
			}
		};
	}

	private TabPage BuildGeneralTab()
	{
		TabPage tabPage = new TabPage("General");
		int num = 20;
		Label value = new Label
		{
			Text = "Theme",
			AutoSize = true,
			Left = 20,
			Top = num + 4
		};
		_themeCombo = new ComboBox
		{
			Left = 220,
			Top = num,
			Width = 200,
			DropDownStyle = ComboBoxStyle.DropDownList
		};
		_themeCombo.Items.Add("Dark");
		_themeCombo.Items.Add("Neon Purple");
		_themeCombo.SelectedIndex = ((_prefs.Theme == ThemeName.NeonPurple) ? 1 : 0);
		tabPage.Controls.Add(value);
		tabPage.Controls.Add(_themeCombo);
		num += 44;
		_autoLogoutCheck = new CheckBox
		{
			Text = "Auto logout when idle",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.AutoLogoutEnabled
		};
		_autoLogoutMinutes = new NumericUpDown
		{
			Left = 320,
			Top = num - 2,
			Width = 70,
			Minimum = 1m,
			Maximum = 180m,
			Value = Math.Clamp(_prefs.AutoLogoutMinutes, 1, 180)
		};
		Label value2 = new Label
		{
			Text = "minutes",
			AutoSize = true,
			Left = 396,
			Top = num + 2
		};
		tabPage.Controls.Add(_autoLogoutCheck);
		tabPage.Controls.Add(_autoLogoutMinutes);
		tabPage.Controls.Add(value2);
		num += 44;
		_startOnBootCheck = new CheckBox
		{
			Text = "Start automatically when Windows starts",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.StartOnBoot
		};
		tabPage.Controls.Add(_startOnBootCheck);
		num += 44;
		Label value3 = new Label
		{
			Text = "Notifications",
			Font = new Font("Segoe UI", 9f, FontStyle.Bold),
			AutoSize = true,
			Left = 20,
			Top = num
		};
		tabPage.Controls.Add(value3);
		num += 30;
		_notifySessionCheck = new CheckBox
		{
			Text = "Session alerts",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.NotifySessionAlerts
		};
		tabPage.Controls.Add(_notifySessionCheck);
		num += 30;
		_notifyPromosCheck = new CheckBox
		{
			Text = "Promotions & announcements",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.NotifyPromotions
		};
		tabPage.Controls.Add(_notifyPromosCheck);
		num += 30;
		_notifyRewardsCheck = new CheckBox
		{
			Text = "Rewards & points updates",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.NotifyRewardsUpdates
		};
		tabPage.Controls.Add(_notifyRewardsCheck);
		num += 44;
		_sessionReminderCheck = new CheckBox
		{
			Text = "Remind me before my session ends",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.SessionReminderEnabled
		};
		_sessionReminderMinutes = new NumericUpDown
		{
			Left = 320,
			Top = num - 2,
			Width = 70,
			Minimum = 1m,
			Maximum = 60m,
			Value = Math.Clamp(_prefs.SessionReminderMinutesBefore, 1, 60)
		};
		Label value4 = new Label
		{
			Text = "minutes before",
			AutoSize = true,
			Left = 396,
			Top = num + 2
		};
		tabPage.Controls.Add(_sessionReminderCheck);
		tabPage.Controls.Add(_sessionReminderMinutes);
		tabPage.Controls.Add(value4);
		num += 44;
		_cleanUpCheck = new CheckBox
		{
			Text = "Clean up on exit (close apps, clear temp files when session ends)",
			AutoSize = true,
			Left = 20,
			Top = num,
			Checked = _prefs.CleanUpOnExit
		};
		tabPage.Controls.Add(_cleanUpCheck);
		num += 44;
		CardButton cardButton = new CardButton
		{
			Text = "SAVE CHANGES",
			Width = 180,
			Height = 40,
			Left = 20,
			Top = num + 10,
			CornerRadius = 8,
			BackColor = Theme.Accent
		};
		cardButton.Click += delegate
		{
			SaveGeneral();
		};
		tabPage.Controls.Add(cardButton);
		return tabPage;
	}

	private void SaveGeneral()
	{
		_prefs.Theme = ((_themeCombo.SelectedIndex == 1) ? ThemeName.NeonPurple : ThemeName.Dark);
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
		MessageBox.Show("Settings saved.", "Settings", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
	}

	private TabPage BuildAccountTab()
	{
		TabPage tabPage = new TabPage("Account");
		Label value = new Label
		{
			Text = "Change password",
			Font = new Font("Segoe UI", 11f, FontStyle.Bold),
			AutoSize = true,
			Left = 20,
			Top = 20
		};
		_currentPasswordBox = new TextBox
		{
			PlaceholderText = "Current password",
			PasswordChar = '*',
			Left = 20,
			Top = 56,
			Width = 260
		};
		_newPasswordBox = new TextBox
		{
			PlaceholderText = "New password",
			PasswordChar = '*',
			Left = 20,
			Top = 90,
			Width = 260
		};
		_accountStatusLabel = new Label
		{
			ForeColor = Theme.Danger,
			AutoSize = true,
			Left = 20,
			Top = 124,
			Width = 400
		};
		CardButton cardButton = new CardButton
		{
			Text = "SAVE",
			Width = 260,
			Height = 36,
			Left = 20,
			Top = 154,
			CornerRadius = 8,
			BackColor = Theme.Accent
		};
		cardButton.Click += async delegate
		{
			await OnChangePasswordClicked();
		};
		Label value2 = new Label
		{
			Text = "Only applies to member accounts - not shown for a guest session.",
			AutoSize = true,
			Left = 20,
			Top = 210,
			ForeColor = Theme.TextMuted
		};
		tabPage.Controls.Add(value);
		tabPage.Controls.Add(_currentPasswordBox);
		tabPage.Controls.Add(_newPasswordBox);
		tabPage.Controls.Add(_accountStatusLabel);
		tabPage.Controls.Add(cardButton);
		tabPage.Controls.Add(value2);
		return tabPage;
	}

	private async Task OnChangePasswordClicked()
	{
		_accountStatusLabel.ForeColor = Theme.Danger;
		ApiResult apiResult = await _api.ChangePasswordAsync(_config.Mac, _config.DeviceSecret, _currentPasswordBox.Text, _newPasswordBox.Text);
		if (apiResult != null && apiResult.Success)
		{
			_accountStatusLabel.ForeColor = Theme.Success;
			_accountStatusLabel.Text = "Password changed.";
			_currentPasswordBox.Text = "";
			_newPasswordBox.Text = "";
		}
		else
		{
			_accountStatusLabel.Text = apiResult?.Message ?? "Could not change password.";
		}
	}

	private TabPage BuildNetworkTab()
	{
		TabPage tabPage = new TabPage("Network");
		Label value = new Label
		{
			Text = "Server address",
			Font = new Font("Segoe UI", 9f, FontStyle.Bold),
			AutoSize = true,
			Left = 20,
			Top = 20
		};
		TextBox value2 = new TextBox
		{
			Text = _config.ServerUrl,
			Left = 20,
			Top = 46,
			Width = 400,
			ReadOnly = true
		};
		Label value3 = new Label
		{
			Text = "Read-only here - changing the server address requires re-running setup.",
			AutoSize = true,
			Left = 20,
			Top = 80,
			ForeColor = Theme.TextMuted
		};
		tabPage.Controls.Add(value);
		tabPage.Controls.Add(value2);
		tabPage.Controls.Add(value3);
		return tabPage;
	}

	private TabPage StaticInfoTab(string title, string body)
	{
		TabPage tabPage = new TabPage(title);
		Label value = new Label
		{
			Text = body,
			AutoSize = true,
			Left = 20,
			Top = 20,
			MaximumSize = new Size(500, 0)
		};
		tabPage.Controls.Add(value);
		return tabPage;
	}

	private void ApplyTheme()
	{
		BackColor = Theme.Background;
	}
}
