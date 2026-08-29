namespace StarkFiRentalClient;

// Small persistent corner widget shown while unlocked - lets the
// customer see their time winding down without having to ask staff.
// Logout button only shows for a logged-in MEMBER session (guests have
// no login to end - staff manage guest credit from the admin panel,
// same as before this feature existed).
public class CountdownWidget : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly Label _timeLabel;
    private readonly Label _userLabel;
    private readonly Button _logoutButton;

    public CountdownWidget(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;

        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        Width = 220;
        Height = 70;
        BackColor = Color.FromArgb(30, 30, 30);
        StartPosition = FormStartPosition.Manual;
        var screen = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(screen.Right - Width - 12, screen.Bottom - Height - 12);

        _timeLabel = new Label { ForeColor = Color.White, Font = new Font("Segoe UI", 14, FontStyle.Bold), Left = 10, Top = 6, Width = 200, Height = 28 };
        _userLabel = new Label { ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 8), Left = 10, Top = 34, Width = 130, Height = 18 };
        _logoutButton = new Button { Text = "Logout", Width = 70, Height = 22, Left = 138, Top = 34, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Visible = false };
        _logoutButton.Click += async (_, _) => await OnLogoutClicked();

        Controls.Add(_timeLabel);
        Controls.Add(_userLabel);
        Controls.Add(_logoutButton);
    }

    public void UpdateFromStatus(StatusResponse status)
    {
        var minutes = (int)status.MinutesRemaining;
        var seconds = (int)((status.MinutesRemaining - minutes) * 60);
        _timeLabel.Text = $"{minutes:D2}:{seconds:D2} left";
        var isMember = !string.IsNullOrEmpty(status.LoggedInUser);
        _userLabel.Text = isMember ? status.LoggedInUser : "Guest session";
        _logoutButton.Visible = isMember;
    }

    private async Task OnLogoutClicked()
    {
        _logoutButton.Enabled = false;
        try
        {
            await _api.MemberLogoutAsync(_config.Mac, _config.DeviceSecret);
            // Next poll picks up the now-locked state and swaps back to
            // LockForm - no need to duplicate that transition here.
        }
        finally
        {
            _logoutButton.Enabled = true;
        }
    }
}
