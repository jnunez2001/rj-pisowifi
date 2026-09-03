using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Remaining time, session info, Add Time, Logout - the fuller version
// of what the top bar shows compactly. Updated from CafeHomeForm's own
// StatusResponse polling (via UpdateFromStatus), not its own poll loop.
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

        var title = new Label { Text = "MY SESSION", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = true, Left = 30, Top = 20 };
        Controls.Add(title);

        _summaryPanel = new Panel { Left = 30, Top = 70, Width = 500, Height = 260 };
        Controls.Add(_summaryPanel);

        _timeLabel = new Label { Font = new Font("Segoe UI", 36, FontStyle.Bold), AutoSize = true, Left = 0, Top = 0 };
        _sessionInfoLabel = new Label { Font = new Font("Segoe UI", 10), AutoSize = true, Left = 0, Top = 60 };
        _addTimeButton = new CardButton { Text = "ADD TIME", Width = 220, Height = 44, Left = 0, Top = 110, CornerRadius = 8 };
        _addTimeButton.Click += (_, _) => ShowCoinPanel();
        _logoutButton = new CardButton { Text = "LOGOUT", Width = 220, Height = 44, Left = 0, Top = 164, CornerRadius = 8 };
        _logoutButton.Click += async (_, _) => await OnLogoutClicked();

        _summaryPanel.Controls.Add(_timeLabel);
        _summaryPanel.Controls.Add(_sessionInfoLabel);
        _summaryPanel.Controls.Add(_addTimeButton);
        _summaryPanel.Controls.Add(_logoutButton);

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
        _timeLabel.ForeColor = Theme.TextPrimary;
        _sessionInfoLabel.ForeColor = Theme.TextMuted;
        _addTimeButton.BackColor = Theme.Accent;
        _logoutButton.BackColor = Theme.Surface;
    }

    public void UpdateFromStatus(StatusResponse status)
    {
        var minutes = (int)status.MinutesRemaining;
        var seconds = (int)((status.MinutesRemaining - minutes) * 60);
        _timeLabel.Text = $"{minutes:D2}:{seconds:D2}";
        _isMember = !string.IsNullOrEmpty(status.LoggedInUser);
        _sessionInfoLabel.Text = _isMember
            ? $"Member: {status.LoggedInUser}  •  {status.PcName}"
            : $"Guest session  •  {status.PcName}";
        _logoutButton.Visible = _isMember;
    }

    private void ShowCoinPanel()
    {
        _addTimeButton.Visible = false;
        _logoutButton.Visible = false;
        _coinPanel = new CoinInsertPanel(_api, _config, "pc_rental") { Left = 0, Top = 110 };
        _coinPanel.Cancelled += HideCoinPanel;
        _coinPanel.Completed += _ => HideCoinPanel();
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
            // Next poll picks up the now-logged-out state - Program.cs's
            // HandleStatus doesn't change screens on logout alone (still
            // unlocked with guest time, if any remains), no need to
            // duplicate that transition here.
        }
        finally
        {
            _logoutButton.Enabled = true;
        }
    }
}
