using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace StarkFiRentalClient;

public class CoinInsertPanel : Panel
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly string _mode;

	private readonly Label _titleLabel;

	private readonly Label _totalLabel;

	private readonly Label _statusLabel;

	private readonly Button _doneButton;

	private readonly Button _cancelButton;

	private TextBox? _usernameBox;

	private TextBox? _passwordBox;

	private Button? _startButton;

	private Timer? _pollTimer;

	private bool _windowOpen;

	private int _lastTotal;

	public event Action? Cancelled;

	public event Action<ApiResult>? Completed;

	public CoinInsertPanel(RentalApiClient api, ClientConfig config, string mode)
	{
		_api = api;
		_config = config;
		_mode = mode;
		base.Width = 280;
		base.Height = 220;
		BackColor = Color.Transparent;
		_titleLabel = new Label
		{
			ForeColor = Color.White,
			Font = new Font("Segoe UI", 11f, FontStyle.Bold),
			Left = 0,
			Top = 0,
			Width = 280,
			Height = 24,
			TextAlign = ContentAlignment.MiddleCenter
		};
		_totalLabel = new Label
		{
			ForeColor = Color.White,
			Font = new Font("Segoe UI", 20f, FontStyle.Bold),
			Left = 0,
			Top = 40,
			Width = 280,
			Height = 40,
			TextAlign = ContentAlignment.MiddleCenter,
			Visible = false
		};
		_statusLabel = new Label
		{
			ForeColor = Color.OrangeRed,
			Font = new Font("Segoe UI", 8f),
			Left = 0,
			Top = 84,
			Width = 280,
			Height = 32,
			TextAlign = ContentAlignment.MiddleCenter
		};
		_doneButton = new Button
		{
			Text = "Done",
			Width = 130,
			Height = 30,
			Left = 0,
			Top = 160,
			BackColor = Color.FromArgb(12, 143, 109),
			ForeColor = Color.White,
			FlatStyle = FlatStyle.Flat,
			Visible = false
		};
		_doneButton.Click += async delegate
		{
			await OnDoneClicked();
		};
		_cancelButton = new Button
		{
			Text = "Cancel",
			Width = 130,
			Height = 30,
			Left = 150,
			Top = 160,
			BackColor = Color.FromArgb(60, 60, 60),
			ForeColor = Color.White,
			FlatStyle = FlatStyle.Flat
		};
		_cancelButton.Click += delegate
		{
			OnCancelClicked();
		};
		base.Controls.Add(_titleLabel);
		base.Controls.Add(_totalLabel);
		base.Controls.Add(_statusLabel);
		base.Controls.Add(_doneButton);
		base.Controls.Add(_cancelButton);
		if (_mode == "pc_rental_create_account")
		{
			_titleLabel.Text = "Create account";
			_usernameBox = new TextBox
			{
				PlaceholderText = "Username",
				Left = 15,
				Top = 32,
				Width = 250
			};
			_passwordBox = new TextBox
			{
				PlaceholderText = "Password",
				PasswordChar = '*',
				Left = 15,
				Top = 64,
				Width = 250
			};
			_startButton = new Button
			{
				Text = "Insert Coins to Fund It",
				Width = 250,
				Height = 30,
				Left = 15,
				Top = 100,
				BackColor = Color.FromArgb(12, 143, 109),
				ForeColor = Color.White,
				FlatStyle = FlatStyle.Flat
			};
			_startButton.Click += async delegate
			{
				await OnStartClicked();
			};
			base.Controls.Add(_usernameBox);
			base.Controls.Add(_passwordBox);
			base.Controls.Add(_startButton);
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
			OpenWindowAsync();
		}
	}

	private async Task OnStartClicked()
	{
		string text = _usernameBox.Text.Trim();
		string text2 = _passwordBox.Text;
		if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(text2))
		{
			_statusLabel.Text = "Enter a username and password first.";
			return;
		}
		_startButton.Enabled = false;
		await OpenWindowAsync(text, text2);
	}

	private async Task OpenWindowAsync(string? username = null, string? password = null)
	{
		string minCreditNote = ((_mode == "pc_rental_create_account") ? " (minimum applies)" : "");
		ApiResult apiResult = await _api.OpenCoinPendingAsync(_config.Mac, _mode, username, password);
		if (apiResult == null || !apiResult.Success)
		{
			_statusLabel.Text = apiResult?.Message ?? "Could not start - try again.";
			if (_startButton != null)
			{
				_startButton.Enabled = true;
			}
			return;
		}
		_windowOpen = true;
		_usernameBox?.Hide();
		_passwordBox?.Hide();
		_startButton?.Hide();
		_totalLabel.Visible = true;
		_doneButton.Visible = true;
		_statusLabel.Text = "Insert coins now" + minCreditNote;
		_totalLabel.Text = "₱0";
		_pollTimer = new Timer
		{
			Interval = 1500
		};
		_pollTimer.Tick += async delegate
		{
			await PollTotalAsync();
		};
		_pollTimer.Start();
	}

	private async Task PollTotalAsync()
	{
		PendingCoinStatus pendingCoinStatus = await _api.GetPendingCoinStatusAsync(_config.Mac);
		if (pendingCoinStatus == null || !pendingCoinStatus.Pending)
		{
			_pollTimer?.Stop();
		}
		else if (pendingCoinStatus.Total != _lastTotal)
		{
			_lastTotal = pendingCoinStatus.Total;
			_totalLabel.Text = $"₱{pendingCoinStatus.Total}";
		}
	}

	private async Task OnDoneClicked()
	{
		_doneButton.Enabled = false;
		_pollTimer?.Stop();
		ApiResult apiResult = await _api.FinalizeCoinsAsync(_config.Mac);
		if (apiResult != null && apiResult.Success)
		{
			Completed?.Invoke(apiResult);
			return;
		}
		_statusLabel.Text = apiResult?.Message ?? "Something went wrong - try inserting again.";
		_doneButton.Enabled = true;
		_pollTimer?.Start();
	}

	private void OnCancelClicked()
	{
		_pollTimer?.Stop();
		if (_windowOpen && _lastTotal > 0)
		{
			MessageBox.Show($"₱{_lastTotal} already inserted will still be credited shortly - coins can't be refunded by software.", "Coins already inserted", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
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
