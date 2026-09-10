using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

// Shared by LockForm's "Insert Coins"/"Create Account", CafeHomeForm's
// top-bar "Add Time", and MySessionPage's "Add Time" - functionally the
// same coin-insert flow (open a pending window, poll the running total,
// Done to finalize) with different `mode`/pre-filled fields, implemented
// once instead of copy-pasted per screen.
//
// `large` (default false) switches to a full-screen composition matching
// the design mockup's "Insert Credit" screen, used only by LockForm's
// Guest/Create Account flow. CafeHomeForm's and MySessionPage's compact
// embeddings pass no argument, so they get `large: false` and are
// completely unaffected by anything below.
public class CoinInsertPanel : Panel
{
    public event Action? Cancelled;
    public event Action<ApiResult>? Completed;

    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly string _mode; // 'pc_rental' or 'pc_rental_create_account'
    private readonly bool _large;

    private readonly Label _titleLabel;
    private readonly Label _totalLabel;
    private readonly Label _statusLabel;
    private readonly CardButton _doneButton;
    private readonly CardButton _cancelButton;

    // create_account mode only - collected before the coin window opens.
    private TextBox? _usernameBox;
    private TextBox? _passwordBox;
    private CardButton? _startButton;

    // large mode only - the mockup's close X, subcopy line, "INSERTED"
    // caption, and the local payment countdown.
    private Label? _closeButton;
    private Label? _subcopyLabel;
    private Label? _insertedLabel;
    private Label? _countdownLabel;
    private System.Windows.Forms.Timer? _countdownTimer;
    private int _countdownSeconds;

    private System.Windows.Forms.Timer? _pollTimer;
    private bool _windowOpen;
    private int _lastTotal;

    public CoinInsertPanel(RentalApiClient api, ClientConfig config, string mode, bool large = false)
    {
        _api = api;
        _config = config;
        _mode = mode;
        _large = large;

        if (!_large)
        {
            Width = 280;
            Height = 220;
            BackColor = Color.Transparent;

            _titleLabel = new Label { ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 11, FontStyle.Bold), Left = 0, Top = 0, Width = 280, Height = 24, TextAlign = ContentAlignment.MiddleCenter };
            _totalLabel = new Label { ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 20, FontStyle.Bold), Left = 0, Top = 40, Width = 280, Height = 40, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
            _statusLabel = new Label { ForeColor = Color.OrangeRed, Font = new Font("Segoe UI", 8), Left = 0, Top = 84, Width = 280, Height = 32, TextAlign = ContentAlignment.MiddleCenter };
            _doneButton = new CardButton { Text = "Done", Width = 130, Height = 30, Left = 0, Top = 160, CornerRadius = 8, BackColor = Theme.Accent, ForeColor = Theme.OnAccent, Visible = false };
            _doneButton.Click += async (_, _) => await OnDoneClicked();
            _cancelButton = new CardButton { Text = "Cancel", Width = 130, Height = 30, Left = 150, Top = 160, CornerRadius = 8, Outlined = true, ForeColor = Theme.TextPrimary };
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
                _startButton = new CardButton { Text = "Insert Coins to Fund It", Width = 250, Height = 30, Left = 15, Top = 100, CornerRadius = 8, BackColor = Theme.Accent, ForeColor = Theme.OnAccent };
                _startButton.Click += async (_, _) => await OnStartClicked();
                Controls.Add(_usernameBox);
                Controls.Add(_passwordBox);
                Controls.Add(_startButton);
            }
            else
            {
                _titleLabel.Text = "Insert coins";
            }

            return;
        }

        // ---- large mode: full-screen "Insert Credit" composition ----
        Width = 480;
        Height = 500;
        BackColor = Color.Transparent;

        var isCreateAccount = _mode == "pc_rental_create_account";

        _closeButton = new Label { Text = "✕", AutoSize = false, Width = 28, Height = 28, Left = 440, Top = 12, Font = new Font("Segoe UI", 12), TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand, ForeColor = Theme.TextMuted };
        _closeButton.Click += (_, _) => OnCancelClicked();

        _titleLabel = new Label { ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 11, FontStyle.Bold), Left = 0, Top = 54, Width = 480, Height = 22, TextAlign = ContentAlignment.MiddleCenter, Text = SpaceOut(isCreateAccount ? "CREATE ACCOUNT" : "INSERT CREDIT") };

        _subcopyLabel = new Label { ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 10.5F), Left = 40, Top = 80, Width = 400, Height = 36, TextAlign = ContentAlignment.MiddleCenter, Text = "Insert coins / credits into the payment station", Visible = !isCreateAccount };

        // Peso total (this app has no separate "credit count" or
        // rate-to-minutes conversion exposed to the client, unlike the
        // mockup's original design - the running total is the honest
        // thing to show here).
        _totalLabel = new Label { ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 44, FontStyle.Bold), Left = 0, Top = 140, Width = 480, Height = 70, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
        _insertedLabel = new Label { ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 9, FontStyle.Bold), Left = 0, Top = 212, Width = 480, Height = 20, TextAlign = ContentAlignment.MiddleCenter, Text = SpaceOut("INSERTED"), Visible = false };

        // Local visual-only countdown - see StartCountdown()/PollTotalAsync
        // for what it approximates and why it can't drive real behavior.
        _countdownLabel = new Label { ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 36, FontStyle.Bold), Left = 0, Top = 250, Width = 480, Height = 64, TextAlign = ContentAlignment.MiddleCenter, Visible = false, Text = "01:00" };

        _statusLabel = new Label { ForeColor = Color.OrangeRed, Font = new Font("Segoe UI", 9), Left = 0, Top = 320, Width = 480, Height = 28, TextAlign = ContentAlignment.MiddleCenter };

        _doneButton = new CardButton { Text = "Done", Width = 180, Height = 60, Left = 250, Top = 420, CornerRadius = 12, Font = new Font("Segoe UI", 14, FontStyle.Bold), BackColor = Theme.Accent, ForeColor = Theme.OnAccent, Visible = false };
        _doneButton.Click += async (_, _) => await OnDoneClicked();
        _cancelButton = new CardButton { Text = "Cancel", Width = 180, Height = 60, Left = 50, Top = 420, CornerRadius = 12, Font = new Font("Segoe UI", 14, FontStyle.Bold), Outlined = true, ForeColor = Theme.TextPrimary };
        _cancelButton.Click += (_, _) => OnCancelClicked();

        Controls.Add(_closeButton);
        Controls.Add(_titleLabel);
        Controls.Add(_subcopyLabel);
        Controls.Add(_totalLabel);
        Controls.Add(_insertedLabel);
        Controls.Add(_countdownLabel);
        Controls.Add(_statusLabel);
        Controls.Add(_doneButton);
        Controls.Add(_cancelButton);

        if (isCreateAccount)
        {
            var fieldWidth = 320;
            var fieldLeft = (Width - fieldWidth) / 2;
            _usernameBox = new TextBox { PlaceholderText = "Username", Left = fieldLeft, Top = 130, Width = fieldWidth };
            _passwordBox = new TextBox { PlaceholderText = "Password", PasswordChar = '*', Left = fieldLeft, Top = 170, Width = fieldWidth };
            _startButton = new CardButton { Text = "Insert Coins to Fund It", Width = fieldWidth, Height = 50, Left = fieldLeft, Top = 210, CornerRadius = 10, Font = new Font("Segoe UI", 12, FontStyle.Bold), BackColor = Theme.Accent, ForeColor = Theme.OnAccent };
            _startButton.Click += async (_, _) => await OnStartClicked();
            Controls.Add(_usernameBox);
            Controls.Add(_passwordBox);
            Controls.Add(_startButton);
        }
    }

    // Cheap letter-spacing approximation for WinForms Label, which has no
    // native tracking/letter-spacing property - used only for the large
    // mode's small all-caps captions, matching the mockup's wide-tracked
    // look closely enough without a custom-drawn label.
    private static string SpaceOut(string text) => string.Join(" ", text.ToCharArray());

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

        if (_large)
        {
            // For create-account, the fields above are now hidden and this
            // switches the screen over to the same Insert Credit look the
            // guest flow already shows.
            _titleLabel.Text = SpaceOut("INSERT CREDIT");
            if (_subcopyLabel != null) _subcopyLabel.Visible = true;
            if (_insertedLabel != null) _insertedLabel.Visible = true;
            StartCountdown();
        }

        _pollTimer = new System.Windows.Forms.Timer { Interval = 1500 };
        _pollTimer.Tick += async (_, _) => await PollTotalAsync();
        _pollTimer.Start();
    }

    // Local approximation of the server's own coin-window timeout setting
    // (rental_insert_timer_secs, not exposed to this client today) - purely
    // a visual affordance for the large "Insert Credit" screen. It is not
    // synced to the real server value and reaching 0 here does not trigger
    // anything; the server's own silence timeout (see PollTotalAsync)
    // already owns what happens if nobody clicks Done.
    private void StartCountdown()
    {
        if (_countdownLabel == null) return;
        _countdownSeconds = 60;
        _countdownLabel.Visible = true;
        UpdateCountdownLabel();

        _countdownTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        _countdownTimer.Tick += (_, _) =>
        {
            if (_countdownSeconds > 0) _countdownSeconds--;
            UpdateCountdownLabel();
        };
        _countdownTimer.Start();
    }

    private void UpdateCountdownLabel()
    {
        if (_countdownLabel == null) return;
        var span = TimeSpan.FromSeconds(Math.Max(0, _countdownSeconds));
        _countdownLabel.Text = $"{(int)span.TotalMinutes:D2}:{span.Seconds:D2}";
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
            // "Every accepted credit resets the payment timer to 60
            // seconds" - see StartCountdown()'s comment on why this is a
            // local approximation, not the real server-side timer.
            if (_large && _countdownTimer != null)
            {
                _countdownSeconds = 60;
                UpdateCountdownLabel();
            }
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
        _countdownTimer?.Stop();
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
            _countdownTimer?.Stop();
            _countdownTimer?.Dispose();
        }
        base.Dispose(disposing);
    }
}
