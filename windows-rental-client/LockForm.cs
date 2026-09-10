using System;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

public class LockForm : Form
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly KeyboardBlocker _keyboardBlocker = new KeyboardBlocker();

	private readonly Timer _clockTimer;

	private PictureBox _wallpaperBox;

	private Label _pcNameLabel;

	private Label _statusDotLabel;

	private Label _clockLabel;

	private Panel _centerPanel;

	private PictureBox _logoBox;

	private Label _welcomeLabel;

	private Label _cafeNameLabel;

	private Label _announcementLabel;

	private Panel _homeView;

	private RoundedPanel _guestCard;

	private RoundedPanel _memberCard;

	private FlowLayoutPanel _footerRow;

	private Label _serverStatusLabel;

	private Label _networkStatusLabel;

	private Panel _loginView;

	private TextBox _usernameBox;

	private TextBox _passwordBox;

	private Button _loginButton;

	private Button _loginBackButton;

	private Label _loginErrorLabel;

	private CoinInsertPanel? _coinPanel;

	private bool _connected = true;

	private string? _instructionsText;

	public LockForm(RentalApiClient api, ClientConfig config)
	{
		_api = api;
		_config = config;
		_clockTimer = new Timer
		{
			Interval = 1000
		};
		_clockTimer.Tick += delegate
		{
			_clockLabel.Text = DateTime.Now.ToString("hh:mm tt\nMMM d, yyyy");
		};
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ApplyTheme);
			}
		};
		BuildUi();
	}

	private void BuildUi()
	{
		base.FormBorderStyle = FormBorderStyle.None;
		base.WindowState = FormWindowState.Maximized;
		base.TopMost = true;
		base.StartPosition = FormStartPosition.Manual;
		base.Bounds = Screen.PrimaryScreen.Bounds;
		base.ShowInTaskbar = false;
		base.KeyPreview = true;
		_wallpaperBox = new PictureBox
		{
			Dock = DockStyle.Fill,
			SizeMode = PictureBoxSizeMode.StretchImage
		};
		base.Controls.Add(_wallpaperBox);
		BuildHeader();
		BuildCenter();
		BuildFooter();
		base.FormClosing += delegate(object? _, FormClosingEventArgs e)
		{
			if (base.Visible)
			{
				e.Cancel = true;
			}
		};
		_clockTimer.Start();
		_clockLabel.Text = DateTime.Now.ToString("hh:mm tt\nMMM d, yyyy");
		ApplyTheme();
		ShowHomeView();
	}

	private void BuildHeader()
	{
		Panel header = new Panel
		{
			Dock = DockStyle.Top,
			Height = 70
		};
		base.Controls.Add(header);
		_pcNameLabel = new Label
		{
			Font = new Font("Segoe UI", 13f, FontStyle.Bold),
			AutoSize = true,
			Left = 24,
			Top = 22
		};
		header.Controls.Add(_pcNameLabel);
		_statusDotLabel = new Label
		{
			Font = new Font("Segoe UI", 10f, FontStyle.Bold),
			AutoSize = true,
			Top = 26
		};
		header.Controls.Add(_statusDotLabel);
		_clockLabel = new Label
		{
			Font = new Font("Segoe UI", 10f),
			AutoSize = false,
			Width = 220,
			Height = 44,
			TextAlign = ContentAlignment.MiddleRight,
			Top = 12
		};
		header.Controls.Add(_clockLabel);
		header.Resize += delegate
		{
			_clockLabel.Left = header.Width - _clockLabel.Width - 24;
		};
		header.Resize += delegate
		{
			RepositionStatusDot();
		};
		header.BringToFront();
		_wallpaperBox.SendToBack();
	}

	private void RepositionStatusDot()
	{
		_statusDotLabel.Left = _pcNameLabel.Right + 14;
	}

	private void BuildCenter()
	{
		_centerPanel = new Panel
		{
			Width = 900,
			Height = 560
		};
		base.Controls.Add(_centerPanel);
		_centerPanel.BringToFront();
		_logoBox = new PictureBox
		{
			SizeMode = PictureBoxSizeMode.Zoom,
			Width = 140,
			Height = 70,
			Left = (_centerPanel.Width - 140) / 2,
			Top = 0
		};
		_centerPanel.Controls.Add(_logoBox);
		_welcomeLabel = new Label
		{
			Text = "WELCOME TO",
			Font = new Font("Segoe UI", 11f, FontStyle.Bold),
			AutoSize = false,
			Width = _centerPanel.Width,
			Height = 24,
			Top = 82,
			TextAlign = ContentAlignment.MiddleCenter
		};
		_centerPanel.Controls.Add(_welcomeLabel);
		_cafeNameLabel = new Label
		{
			Font = new Font("Segoe UI", 24f, FontStyle.Bold),
			AutoSize = false,
			Width = _centerPanel.Width,
			Height = 44,
			Top = 106,
			TextAlign = ContentAlignment.MiddleCenter
		};
		_centerPanel.Controls.Add(_cafeNameLabel);
		_announcementLabel = new Label
		{
			Font = new Font("Segoe UI", 9f),
			AutoSize = false,
			Width = _centerPanel.Width - 80,
			Height = 30,
			Left = 40,
			Top = 154,
			TextAlign = ContentAlignment.MiddleCenter
		};
		_centerPanel.Controls.Add(_announcementLabel);
		BuildHomeView();
		BuildLoginView();
	}

	private void BuildHomeView()
	{
		_homeView = new Panel
		{
			Left = 0,
			Top = 200,
			Width = _centerPanel.Width,
			Height = 320
		};
		_centerPanel.Controls.Add(_homeView);
		int num = 420;
		int height = 300;
		int num2 = 40;
		int num3 = num * 2 + num2;
		int num4 = (_homeView.Width - num3) / 2;
		_guestCard = BuildCard("GUEST", "Play without an account", "Insert credits and start playing", "CONTINUE AS GUEST", num4, num, height, delegate
		{
			ShowCoinPanel("pc_rental");
		});
		_memberCard = BuildCard("MEMBER LOGIN", "Login to your account", "Save time, earn points, unlock rewards", "LOGIN", num4 + num + num2, num, height, ShowLoginView);
		_homeView.Controls.Add(_guestCard);
		_homeView.Controls.Add(_memberCard);
	}

	private RoundedPanel BuildCard(string title, string subtitle, string description, string buttonText, int left, int width, int height, Action onClick)
	{
		RoundedPanel roundedPanel = new RoundedPanel();
		roundedPanel.Left = left;
		roundedPanel.Top = 0;
		roundedPanel.Width = width;
		roundedPanel.Height = height;
		roundedPanel.Cursor = Cursors.Hand;
		roundedPanel.CornerRadius = 16;
		Label label = new Label
		{
			Text = title,
			Font = new Font("Segoe UI", 16f, FontStyle.Bold),
			AutoSize = false,
			Width = width,
			Height = 30,
			Top = 90,
			TextAlign = ContentAlignment.MiddleCenter,
			Cursor = Cursors.Hand
		};
		Label label2 = new Label
		{
			Text = subtitle,
			Font = new Font("Segoe UI", 10f, FontStyle.Bold),
			AutoSize = false,
			Width = width,
			Height = 22,
			Top = 130,
			TextAlign = ContentAlignment.MiddleCenter,
			Cursor = Cursors.Hand
		};
		Label label3 = new Label
		{
			Text = description,
			Font = new Font("Segoe UI", 8f),
			AutoSize = false,
			Width = width,
			Height = 20,
			Top = 152,
			TextAlign = ContentAlignment.MiddleCenter,
			Cursor = Cursors.Hand
		};
		CardButton cardButton = new CardButton
		{
			Text = buttonText,
			Width = width - 60,
			Height = 42,
			Left = 30,
			Top = 220,
			CornerRadius = 8
		};
		roundedPanel.Controls.Add(label);
		roundedPanel.Controls.Add(label2);
		roundedPanel.Controls.Add(label3);
		roundedPanel.Controls.Add(cardButton);
		roundedPanel.Click += delegate
		{
			onClick();
		};
		label.Click += delegate
		{
			onClick();
		};
		label2.Click += delegate
		{
			onClick();
		};
		label3.Click += delegate
		{
			onClick();
		};
		cardButton.Click += delegate
		{
			onClick();
		};
		return roundedPanel;
	}

	private void BuildLoginView()
	{
		_loginView = new Panel
		{
			Left = 0,
			Top = 200,
			Width = _centerPanel.Width,
			Height = 320,
			Visible = false
		};
		_centerPanel.Controls.Add(_loginView);
		int num = 320;
		int left = (_centerPanel.Width - num) / 2;
		_usernameBox = new TextBox
		{
			PlaceholderText = "Username",
			Width = num,
			Left = left,
			Top = 20,
			Font = new Font("Segoe UI", 11f)
		};
		_loginView.Controls.Add(_usernameBox);
		_passwordBox = new TextBox
		{
			PlaceholderText = "Password",
			PasswordChar = '*',
			Width = num,
			Left = left,
			Top = 60,
			Font = new Font("Segoe UI", 11f)
		};
		_loginView.Controls.Add(_passwordBox);
		_loginButton = new CardButton
		{
			Text = "LOG IN",
			Width = num,
			Height = 42,
			Left = left,
			Top = 100,
			CornerRadius = 8
		};
		_loginButton.Click += async delegate
		{
			await OnLoginClicked();
		};
		_loginView.Controls.Add(_loginButton);
		_loginErrorLabel = new Label
		{
			ForeColor = Color.OrangeRed,
			Width = num,
			Left = left,
			Top = 150,
			TextAlign = ContentAlignment.MiddleCenter,
			Height = 24
		};
		_loginView.Controls.Add(_loginErrorLabel);
		Button button = new Button();
		button.Text = "Back";
		button.Width = num;
		button.Left = left;
		button.Top = 184;
		button.FlatStyle = FlatStyle.Flat;
		button.FlatAppearance.BorderSize = 0;
		_loginBackButton = button;
		_loginBackButton.Click += delegate
		{
			ShowHomeView();
		};
		_loginView.Controls.Add(_loginBackButton);
	}

	private void BuildFooter()
	{
		_footerRow = new FlowLayoutPanel
		{
			FlowDirection = FlowDirection.LeftToRight,
			AutoSize = true,
			WrapContents = false,
			Width = 700,
			Height = 60
		};
		base.Controls.Add(_footerRow);
		_footerRow.Location = new Point((base.Bounds.Width - _footerRow.Width) / 2, base.Bounds.Height - 180);
		CardButton cardButton = SmallFooterButton("REGISTER\nAS MEMBER");
		cardButton.Click += delegate
		{
			ShowCoinPanel("pc_rental_create_account");
		};
		CardButton cardButton2 = SmallFooterButton("HOW TO PLAY\n(INSTRUCTIONS)");
		cardButton2.Click += delegate
		{
			ShowInstructions();
		};
		CardButton cardButton3 = SmallFooterButton("NEED HELP?\nCALL STAFF");
		cardButton3.Click += async delegate
		{
			await OnCallStaffClicked();
		};
		_footerRow.Controls.Add(cardButton);
		_footerRow.Controls.Add(cardButton2);
		_footerRow.Controls.Add(cardButton3);
		_footerRow.BringToFront();
		Panel statusFooter = new Panel
		{
			Dock = DockStyle.Bottom,
			Height = 44
		};
		base.Controls.Add(statusFooter);
		_serverStatusLabel = new Label
		{
			Font = new Font("Segoe UI", 8f, FontStyle.Bold),
			AutoSize = true,
			Left = 24,
			Top = 14
		};
		statusFooter.Controls.Add(_serverStatusLabel);
		Label secureLabel = new Label
		{
			Text = "SECURE ENVIRONMENT - MONITORED & PROTECTED",
			Font = new Font("Segoe UI", 8f),
			AutoSize = true,
			Top = 14
		};
		statusFooter.Controls.Add(secureLabel);
		statusFooter.Resize += delegate
		{
			secureLabel.Left = (statusFooter.Width - secureLabel.Width) / 2;
		};
		_networkStatusLabel = new Label
		{
			Font = new Font("Segoe UI", 8f, FontStyle.Bold),
			AutoSize = true,
			Top = 14
		};
		statusFooter.Controls.Add(_networkStatusLabel);
		statusFooter.Resize += delegate
		{
			_networkStatusLabel.Left = statusFooter.Width - _networkStatusLabel.Width - 100;
		};
		Label versionLabel = new Label
		{
			Text = "v1.0.0",
			Font = new Font("Segoe UI", 8f),
			AutoSize = true,
			Top = 14
		};
		statusFooter.Controls.Add(versionLabel);
		statusFooter.Resize += delegate
		{
			versionLabel.Left = statusFooter.Width - 60;
		};
		statusFooter.BringToFront();
		Button button = new Button();
		button.Text = "Staff";
		button.Width = 70;
		button.Height = 26;
		button.FlatStyle = FlatStyle.Flat;
		button.FlatAppearance.BorderSize = 0;
		Button button2 = button;
		button2.Click += async delegate
		{
			await OnStaffClicked();
		};
		base.Controls.Add(button2);
		button2.Location = new Point(base.Bounds.Width - 90, 20);
		button2.BringToFront();
	}

	private CardButton SmallFooterButton(string text)
	{
		return new CardButton
		{
			Text = text,
			Width = 180,
			Height = 56,
			Margin = new Padding(10, 0, 10, 0),
			Font = new Font("Segoe UI", 8f, FontStyle.Bold),
			CornerRadius = 8
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
		foreach (Control control in _guestCard.Controls)
		{
			if (control is Label label)
			{
				label.ForeColor = Theme.TextPrimary;
			}
			if (control is CardButton cardButton)
			{
				cardButton.BackColor = Theme.Accent;
				cardButton.ForeColor = Color.White;
			}
		}
		foreach (Control control2 in _memberCard.Controls)
		{
			if (control2 is Label label2)
			{
				label2.ForeColor = Theme.TextPrimary;
			}
			if (control2 is CardButton cardButton2)
			{
				cardButton2.BackColor = Theme.AccentAlt;
				cardButton2.ForeColor = Color.White;
			}
		}
		_loginErrorLabel.ForeColor = Theme.Danger;
		_loginButton.BackColor = Theme.Accent;
		_usernameBox.BackColor = Theme.Surface;
		_usernameBox.ForeColor = Theme.TextPrimary;
		_passwordBox.BackColor = Theme.Surface;
		_passwordBox.ForeColor = Theme.TextPrimary;
		foreach (Control control3 in _footerRow.Controls)
		{
			if (control3 is CardButton cardButton3)
			{
				cardButton3.BackColor = Theme.Surface;
				cardButton3.ForeColor = Theme.TextPrimary;
			}
		}
		RefreshStatusLabels();
	}

	private void RefreshStatusLabels()
	{
		_serverStatusLabel.Text = (_connected ? "SERVER STATUS: ONLINE" : "SERVER STATUS: OFFLINE");
		_serverStatusLabel.ForeColor = (_connected ? Theme.Success : Theme.Danger);
		_networkStatusLabel.Text = (_connected ? "NETWORK: CONNECTED" : "NETWORK: DISCONNECTED");
		_networkStatusLabel.ForeColor = (_connected ? Theme.Success : Theme.Danger);
	}

	public void SetConnected(bool connected)
	{
		if (_connected != connected)
		{
			_connected = connected;
			RefreshStatusLabels();
		}
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
		_centerPanel.Left = (base.Bounds.Width - _centerPanel.Width) / 2;
		_centerPanel.Top = (base.Bounds.Height - _centerPanel.Height) / 2 - 40;
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
		_coinPanel = new CoinInsertPanel(_api, _config, mode)
		{
			Left = (_centerPanel.Width - 280) / 2,
			Top = 20
		};
		_coinPanel.Cancelled += ShowHomeView;
		_coinPanel.Completed += OnCoinPanelCompleted;
		_centerPanel.Controls.Add(_coinPanel);
		_coinPanel.BringToFront();
	}

	private void OnCoinPanelCompleted(ApiResult result)
	{
		if (result.AccountCreated)
		{
			MessageBox.Show($"Account \"{result.Username}\" created with {result.Seconds / 60} minutes. You can log in now.", "Account created", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
		}
		ShowHomeView();
	}

	private void ShowInstructions()
	{
		MessageBox.Show(string.IsNullOrWhiteSpace(_instructionsText) ? "Insert coins on the Guest card, or log in with your member account. Ask staff if you need help." : _instructionsText, "How to Play", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
	}

	private async Task OnCallStaffClicked()
	{
		MessageBox.Show((await _api.RequestHelpAsync(_config.Mac, _config.DeviceSecret))?.Message ?? "Staff has been notified.", "Call Staff", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
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
		_statusDotLabel.Text = (status.Locked ? "● LOCKED" : "● AVAILABLE");
		_statusDotLabel.ForeColor = (status.Locked ? Theme.Danger : Theme.Success);
		RepositionStatusDot();
		_cafeNameLabel.Text = (string.IsNullOrWhiteSpace(status.PcName) ? "STARKFI ESPORTS CAFÉ" : status.PcName);
		_announcementLabel.Text = status.LockAnnouncement ?? "";
		_instructionsText = status.InstructionsText;
		LoadImageAsync(_wallpaperBox, status.WallpaperUrl);
		LoadImageAsync(_logoBox, status.LogoUrl);
		if (!base.Visible)
		{
			ShowHomeView();
		}
		Show();
		_keyboardBlocker.Install();
		base.WindowState = FormWindowState.Maximized;
		base.TopMost = true;
		RecenterHomeView();
		Activate();
	}

	private async void LoadImageAsync(PictureBox box, string? url)
	{
		if (string.IsNullOrEmpty(url))
		{
			box.Image = null;
			return;
		}
		try
		{
			string requestUri = (url.StartsWith("http") ? url : (_config.ServerUrl.TrimEnd('/') + url));
			using HttpClient client = new HttpClient();
			using MemoryStream stream = new MemoryStream(await client.GetByteArrayAsync(requestUri));
			box.Image = Image.FromStream(stream);
		}
		catch
		{
		}
	}

	private async Task OnLoginClicked()
	{
		_loginErrorLabel.Text = "";
		_loginButton.Enabled = false;
		try
		{
			ApiResult apiResult = await _api.MemberLoginAsync(_config.Mac, _config.DeviceSecret, _usernameBox.Text, _passwordBox.Text);
			if (apiResult == null || !apiResult.Success)
			{
				_loginErrorLabel.Text = apiResult?.Message ?? "Login failed";
			}
			else
			{
				_passwordBox.Text = "";
			}
		}
		finally
		{
			_loginButton.Enabled = true;
		}
	}

	public async Task OnStaffClicked()
	{
		string text = PromptDialog.Show("Staff Access", "Enter the app password:", isPassword: true);
		if (string.IsNullOrEmpty(text))
		{
			return;
		}
		switch (MessageBox.Show("Force Unlock now (temporary, re-locks on the next status check)?\n\nChoose No to Pause instead - suspends enforcement until resumed from here or from the admin panel.", "Staff Access", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question))
		{
		case DialogResult.Cancel:
			break;
		case DialogResult.Yes:
		{
			ApiResult apiResult2 = await _api.StaffOverrideAsync(_config.Mac, _config.DeviceSecret, text);
			if (apiResult2 == null || !apiResult2.Success)
			{
				MessageBox.Show(apiResult2?.Message ?? "Override failed", "Staff Access", MessageBoxButtons.OK, MessageBoxIcon.Hand);
			}
			else
			{
				HideLock();
			}
			break;
		}
		default:
		{
			ApiResult apiResult = await _api.PauseAsync(_config.Mac, _config.DeviceSecret, text);
			if (apiResult == null || !apiResult.Success)
			{
				MessageBox.Show(apiResult?.Message ?? "Pause failed", "Staff Access", MessageBoxButtons.OK, MessageBoxIcon.Hand);
			}
			break;
		}
		}
	}
}
