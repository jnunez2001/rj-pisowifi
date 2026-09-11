using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Share Time (member-only) - lets the logged-in member send some of their
// own remaining minutes to either another active PC's current occupant or
// directly to another member's account by username. Opened from
// CafeHomeForm's dropdown (member-only, same visibility rule as Admin
// Panel/Log Out) via the same "host Form + UserControl content" modal
// pattern OnUserSettingsClicked already uses for SettingsPage - light
// Theme, not AdminPanelPage's fixed dark palette, since this is a normal
// member-facing action, not the separate Admin Panel mode.
public class ShareTimePage : UserControl
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;

    private NumericUpDown _minutesInput = null!;
    private RadioButton _sendToPcRadio = null!;
    private RadioButton _sendToMemberRadio = null!;
    private ComboBox _pcTargetCombo = null!;
    private TextBox _usernameBox = null!;
    private CardButton _sendButton = null!;
    private Label _resultLabel = null!;

    private List<ShareTimeTarget> _targets = new();

    public ShareTimePage(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        Dock = DockStyle.Fill;
        BackColor = Theme.Background;

        BuildUi();
        _ = LoadTargetsAsync();
    }

    private void BuildUi()
    {
        var minutesLabel = new Label { Text = "Minutes", AutoSize = true, Left = 20, Top = 24 };
        _minutesInput = new NumericUpDown { Left = 20, Top = 48, Width = 100, Minimum = 1, Maximum = 100000, Value = 5 };
        Controls.Add(minutesLabel);
        Controls.Add(_minutesInput);

        _sendToPcRadio = new RadioButton { Text = "Send to PC", AutoSize = true, Left = 20, Top = 90, Checked = true };
        _sendToMemberRadio = new RadioButton { Text = "Send to Member", AutoSize = true, Left = 20, Top = 118 };
        _sendToPcRadio.CheckedChanged += (_, _) => UpdateTargetVisibility();
        Controls.Add(_sendToPcRadio);
        Controls.Add(_sendToMemberRadio);

        _pcTargetCombo = new ComboBox { Left = 20, Top = 150, Width = 380, DropDownStyle = ComboBoxStyle.DropDownList };
        Controls.Add(_pcTargetCombo);

        _usernameBox = new TextBox { PlaceholderText = "Username", Left = 20, Top = 150, Width = 380, Visible = false };
        Controls.Add(_usernameBox);

        _sendButton = new CardButton { Text = "SEND", Width = 140, Height = 40, Left = 20, Top = 194, CornerRadius = 8, BackColor = Theme.Accent };
        _sendButton.Click += async (_, _) => await OnSendClickedAsync();
        Controls.Add(_sendButton);

        _resultLabel = new Label { AutoSize = false, Left = 20, Top = 244, Width = 400, Height = 40 };
        Controls.Add(_resultLabel);
    }

    private void UpdateTargetVisibility()
    {
        _pcTargetCombo.Visible = _sendToPcRadio.Checked;
        _usernameBox.Visible = !_sendToPcRadio.Checked;
    }

    private async Task LoadTargetsAsync()
    {
        _pcTargetCombo.Items.Clear();
        ShareTimeTargetsResponse? result;
        try
        {
            result = await _api.GetShareTimeTargetsAsync(_config.Mac, _config.DeviceSecret);
        }
        catch
        {
            _resultLabel.ForeColor = Theme.Danger;
            _resultLabel.Text = "Could not load PCs.";
            return;
        }
        if (IsDisposed) return;
        if (result == null || !result.Success)
        {
            _resultLabel.ForeColor = Theme.Danger;
            _resultLabel.Text = result?.Message ?? "Could not load PCs.";
            return;
        }

        _targets = result.Targets;
        foreach (var target in _targets)
        {
            _pcTargetCombo.Items.Add($"{target.Name} ({target.OccupantLabel})");
        }
        if (_pcTargetCombo.Items.Count > 0) _pcTargetCombo.SelectedIndex = 0;
    }

    private async Task OnSendClickedAsync()
    {
        _resultLabel.ForeColor = Theme.TextMuted;
        _resultLabel.Text = "";

        var minutes = (int)_minutesInput.Value;
        var targetType = _sendToPcRadio.Checked ? "pc" : "member";

        int? targetPcId = null;
        string? targetUsername = null;

        if (targetType == "pc")
        {
            if (_pcTargetCombo.SelectedIndex < 0 || _pcTargetCombo.SelectedIndex >= _targets.Count)
            {
                _resultLabel.ForeColor = Theme.Danger;
                _resultLabel.Text = "Pick a PC first.";
                return;
            }
            targetPcId = _targets[_pcTargetCombo.SelectedIndex].PcId;
        }
        else
        {
            targetUsername = _usernameBox.Text.Trim();
            if (string.IsNullOrEmpty(targetUsername))
            {
                _resultLabel.ForeColor = Theme.Danger;
                _resultLabel.Text = "Enter a username first.";
                return;
            }
        }

        _sendButton.Enabled = false;
        ApiResult? result;
        try
        {
            result = await _api.ShareTimeAsync(_config.Mac, _config.DeviceSecret, minutes, targetType, targetPcId, targetUsername);
        }
        catch
        {
            result = null;
        }
        _sendButton.Enabled = true;

        if (result != null && result.Success)
        {
            _resultLabel.ForeColor = Theme.Success;
            _resultLabel.Text = "Sent.";
            if (targetType == "member") _usernameBox.Text = "";
            await LoadTargetsAsync();
        }
        else
        {
            _resultLabel.ForeColor = Theme.Danger;
            _resultLabel.Text = result?.Message ?? "Could not send.";
        }
    }
}
