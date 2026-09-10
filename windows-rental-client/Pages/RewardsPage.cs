using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

public class RewardsPage : UserControl
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly Label _balanceLabel;

	private readonly FlowLayoutPanel _ratesPanel;

	private readonly Label _statusLabel;

	public RewardsPage(RentalApiClient api, ClientConfig config)
	{
		_api = api;
		_config = config;
		Dock = DockStyle.Fill;
		BackColor = Theme.Background;
		base.Padding = new Padding(30);
		Label value = new Label
		{
			Text = "REWARDS",
			Font = new Font("Segoe UI", 16f, FontStyle.Bold),
			AutoSize = true,
			Left = 30,
			Top = 20
		};
		base.Controls.Add(value);
		_balanceLabel = new Label
		{
			Font = new Font("Segoe UI", 28f, FontStyle.Bold),
			AutoSize = true,
			Left = 30,
			Top = 60
		};
		base.Controls.Add(_balanceLabel);
		_statusLabel = new Label
		{
			Font = new Font("Segoe UI", 10f),
			AutoSize = true,
			Left = 30,
			Top = 110
		};
		base.Controls.Add(_statusLabel);
		_ratesPanel = new FlowLayoutPanel
		{
			FlowDirection = FlowDirection.TopDown,
			AutoScroll = true,
			WrapContents = false,
			Left = 30,
			Top = 150,
			Width = 500,
			Height = 400
		};
		base.Controls.Add(_ratesPanel);
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
		_statusLabel.ForeColor = Theme.TextMuted;
	}

	public async Task RefreshAsync()
	{
		ApiResult apiResult = await _api.GetMemberPointsAsync(_config.Mac, _config.DeviceSecret);
		if (base.IsDisposed || !base.IsHandleCreated)
		{
			return;
		}
		_ratesPanel.Controls.Clear();
		if (apiResult == null || !apiResult.Success)
		{
			_balanceLabel.Text = "-- points";
			_statusLabel.Text = apiResult?.Message ?? "Could not load rewards.";
			return;
		}
		_balanceLabel.Text = $"{apiResult.Points} POINTS";
		List<RedeemRate> list = apiResult.RedeemRates ?? new List<RedeemRate>();
		_statusLabel.Text = ((list.Count == 0) ? "No promos set up yet." : "");
		foreach (RedeemRate rate in list)
		{
			int value = rate.RewardSeconds / 60;
			RoundedPanel roundedPanel = new RoundedPanel
			{
				Width = 460,
				Height = 50,
				Margin = new Padding(0, 0, 0, 10),
				BackColor = Theme.Surface,
				CornerRadius = 8
			};
			Label value2 = new Label
			{
				Text = $"{rate.Points} pts  →  {value} min",
				ForeColor = Theme.TextPrimary,
				Font = new Font("Segoe UI", 10f),
				Left = 16,
				Top = 14,
				AutoSize = true
			};
			CardButton claimButton = new CardButton
			{
				Text = "CLAIM",
				Width = 90,
				Height = 34,
				Left = 354,
				Top = 8,
				CornerRadius = 6,
				BackColor = Theme.Accent,
				Enabled = (apiResult.Points >= rate.Points)
			};
			claimButton.Click += async delegate
			{
				await OnClaimClicked(rate, claimButton);
			};
			roundedPanel.Controls.Add(value2);
			roundedPanel.Controls.Add(claimButton);
			_ratesPanel.Controls.Add(roundedPanel);
		}
	}

	private async Task OnClaimClicked(RedeemRate rate, CardButton claimButton)
	{
		claimButton.Enabled = false;
		ApiResult apiResult = await _api.RedeemAsync(_config.Mac, _config.DeviceSecret, rate.Id);
		if (apiResult != null && apiResult.Success)
		{
			_balanceLabel.Text = $"{apiResult.RemainingPoints} POINTS";
			foreach (Control control in _ratesPanel.Controls)
			{
				if (!(control is RoundedPanel roundedPanel))
				{
					continue;
				}
				foreach (Control control2 in roundedPanel.Controls)
				{
					if (control2 is CardButton cardButton)
					{
						cardButton.Enabled = false;
					}
				}
			}
			await RefreshAsync();
		}
		else
		{
			MessageBox.Show(apiResult?.Message ?? "Claim failed", "Rewards", MessageBoxButtons.OK, MessageBoxIcon.Hand);
			claimButton.Enabled = true;
		}
	}
}
