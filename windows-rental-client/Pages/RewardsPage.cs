using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Points balance + redeem rates + Claim buttons - a direct port of the
// retired CountdownWidget's BuildPointsView/LoadPointsAsync logic (that
// code already worked, this just gives it a permanent page instead of a
// popup sub-view). Hidden entirely for a guest session by CafeHomeForm,
// same as the corner widget used to do.
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
        Padding = new Padding(30);

        var title = new Label { Text = "REWARDS", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = true, Left = 30, Top = 20 };
        Controls.Add(title);

        _balanceLabel = new Label { Font = new Font("Segoe UI", 28, FontStyle.Bold), AutoSize = true, Left = 30, Top = 60 };
        Controls.Add(_balanceLabel);

        _statusLabel = new Label { Font = new Font("Segoe UI", 10), AutoSize = true, Left = 30, Top = 110 };
        Controls.Add(_statusLabel);

        _ratesPanel = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown, AutoScroll = true, WrapContents = false,
            Left = 30, Top = 150, Width = 500, Height = 400
        };
        Controls.Add(_ratesPanel);

        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
        ApplyTheme();
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
        foreach (Control c in Controls)
        {
            if (c is Label l) l.ForeColor = Theme.TextPrimary;
        }
        _statusLabel.ForeColor = Theme.TextMuted;
    }

    public async Task RefreshAsync()
    {
        var result = await _api.GetMemberPointsAsync(_config.Mac, _config.DeviceSecret);
        if (IsDisposed || !IsHandleCreated) return;

        _ratesPanel.Controls.Clear();
        if (result == null || !result.Success)
        {
            _balanceLabel.Text = "-- points";
            _statusLabel.Text = result?.Message ?? "Could not load rewards.";
            return;
        }

        _balanceLabel.Text = $"{result.Points} POINTS";
        var rates = result.RedeemRates ?? new List<RedeemRate>();
        _statusLabel.Text = rates.Count == 0 ? "No promos set up yet." : "";

        foreach (var rate in rates)
        {
            var minutes = rate.RewardSeconds / 60;
            var row = new RoundedPanel { Width = 460, Height = 50, Margin = new Padding(0, 0, 0, 10), BackColor = Theme.Surface, CornerRadius = 8 };
            var label = new Label { Text = $"{rate.Points} pts  →  {minutes} min", ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 10), Left = 16, Top = 14, AutoSize = true };
            var claimButton = new CardButton { Text = "CLAIM", Width = 90, Height = 34, Left = 460 - 106, Top = 8, CornerRadius = 6, BackColor = Theme.Accent, Enabled = result.Points >= rate.Points };
            claimButton.Click += async (_, _) => await OnClaimClicked(rate, claimButton);
            row.Controls.Add(label);
            row.Controls.Add(claimButton);
            _ratesPanel.Controls.Add(row);
        }
    }

    private async Task OnClaimClicked(RedeemRate rate, CardButton claimButton)
    {
        claimButton.Enabled = false;
        var result = await _api.RedeemAsync(_config.Mac, _config.DeviceSecret, rate.Id);
        if (result != null && result.Success)
        {
            _balanceLabel.Text = $"{result.RemainingPoints} POINTS";
            foreach (Control c in _ratesPanel.Controls)
            {
                if (c is RoundedPanel row)
                {
                    foreach (Control rc in row.Controls)
                    {
                        if (rc is CardButton b) b.Enabled = false;
                    }
                }
            }
            await RefreshAsync(); // re-evaluate affordability against the new balance
        }
        else
        {
            MessageBox.Show(result?.Message ?? "Claim failed", "Rewards", MessageBoxButtons.OK, MessageBoxIcon.Error);
            claimButton.Enabled = true;
        }
    }
}
