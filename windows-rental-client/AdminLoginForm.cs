using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

// Staff/Admin login gate for the real Admin Panel (server/routes/rental.js's
// admin-panel/* routes) - a SEPARATE, narrower credential
// (rental_admin_panel_password) from the site's real global admin password
// and from the existing Staff Override/Pause app password. Replaces
// CafeHomeForm's old temporary placeholder that reused LockForm's Force
// Unlock/Pause flow for this menu item.
//
// A plain FixedDialog Form (matching PromptDialog's precedent for a small
// modal input), not an embedded view - unlike LockForm's login sub-view,
// there's no home screen behind this to return to, it's launched straight
// from CafeHomeForm's dropdown menu. Wrong-password feedback is an inline
// label (LockForm._loginErrorLabel's pattern), never a MessageBox.
//
// Geometry (ClientSize 360x240, all children Left relative to that width):
//   _titleLabel    Left=0,   Top=24,  Width=360, Height=30  -> bottom=54
//   _passwordBox   Left=40,  Top=74,  Width=280, Height=~29 -> bottom=~103
//   _loginButton   Left=40,  Top=112, Width=280, Height=44  -> bottom=156
//   _errorLabel    Left=40,  Top=164, Width=280, Height=40  -> bottom=204
// (36px margin left below the error label within the 240 client height)
public class AdminLoginForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;

    private Label _titleLabel = null!;
    private TextBox _passwordBox = null!;
    private CardButton _loginButton = null!;
    private Label _errorLabel = null!;

    // Set on a successful verify - the caller (CafeHomeForm) passes this
    // straight through to every subsequent admin-panel/* call, since the
    // server re-checks it on every one of those routes rather than issuing
    // a session token.
    public string? VerifiedPassword { get; private set; }

    public AdminLoginForm(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        BuildUi();
    }

    private void BuildUi()
    {
        Text = "Admin Panel Login";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;
        TopMost = true;
        ClientSize = new Size(360, 240);
        BackColor = Theme.Background;

        _titleLabel = new Label
        {
            Text = "ADMIN PANEL",
            Font = new Font("Segoe UI", 14, FontStyle.Bold),
            AutoSize = false,
            Left = 0, Top = 24, Width = 360, Height = 30,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Theme.TextPrimary,
        };
        Controls.Add(_titleLabel);

        const int fieldWidth = 280;
        var fieldLeft = (360 - fieldWidth) / 2;

        _passwordBox = new TextBox
        {
            PlaceholderText = "Admin panel password",
            PasswordChar = '*',
            Left = fieldLeft, Top = 74, Width = fieldWidth,
            Font = new Font("Segoe UI", 11),
        };
        _passwordBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.Enter) return;
            e.SuppressKeyPress = true; // stop the default beep - Click handler below is async, can't be AcceptButton
            _ = OnLoginClickedAsync();
        };
        Controls.Add(_passwordBox);

        _loginButton = new CardButton
        {
            Text = "LOG IN",
            Left = fieldLeft, Top = 112, Width = fieldWidth, Height = 44,
            CornerRadius = 10,
            Font = new Font("Segoe UI", 12, FontStyle.Bold),
            BackColor = Theme.Accent,
            ForeColor = Theme.OnAccent,
        };
        _loginButton.Click += async (_, _) => await OnLoginClickedAsync();
        Controls.Add(_loginButton);

        _errorLabel = new Label
        {
            ForeColor = Theme.Danger,
            Left = fieldLeft, Top = 164, Width = fieldWidth, Height = 40,
            TextAlign = ContentAlignment.TopCenter,
            AutoSize = false,
        };
        Controls.Add(_errorLabel);

        Load += (_, _) => _passwordBox.Focus();
    }

    private async Task OnLoginClickedAsync()
    {
        _errorLabel.Text = "";
        var password = _passwordBox.Text;
        if (string.IsNullOrEmpty(password))
        {
            _errorLabel.Text = "Enter the admin panel password.";
            return;
        }

        _loginButton.Enabled = false;
        _passwordBox.Enabled = false;
        try
        {
            var result = await _api.VerifyAdminPanelPasswordAsync(_config.Mac, _config.DeviceSecret, password);
            if (result == null || !result.Success)
            {
                _errorLabel.Text = result?.Message ?? "Incorrect password";
                _passwordBox.Text = "";
                _passwordBox.Focus();
                return;
            }

            VerifiedPassword = password;
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            _errorLabel.Text = $"Could not reach the server: {ex.Message}";
        }
        finally
        {
            _loginButton.Enabled = true;
            _passwordBox.Enabled = true;
        }
    }
}
