namespace StarkFiRentalClient;

// Shared by LockForm's "Insert Coins"/"Create Account" and
// CountdownWidget's "Add Time" - functionally the same coin-insert flow
// (open a pending window, poll the running total, Done to finalize) with
// different `mode`/pre-filled fields, implemented once instead of
// copy-pasted three times.
public class CoinInsertPanel : Panel
{
    public event Action? Cancelled;
    public event Action<ApiResult>? Completed;

    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly string _mode; // 'pc_rental' or 'pc_rental_create_account'

    private readonly Label _titleLabel;
    private readonly Label _totalLabel;
    private readonly Label _statusLabel;
    private readonly Button _doneButton;
    private readonly Button _cancelButton;

    // create_account mode only - collected before the coin window opens.
    private TextBox? _usernameBox;
    private TextBox? _passwordBox;
    private Button? _startButton;

    private System.Windows.Forms.Timer? _pollTimer;
    private bool _windowOpen;
    private int _lastTotal;

    public CoinInsertPanel(RentalApiClient api, ClientConfig config, string mode)
    {
        _api = api;
        _config = config;
        _mode = mode;

        Width = 280;
        Height = 220;
        BackColor = Color.Transparent;

        _titleLabel = new Label { ForeColor = Color.White, Font = new Font("Segoe UI", 11, FontStyle.Bold), Left = 0, Top = 0, Width = 280, Height = 24, TextAlign = ContentAlignment.MiddleCenter };
        _totalLabel = new Label { ForeColor = Color.White, Font = new Font("Segoe UI", 20, FontStyle.Bold), Left = 0, Top = 40, Width = 280, Height = 40, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
        _statusLabel = new Label { ForeColor = Color.OrangeRed, Font = new Font("Segoe UI", 8), Left = 0, Top = 84, Width = 280, Height = 32, TextAlign = ContentAlignment.MiddleCenter };
        _doneButton = new Button { Text = "Done", Width = 130, Height = 30, Left = 0, Top = 160, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Visible = false };
        _doneButton.Click += async (_, _) => await OnDoneClicked();
        _cancelButton = new Button { Text = "Cancel", Width = 130, Height = 30, Left = 150, Top = 160, BackColor = Color.FromArgb(60, 60, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        _cancelButton.Click += (_, _) => OnCancelClicked();

        Controls.Add(_titleLabel);
        Controls.Add(_totalLabel);
        Controls.Add(_statusLabel);
        Controls.Add(_doneButton);
        Controls.Add(_cancelButton);

        if (_mode == "pc_rental_create_account")
        {
            _titleLabel.Text = "Create account";
            _usernameBox = new TextBox { PlaceholderText = "Username", Left = 15, Top = 32, Width = 250 };
            _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Left = 15, Top = 64, Width = 250 };
            _startButton = new Button { Text = "Insert Coins to Fund It", Width = 250, Height = 30, Left = 15, Top = 100, BackColor = Color.FromArgb(12, 143, 109), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
            _startButton.Click += async (_, _) => await OnStartClicked();
            Controls.Add(_usernameBox);
            Controls.Add(_passwordBox);
            Controls.Add(_startButton);
        }
        else
        {
            _titleLabel.Text = "Insert coins";
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (_mode == "pc_rental")
        {
            _ = OpenWindowAsync();
        }
    }

    private async Task OnStartClicked()
    {
        var username = _usernameBox!.Text.Trim();
        var password = _passwordBox!.Text;
        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password))
        {
            _statusLabel.Text = "Enter a username and password first.";
            return;
        }
        _startButton!.Enabled = false;
        await OpenWindowAsync(username, password);
    }

    private async Task OpenWindowAsync(string? username = null, string? password = null)
    {
        var minCreditNote = _mode == "pc_rental_create_account" ? " (minimum applies)" : "";
        var result = await _api.OpenCoinPendingAsync(_config.Mac, _mode, username, password);
        if (result == null || !result.Success)
        {
            _statusLabel.Text = result?.Message ?? "Could not start - try again.";
            if (_startButton != null) _startButton.Enabled = true;
            return;
        }

        _windowOpen = true;
        _usernameBox?.Hide();
        _passwordBox?.Hide();
        _startButton?.Hide();
        _totalLabel.Visible = true;
        _doneButton.Visible = true;
        _statusLabel.Text = $"Insert coins now{minCreditNote}";
        _totalLabel.Text = "₱0";

        _pollTimer = new System.Windows.Forms.Timer { Interval = 1500 };
        _pollTimer.Tick += async (_, _) => await PollTotalAsync();
        _pollTimer.Start();
    }

    private async Task PollTotalAsync()
    {
        var status = await _api.GetPendingCoinStatusAsync(_config.Mac);
        if (status == null || !status.Pending)
        {
            // Window expired server-side (silence timeout) without Done
            // being clicked - whatever was inserted still finalizes on
            // its own via the server's own timer, this panel just has
            // nothing left to show.
            _pollTimer?.Stop();
            return;
        }
        if (status.Total != _lastTotal)
        {
            _lastTotal = status.Total;
            _totalLabel.Text = $"₱{status.Total}";
        }
    }

    private async Task OnDoneClicked()
    {
        _doneButton.Enabled = false;
        _pollTimer?.Stop();
        var result = await _api.FinalizeCoinsAsync(_config.Mac);
        if (result != null && result.Success)
        {
            Completed?.Invoke(result);
            return;
        }
        // insufficient_amount / no_matching_rate / username_taken all
        // still get shown here - the coins aren't lost (server-side
        // fallback for username_taken already credits guest time; the
        // others mean the window is genuinely still open for more
        // coins, matching the portal's own "insert a bit more" copy).
        _statusLabel.Text = result?.Message ?? "Something went wrong - try inserting again.";
        _doneButton.Enabled = true;
        _pollTimer?.Start();
    }

    private void OnCancelClicked()
    {
        _pollTimer?.Stop();
        if (_windowOpen && _lastTotal > 0)
        {
            MessageBox.Show($"₱{_lastTotal} already inserted will still be credited shortly - coins can't be refunded by software.",
                "Coins already inserted", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        Cancelled?.Invoke();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pollTimer?.Stop();
            _pollTimer?.Dispose();
        }
        base.Dispose(disposing);
    }
}
