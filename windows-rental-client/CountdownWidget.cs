namespace StarkFiRentalClient;

// Small persistent corner widget shown while unlocked - lets the
// customer see their time winding down without having to ask staff.
// Starts minimized (today's compact view); an expand toggle reveals Add
// Time / Cancel / Account / Points. Logout, Account, and Points are
// hidden for a guest session (no login to end/manage - staff handles
// guest credit from the admin panel, matches existing Logout behavior).
public class CountdownWidget : Form
{
    private const int MinimizedHeight = 70;
    private const int ExpandedHeight = 260;
    private const int WidgetWidth = 260;

    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;

    private readonly Label _timeLabel;
    private readonly Label _userLabel;
    private readonly Button _logoutButton;
    private readonly Button _resumeButton;
    private readonly Button _expandButton;

    private readonly Panel _expandedMenu;
    private readonly Button _addTimeButton;
    private readonly Button _accountButton;
    private readonly Button _pointsButton;
    private readonly Button _collapseButton;

    private Control? _subView; // coin insert / account / points, one at a time
    private bool _expanded;
    private bool _isMember;
    private StatusResponse? _lastStatus;

    public CountdownWidget(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;

        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        Width = WidgetWidth;
        Height = MinimizedHeight;
        BackColor = Color.FromArgb(30, 30, 30);
        StartPosition = FormStartPosition.Manual;
        RepositionToCorner();

        _timeLabel = new Label { ForeColor = Color.White, Font = new Font("Segoe UI", 14, FontStyle.Bold), Left = 10, Top = 6, Width = 180, Height = 28 };
        _userLabel = new Label { ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 8), Left = 10, Top = 34, Width = 130, Height = 18 };
        _logoutButton = new Button { Text = "Logout", Width = 70, Height = 22, Left = 178, Top = 34, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Visible = false };
        _logoutButton.Click += async (_, _) => await OnLogoutClicked();
        // Shown instead of the countdown while a staff pause is active -
        // this same corner window is reused rather than a third window
        // type, just with different content (see ShowPaused below).
        _resumeButton = new Button { Text = "Resume", Width = 240, Height = 26, Left = 10, Top = 34, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Visible = false };
        _resumeButton.Click += async (_, _) => await OnResumeClicked();

        _expandButton = new Button { Text = "▲", Width = 22, Height = 22, Left = WidgetWidth - 30, Top = 6, BackColor = Color.FromArgb(50, 50, 50), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _expandButton.Click += (_, _) => ToggleExpanded();

        _expandedMenu = new Panel { Left = 10, Top = 66, Width = WidgetWidth - 20, Height = 180, Visible = false };
        _addTimeButton = new Button { Text = "Add Time", Width = _expandedMenu.Width, Height = 30, Top = 0, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _addTimeButton.Click += (_, _) => ShowSubView(BuildAddTimeView());
        _accountButton = new Button { Text = "Account", Width = _expandedMenu.Width, Height = 30, Top = 38, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _accountButton.Click += (_, _) => ShowSubView(BuildAccountView());
        _pointsButton = new Button { Text = "Points", Width = _expandedMenu.Width, Height = 30, Top = 76, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _pointsButton.Click += (_, _) => ShowSubView(BuildPointsView());
        _collapseButton = new Button { Text = "Cancel", Width = _expandedMenu.Width, Height = 30, Top = 114, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _collapseButton.Click += (_, _) => Collapse();
        _expandedMenu.Controls.Add(_addTimeButton);
        _expandedMenu.Controls.Add(_accountButton);
        _expandedMenu.Controls.Add(_pointsButton);
        _expandedMenu.Controls.Add(_collapseButton);

        Controls.Add(_timeLabel);
        Controls.Add(_userLabel);
        Controls.Add(_logoutButton);
        Controls.Add(_resumeButton);
        Controls.Add(_expandButton);
        Controls.Add(_expandedMenu);
    }

    private void RepositionToCorner()
    {
        var screen = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(screen.Right - Width - 12, screen.Bottom - Height - 12);
    }

    private void ToggleExpanded()
    {
        if (_expanded) Collapse();
        else Expand();
    }

    private void Expand()
    {
        _expanded = true;
        Height = ExpandedHeight;
        RepositionToCorner();
        _expandButton.Text = "▼";
        _expandedMenu.Visible = true;
        _accountButton.Visible = _isMember;
        _pointsButton.Visible = _isMember;
        ClearSubView();
    }

    private void Collapse()
    {
        _expanded = false;
        Height = MinimizedHeight;
        RepositionToCorner();
        _expandButton.Text = "▲";
        _expandedMenu.Visible = false;
        ClearSubView();
    }

    private void ClearSubView()
    {
        if (_subView != null)
        {
            Controls.Remove(_subView);
            _subView.Dispose();
            _subView = null;
        }
        _expandedMenu.Visible = _expanded;
    }

    private void ShowSubView(Control view)
    {
        ClearSubView();
        _expandedMenu.Visible = false;
        view.Left = 10;
        view.Top = 66;
        view.Width = WidgetWidth - 20;
        Controls.Add(view);
        view.BringToFront();
        _subView = view;
    }

    private Control BuildAddTimeView()
    {
        var panel = new CoinInsertPanel(_api, _config, "pc_rental") { Height = 180 };
        // Both Cancelled and Completed mean the same thing here: go back
        // to the expanded 4-button menu (there's no separate "menu view"
        // control the way LockForm has one - just re-show _expandedMenu
        // directly).
        panel.Cancelled += BackToExpandedMenu;
        panel.Completed += _ => BackToExpandedMenu();
        return panel;
    }

    private void BackToExpandedMenu()
    {
        ClearSubView();
        _expandedMenu.Visible = true;
    }

    private Control BuildAccountView()
    {
        var panel = new Panel { Height = 180 };
        var title = new Label { Text = "Change password", ForeColor = Color.White, Font = new Font("Segoe UI", 10, FontStyle.Bold), Left = 0, Top = 0, Width = panel.Width, Height = 22 };
        var currentBox = new TextBox { PlaceholderText = "Current password", PasswordChar = '*', Left = 0, Top = 30, Width = 240 };
        var newBox = new TextBox { PlaceholderText = "New password", PasswordChar = '*', Left = 0, Top = 62, Width = 240 };
        var statusLabel = new Label { ForeColor = Color.OrangeRed, Font = new Font("Segoe UI", 8), Left = 0, Top = 94, Width = 240, Height = 32 };
        var saveButton = new Button { Text = "Save", Width = 240, Height = 28, Left = 0, Top = 130, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        saveButton.Click += async (_, _) =>
        {
            saveButton.Enabled = false;
            var result = await _api.ChangePasswordAsync(_config.Mac, _config.DeviceSecret, currentBox.Text, newBox.Text);
            if (result != null && result.Success)
            {
                statusLabel.ForeColor = Color.LightGreen;
                statusLabel.Text = "Password changed.";
                currentBox.Text = "";
                newBox.Text = "";
            }
            else
            {
                statusLabel.ForeColor = Color.OrangeRed;
                statusLabel.Text = result?.Message ?? "Could not change password.";
            }
            saveButton.Enabled = true;
        };
        panel.Controls.Add(title);
        panel.Controls.Add(currentBox);
        panel.Controls.Add(newBox);
        panel.Controls.Add(statusLabel);
        panel.Controls.Add(saveButton);
        return panel;
    }

    private Control BuildPointsView()
    {
        var panel = new Panel { Height = 180, AutoScroll = true };
        var loadingLabel = new Label { Text = "Loading...", ForeColor = Color.Gainsboro, Left = 0, Top = 0, Width = 240, Height = 20 };
        panel.Controls.Add(loadingLabel);

        _ = LoadPointsAsync(panel, loadingLabel);
        return panel;
    }

    private async Task LoadPointsAsync(Panel panel, Label loadingLabel)
    {
        var result = await _api.GetMemberPointsAsync(_config.Mac, _config.DeviceSecret);
        if (panel.IsDisposed) return; // user navigated away before this returned

        panel.Controls.Clear();
        if (result == null || !result.Success)
        {
            panel.Controls.Add(new Label { Text = result?.Message ?? "Could not load points.", ForeColor = Color.OrangeRed, Left = 0, Top = 0, Width = 240, Height = 40 });
            return;
        }

        var balanceLabel = new Label { Text = $"{result.Points} points", ForeColor = Color.White, Font = new Font("Segoe UI", 12, FontStyle.Bold), Left = 0, Top = 0, Width = 240, Height = 26 };
        panel.Controls.Add(balanceLabel);

        var rates = result.RedeemRates ?? new List<RedeemRate>();
        if (rates.Count == 0)
        {
            panel.Controls.Add(new Label { Text = "No promos set up yet.", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 8), Left = 0, Top = 30, Width = 240, Height = 20 });
            return;
        }

        var top = 32;
        foreach (var rate in rates)
        {
            var minutes = rate.RewardSeconds / 60;
            var rowLabel = new Label { Text = $"{rate.Points} pts -> {minutes} min", ForeColor = Color.White, Font = new Font("Segoe UI", 9), Left = 0, Top = top, Width = 150, Height = 24 };
            var claimButton = new Button { Text = "Claim", Width = 80, Height = 24, Left = 155, Top = top, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Enabled = result.Points >= rate.Points };
            claimButton.Click += async (_, _) =>
            {
                claimButton.Enabled = false;
                var redeemResult = await _api.RedeemAsync(_config.Mac, _config.DeviceSecret, rate.Id);
                if (redeemResult != null && redeemResult.Success)
                {
                    balanceLabel.Text = $"{redeemResult.RemainingPoints} points";
                    // Refresh affordability on every row, the balance just changed.
                    foreach (Control c in panel.Controls)
                    {
                        if (c is Button b && b.Text == "Claim") b.Enabled = false;
                    }
                }
                else
                {
                    MessageBox.Show(redeemResult?.Message ?? "Claim failed", "Points", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    claimButton.Enabled = true;
                }
            };
            panel.Controls.Add(rowLabel);
            panel.Controls.Add(claimButton);
            top += 28;
        }
    }

    public void UpdateFromStatus(StatusResponse status)
    {
        _lastStatus = status;
        var minutes = (int)status.MinutesRemaining;
        var seconds = (int)((status.MinutesRemaining - minutes) * 60);
        _timeLabel.Text = $"{minutes:D2}:{seconds:D2} left";
        _isMember = !string.IsNullOrEmpty(status.LoggedInUser);
        _userLabel.Text = _isMember ? status.LoggedInUser : "Guest session";
        _logoutButton.Visible = _isMember && !_expanded;
        _resumeButton.Visible = false;
        _timeLabel.Visible = true;
        _userLabel.Visible = true;
        if (_expanded)
        {
            _accountButton.Visible = _isMember && _subView == null;
            _pointsButton.Visible = _isMember && _subView == null;
        }
    }

    // Staff paused this PC (POST /pause) - freeze the countdown display
    // and offer the one action that matters here: resuming it.
    public void ShowPaused()
    {
        if (_expanded) Collapse();
        _timeLabel.Text = "Paused";
        _userLabel.Text = "Enforcement suspended by staff";
        _logoutButton.Visible = false;
        _expandButton.Visible = false;
        _resumeButton.Visible = true;
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

    private async Task OnResumeClicked()
    {
        _resumeButton.Enabled = false;
        try
        {
            await _api.ResumeAsync(_config.Mac, _config.DeviceSecret);
            // Next poll picks up paused:false and Program.cs's HandleStatus
            // swaps back to the normal locked/unlocked flow.
        }
        finally
        {
            _resumeButton.Enabled = true;
            _expandButton.Visible = true;
        }
    }
}
