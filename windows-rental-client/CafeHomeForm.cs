using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.Pages;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

public class CafeHomeForm : Form
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly ClientPreferences _prefs;

	private readonly KeyboardBlocker _keyboardBlocker = new KeyboardBlocker();

	private Panel _topBar;

	private Label _timeLabel;

	private CardButton _addTimeButton;

	private Label _memberLabel;

	private Label _memberBadge;

	private Label _pointsLabel;

	private Label _pcInfoLabel;

	private Label _clockLabel;

	private CoinInsertPanel? _topBarCoinPanel;

	private readonly Timer _clockTimer;

	private Panel _sidebar;

	private readonly Dictionary<string, CardButton> _navButtons = new Dictionary<string, CardButton>();

	private Panel _content;

	private HomePage _homePage;

	private GamesPage _gamesPage;

	private ApplicationsPage _applicationsPage;

	private MySessionPage _mySessionPage;

	private RewardsPage _rewardsPage;

	private SettingsPage _settingsPage;

	private string _activePage = "home";

	private readonly Timer _catalogRefreshTimer;

	private static readonly TimeSpan CatalogRefreshInterval = TimeSpan.FromSeconds(60.0);

	private readonly IdleDetector _idleDetector = new IdleDetector();

	private bool _isMember;

	private bool _sessionReminderShown;

	public bool IsProgramRunning => AppLauncher.IsProgramRunning;

	public CafeHomeForm(RentalApiClient api, ClientConfig config, ClientPreferences prefs)
	{
		_api = api;
		_config = config;
		_prefs = prefs;
		base.FormBorderStyle = FormBorderStyle.None;
		base.WindowState = FormWindowState.Maximized;
		base.TopMost = true;
		base.StartPosition = FormStartPosition.Manual;
		base.Bounds = Screen.PrimaryScreen.Bounds;
		base.ShowInTaskbar = false;
		base.KeyPreview = true;
		BuildSidebar();
		BuildTopBar();
		BuildContent();
		_catalogRefreshTimer = new Timer
		{
			Interval = (int)CatalogRefreshInterval.TotalMilliseconds
		};
		_catalogRefreshTimer.Tick += async delegate
		{
			await RefreshActivePageAsync();
		};
		_clockTimer = new Timer
		{
			Interval = 1000
		};
		_clockTimer.Tick += delegate
		{
			_clockLabel.Text = DateTime.Now.ToString("hh:mm tt  •  MMM d, yyyy");
		};
		_idleDetector.IdleTimeoutReached += async delegate
		{
			await OnIdleTimeoutAsync();
		};
		AppLauncher.ProcessExited += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ShowHome);
			}
		};
		base.FormClosing += delegate(object? _, FormClosingEventArgs e)
		{
			if (base.Visible)
			{
				e.Cancel = true;
			}
		};
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ApplyTheme);
			}
		};
		ApplyTheme();
		SwitchPage("home");
	}

	private void BuildSidebar()
	{
		_sidebar = new Panel
		{
			Dock = DockStyle.Left,
			Width = 220
		};
		base.Controls.Add(_sidebar);
		Label value = new Label
		{
			Text = "CAFÉ HOME",
			Font = new Font("Segoe UI", 13f, FontStyle.Bold),
			AutoSize = true,
			Left = 20,
			Top = 20
		};
		_sidebar.Controls.Add(value);
		(string, string)[] obj = new(string, string)[6]
		{
			("home", "HOME"),
			("games", "GAMES"),
			("applications", "APPLICATIONS"),
			("mysession", "MY SESSION"),
			("rewards", "REWARDS"),
			("settings", "SETTINGS")
		};
		int num = 70;
		(string, string)[] array = obj;
		for (int i = 0; i < array.Length; i++)
		{
			(string, string) tuple = array[i];
			string item = tuple.Item1;
			string item2 = tuple.Item2;
			CardButton cardButton = new CardButton
			{
				Text = item2,
				Width = 180,
				Height = 44,
				Left = 20,
				Top = num,
				CornerRadius = 8,
				TextAlign = ContentAlignment.MiddleLeft,
				Padding = new Padding(16, 0, 0, 0)
			};
			string capturedKey = item;
			cardButton.Click += delegate
			{
				SwitchPage(capturedKey);
			};
			_sidebar.Controls.Add(cardButton);
			_navButtons[item] = cardButton;
			num += 52;
		}
	}

	private void BuildTopBar()
	{
		_topBar = new Panel
		{
			Dock = DockStyle.Top,
			Height = 76
		};
		base.Controls.Add(_topBar);
		_timeLabel = new Label
		{
			Font = new Font("Segoe UI", 16f, FontStyle.Bold),
			AutoSize = true,
			Left = 24,
			Top = 14
		};
		Label value = new Label
		{
			Text = "REMAINING TIME",
			Font = new Font("Segoe UI", 7f, FontStyle.Bold),
			AutoSize = true,
			Left = 24,
			Top = 40
		};
		_addTimeButton = new CardButton
		{
			Text = "+ ADD TIME",
			Width = 110,
			Height = 30,
			Left = 150,
			Top = 22,
			CornerRadius = 6
		};
		_addTimeButton.Click += delegate
		{
			ShowTopBarCoinPanel();
		};
		_memberLabel = new Label
		{
			Font = new Font("Segoe UI", 10f, FontStyle.Bold),
			AutoSize = true,
			Top = 14
		};
		_memberBadge = new Label
		{
			Text = "MEMBER",
			Font = new Font("Segoe UI", 7f, FontStyle.Bold),
			AutoSize = true,
			Top = 15,
			Padding = new Padding(6, 2, 6, 2)
		};
		_pointsLabel = new Label
		{
			Font = new Font("Segoe UI", 8f),
			AutoSize = true,
			Top = 38
		};
		_pcInfoLabel = new Label
		{
			Font = new Font("Segoe UI", 9f, FontStyle.Bold),
			AutoSize = true,
			Top = 14,
			TextAlign = ContentAlignment.MiddleRight
		};
		_clockLabel = new Label
		{
			Font = new Font("Segoe UI", 8f),
			AutoSize = true,
			Top = 38
		};
		_topBar.Controls.Add(_timeLabel);
		_topBar.Controls.Add(value);
		_topBar.Controls.Add(_addTimeButton);
		_topBar.Controls.Add(_memberLabel);
		_topBar.Controls.Add(_memberBadge);
		_topBar.Controls.Add(_pointsLabel);
		_topBar.Controls.Add(_pcInfoLabel);
		_topBar.Controls.Add(_clockLabel);
		_topBar.Resize += delegate
		{
			RepositionTopBarRight();
		};
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
		_content = new Panel
		{
			Dock = DockStyle.Fill
		};
		base.Controls.Add(_content);
		_homePage = new HomePage(_api, _config)
		{
			Visible = false
		};
		_homePage.NavigateRequested += delegate(string key)
		{
			SwitchPage(key);
		};
		_gamesPage = new GamesPage(_api, _config)
		{
			Visible = false
		};
		_applicationsPage = new ApplicationsPage(_api, _config)
		{
			Visible = false
		};
		_mySessionPage = new MySessionPage(_api, _config)
		{
			Visible = false
		};
		_rewardsPage = new RewardsPage(_api, _config)
		{
			Visible = false
		};
		_settingsPage = new SettingsPage(_api, _config, _prefs)
		{
			Visible = false
		};
		_settingsPage.PreferencesSaved += delegate
		{
			ApplyPreferences();
		};
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
		if (key == "rewards" && !_isMember)
		{
			key = "home";
		}
		_activePage = key;
		foreach (var (text2, cardButton2) in _navButtons)
		{
			cardButton2.BackColor = ((text2 == key) ? Theme.Accent : Theme.Surface);
		}
		_homePage.Visible = key == "home";
		_gamesPage.Visible = key == "games";
		_applicationsPage.Visible = key == "applications";
		_mySessionPage.Visible = key == "mysession";
		_rewardsPage.Visible = key == "rewards";
		_settingsPage.Visible = key == "settings";
		if (key == "home")
		{
			_homePage.OnShown();
		}
		else
		{
			_homePage.OnHidden();
		}
		RefreshActivePageAsync();
	}

	private async Task RefreshActivePageAsync()
	{
		_ = 3;
		try
		{
			switch (_activePage)
			{
			case "home":
				await _homePage.RefreshAsync();
				break;
			case "games":
				await _gamesPage.RefreshAsync();
				break;
			case "applications":
				await _applicationsPage.RefreshAsync();
				break;
			case "rewards":
				await _rewardsPage.RefreshAsync();
				break;
			}
		}
		catch
		{
		}
	}

	private void ApplyTheme()
	{
		BackColor = Theme.Background;
		_sidebar.BackColor = Theme.SurfaceAlt;
		_topBar.BackColor = Theme.SurfaceAlt;
		foreach (Control control2 in _sidebar.Controls)
		{
			if (control2 is Label label)
			{
				label.ForeColor = Theme.TextPrimary;
			}
		}
		foreach (var (text2, cardButton2) in _navButtons)
		{
			cardButton2.ForeColor = Theme.TextPrimary;
			cardButton2.BackColor = ((text2 == _activePage) ? Theme.Accent : Theme.Surface);
		}
		_timeLabel.ForeColor = Theme.TextPrimary;
		_addTimeButton.BackColor = Theme.Accent;
		_memberLabel.ForeColor = Theme.TextPrimary;
		_memberBadge.BackColor = Theme.Accent;
		_memberBadge.ForeColor = Color.White;
		_pointsLabel.ForeColor = Theme.TextMuted;
		_pcInfoLabel.ForeColor = Theme.TextPrimary;
		_clockLabel.ForeColor = Theme.TextMuted;
		foreach (Control control3 in _topBar.Controls)
		{
			if (control3.Font.Size <= 8f && control3 is Label label2 && label2 != _pointsLabel && label2 != _clockLabel)
			{
				label2.ForeColor = Theme.TextMuted;
			}
		}
	}

	private void ApplyPreferences()
	{
		if (_isMember && _prefs.AutoLogoutEnabled)
		{
			_idleDetector.Start(_prefs.AutoLogoutMinutes);
		}
		else
		{
			_idleDetector.Stop();
		}
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
		if (!IsProgramRunning)
		{
			if (!base.Visible)
			{
				Show();
				RefreshActivePageAsync();
			}
			_keyboardBlocker.Install();
			base.WindowState = FormWindowState.Maximized;
			base.TopMost = true;
			Activate();
			_catalogRefreshTimer.Start();
			_clockTimer.Start();
			_clockLabel.Text = DateTime.Now.ToString("hh:mm tt  •  MMM d, yyyy");
		}
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
		int num = (int)status.MinutesRemaining;
		int value = (int)((status.MinutesRemaining - (double)num) * 60.0);
		_timeLabel.Text = $"{num:D2}:{value:D2}";
		_pcInfoLabel.Text = status.PcName;
		_isMember = !string.IsNullOrEmpty(status.LoggedInUser);
		_memberLabel.Text = (_isMember ? ("Welcome back, " + status.LoggedInUser) : "Guest session");
		_memberBadge.Visible = _isMember;
		_pointsLabel.Visible = _isMember;
		_pointsLabel.Text = (_isMember ? $"{status.LoggedInPoints.GetValueOrDefault()} points" : "");
		_navButtons["rewards"].Visible = _isMember;
		RepositionTopBarRight();
		_mySessionPage.UpdateFromStatus(status);
		ApplyPreferences();
		CheckSessionReminder(status.MinutesRemaining);
	}

	private void CheckSessionReminder(double minutesRemaining)
	{
		if (!_prefs.SessionReminderEnabled)
		{
			_sessionReminderShown = false;
		}
		else if (minutesRemaining > (double)_prefs.SessionReminderMinutesBefore)
		{
			_sessionReminderShown = false;
		}
		else if (!_sessionReminderShown && base.Visible)
		{
			_sessionReminderShown = true;
			MessageBox.Show($"Your session ends in about {_prefs.SessionReminderMinutesBefore} minutes. Add more time from the top bar if you'd like to keep playing.", "Session ending soon", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
		}
	}

	private async Task OnIdleTimeoutAsync()
	{
		if (_isMember)
		{
			await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
		}
	}

	private void ShowTopBarCoinPanel()
	{
		_addTimeButton.Visible = false;
		_topBarCoinPanel = new CoinInsertPanel(_api, _config, "pc_rental")
		{
			Left = 150,
			Top = 8,
			Width = 260
		};
		_topBarCoinPanel.Cancelled += HideTopBarCoinPanel;
		_topBarCoinPanel.Completed += delegate
		{
			HideTopBarCoinPanel();
		};
		_topBar.Controls.Add(_topBarCoinPanel);
		_topBarCoinPanel.BringToFront();
	}

	private void HideTopBarCoinPanel()
	{
		_topBarCoinPanel?.Dispose();
		_topBarCoinPanel = null;
		_addTimeButton.Visible = true;
	}

	public async Task CleanUpOnExitIfEnabledAsync()
	{
		if (!_prefs.CleanUpOnExit)
		{
			return;
		}
		WhitelistedAppsResponse whitelistedAppsResponse;
		try
		{
			whitelistedAppsResponse = await _api.GetWhitelistedAppsAsync(_config.Mac, _config.DeviceSecret);
		}
		catch
		{
			return;
		}
		if (whitelistedAppsResponse == null || !whitelistedAppsResponse.Success)
		{
			return;
		}
		HashSet<string> hashSet = new HashSet<string>(whitelistedAppsResponse.Apps, StringComparer.OrdinalIgnoreCase);
		_ = Process.GetCurrentProcess().ProcessName;
		Process[] processes = Process.GetProcesses();
		foreach (Process process in processes)
		{
			try
			{
				if (process.Id != Environment.ProcessId && !hashSet.Contains(process.ProcessName) && !string.IsNullOrEmpty(process.MainWindowTitle))
				{
					process.CloseMainWindow();
				}
			}
			catch
			{
			}
		}
	}
}
