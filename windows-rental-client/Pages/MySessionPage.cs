using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

public class MySessionPage : UserControl
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly Label _timeLabel;

	private readonly Label _sessionInfoLabel;

	private readonly CardButton _addTimeButton;

	private readonly CardButton _logoutButton;

	private readonly Panel _summaryPanel;

	private CoinInsertPanel? _coinPanel;

	private bool _isMember;

	public MySessionPage(RentalApiClient api, ClientConfig config)
	{
		_api = api;
		_config = config;
		Dock = DockStyle.Fill;
		BackColor = Theme.Background;
		Label value = new Label
		{
			Text = "MY SESSION",
			Font = new Font("Segoe UI", 16f, FontStyle.Bold),
			AutoSize = true,
			Left = 30,
			Top = 20
		};
		base.Controls.Add(value);
		_summaryPanel = new Panel
		{
			Left = 30,
			Top = 70,
			Width = 500,
			Height = 260
		};
		base.Controls.Add(_summaryPanel);
		_timeLabel = new Label
		{
			Font = new Font("Segoe UI", 36f, FontStyle.Bold),
			AutoSize = true,
			Left = 0,
			Top = 0
		};
		_sessionInfoLabel = new Label
		{
			Font = new Font("Segoe UI", 10f),
			AutoSize = true,
			Left = 0,
			Top = 60
		};
		_addTimeButton = new CardButton
		{
			Text = "ADD TIME",
			Width = 220,
			Height = 44,
			Left = 0,
			Top = 110,
			CornerRadius = 8
		};
		_addTimeButton.Click += delegate
		{
			ShowCoinPanel();
		};
		_logoutButton = new CardButton
		{
			Text = "LOGOUT",
			Width = 220,
			Height = 44,
			Left = 0,
			Top = 164,
			CornerRadius = 8
		};
		_logoutButton.Click += async delegate
		{
			await OnLogoutClicked();
		};
		_summaryPanel.Controls.Add(_timeLabel);
		_summaryPanel.Controls.Add(_sessionInfoLabel);
		_summaryPanel.Controls.Add(_addTimeButton);
		_summaryPanel.Controls.Add(_logoutButton);
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ApplyTheme);
			}
		};
		ApplyTheme();
	}

	private void ApplyTheme()
	{
		BackColor = Theme.Background;
		foreach (Control control in base.Controls)
		{
			if (control is Label label)
			{
				label.ForeColor = Theme.TextPrimary;
			}
		}
		_timeLabel.ForeColor = Theme.TextPrimary;
		_sessionInfoLabel.ForeColor = Theme.TextMuted;
		_addTimeButton.BackColor = Theme.Accent;
		_logoutButton.BackColor = Theme.Surface;
	}

	public void UpdateFromStatus(StatusResponse status)
	{
		int num = (int)status.MinutesRemaining;
		int value = (int)((status.MinutesRemaining - (double)num) * 60.0);
		_timeLabel.Text = $"{num:D2}:{value:D2}";
		_isMember = !string.IsNullOrEmpty(status.LoggedInUser);
		_sessionInfoLabel.Text = (_isMember ? ("Member: " + status.LoggedInUser + "  •  " + status.PcName) : ("Guest session  •  " + status.PcName));
		_logoutButton.Visible = _isMember;
	}

	private void ShowCoinPanel()
	{
		_addTimeButton.Visible = false;
		_logoutButton.Visible = false;
		_coinPanel = new CoinInsertPanel(_api, _config, "pc_rental")
		{
			Left = 0,
			Top = 110
		};
		_coinPanel.Cancelled += HideCoinPanel;
		_coinPanel.Completed += delegate
		{
			HideCoinPanel();
		};
		_summaryPanel.Controls.Add(_coinPanel);
		_coinPanel.BringToFront();
	}

	private void HideCoinPanel()
	{
		_coinPanel?.Dispose();
		_coinPanel = null;
		_addTimeButton.Visible = true;
		_logoutButton.Visible = _isMember;
	}

	private async Task OnLogoutClicked()
	{
		_logoutButton.Enabled = false;
		try
		{
			await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
		}
		finally
		{
			_logoutButton.Enabled = true;
		}
	}
}
