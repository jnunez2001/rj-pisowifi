namespace StarkFiRentalClient;

// Café Home (V1.0.0 blueprint) - the game/app launcher screen shown
// instead of the raw Windows desktop while a session is unlocked and no
// game is currently running. Same full-screen/borderless/topmost/
// keyboard-blocked technique LockForm already uses, but a separate
// form (not a reuse of LockForm) since the purpose is different:
// launching processes and returning, not blocking input for payment.
//
// Deliberately does NOT fetch or render any artwork from the server -
// the blueprint's Local Game Library section is explicit that the
// launcher must not depend on downloading images. Icon/banner art is
// resolved from a local per-app-id folder next to this exe
// (GameArt\<id>\icon.png), with a plain placeholder tile shown when
// that file hasn't been placed on this particular PC yet. The server
// (server/routes/rental.js's GET /apps) only ever supplies catalog
// metadata: name, category, executable path, featured/order.
//
// CountdownWidget (remaining time / Add Time / Account / Points /
// Logout) is NOT duplicated here - it already floats in the corner
// over whatever's showing (this screen included, same as it already
// did over the raw desktop), so Café Home only needs to be the card
// grid itself.
public class CafeHomeForm : Form
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly KeyboardBlocker _keyboardBlocker = new();

    private readonly FlowLayoutPanel _body;
    private readonly Label _loadingLabel;

    private readonly System.Windows.Forms.Timer _catalogRefreshTimer;
    private System.Windows.Forms.Timer? _launchedProcessWatcher;
    private static readonly TimeSpan CatalogRefreshInterval = TimeSpan.FromSeconds(60);

    // Program.cs polls status every 5s and calls ShowHome() on every
    // unlocked tick - without this guard, that would pop this screen
    // back up on top of a game the customer just launched, since
    // HideHome() (called from LaunchApp below) doesn't stop the status
    // poller from still thinking "unlocked -> show Café Home" on its
    // very next tick.
    public bool IsProgramRunning { get; private set; }

    public CafeHomeForm(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;

        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        BackColor = Color.FromArgb(18, 18, 18);
        StartPosition = FormStartPosition.Manual;
        Bounds = Screen.PrimaryScreen!.Bounds;
        ShowInTaskbar = false;
        KeyPreview = true;

        var header = new Panel { Dock = DockStyle.Top, Height = 60, BackColor = Color.FromArgb(12, 143, 109) };
        var title = new Label
        {
            Text = "CAFÉ HOME", ForeColor = Color.White, Font = new Font("Segoe UI", 16, FontStyle.Bold),
            AutoSize = false, Dock = DockStyle.Left, Width = 300, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(20, 0, 0, 0)
        };
        header.Controls.Add(title);
        Controls.Add(header);

        _loadingLabel = new Label
        {
            Text = "Loading games and apps...", ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 11),
            AutoSize = false, Dock = DockStyle.Top, Height = 40, TextAlign = ContentAlignment.MiddleCenter
        };
        Controls.Add(_loadingLabel);

        _body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, AutoScroll = true, WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(20), BackColor = Color.FromArgb(18, 18, 18)
        };
        Controls.Add(_body);
        _body.BringToFront();
        _loadingLabel.BringToFront();
        header.BringToFront();

        _catalogRefreshTimer = new System.Windows.Forms.Timer { Interval = (int)CatalogRefreshInterval.TotalMilliseconds };
        _catalogRefreshTimer.Tick += async (_, _) => await LoadCatalogAsync();

        // Same guard LockForm uses - without this, Alt+F4 would dispose
        // this Form outright (not just hide it), and Program.cs's cached
        // _cafeHome reference would throw ObjectDisposedException on its
        // very next Show()/Hide() call, crashing the whole client.
        FormClosing += (_, e) => { if (Visible) e.Cancel = true; };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _keyboardBlocker.Install();
        Activate();
        Focus();
    }

    public void ShowHome()
    {
        if (IsProgramRunning) return;
        if (!Visible)
        {
            Show();
            _ = LoadCatalogAsync();
        }
        _keyboardBlocker.Install();
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        Activate();
        _catalogRefreshTimer.Start();
    }

    public void HideHome()
    {
        _catalogRefreshTimer.Stop();
        _keyboardBlocker.Uninstall();
        Hide();
    }

    private async Task LoadCatalogAsync()
    {
        AppCatalogResponse? result;
        try
        {
            result = await _api.GetAppsAsync(_config.Mac, _config.DeviceSecret);
        }
        catch
        {
            // Network hiccup - keep whatever tiles are already showing
            // rather than clearing the screen over a transient failure.
            return;
        }
        if (IsDisposed || !IsHandleCreated) return;

        if (result == null || !result.Success)
        {
            _loadingLabel.Text = "Could not load the catalog. Ask staff for help.";
            _loadingLabel.Visible = true;
            return;
        }

        _loadingLabel.Visible = false;
        RenderCatalog(result);
    }

    private void RenderCatalog(AppCatalogResponse catalog)
    {
        _body.SuspendLayout();
        _body.Controls.Clear();

        if (catalog.Apps.Count == 0)
        {
            _body.Controls.Add(new Label
            {
                Text = "No games or apps have been added yet. Ask staff to add some from PC Rental > Café Home.",
                ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 11), AutoSize = true, Margin = new Padding(10, 40, 10, 10)
            });
            _body.ResumeLayout();
            return;
        }

        var featured = catalog.Apps.Where(a => a.Featured).OrderBy(a => a.DisplayOrder).ToList();
        if (featured.Count > 0)
        {
            _body.Controls.Add(SectionHeader("Featured"));
            foreach (var app in featured) _body.Controls.Add(BuildTile(app, large: true));
        }

        var categoryNames = catalog.Categories.OrderBy(c => c.DisplayOrder).ToDictionary(c => c.Id, c => c.Name);
        var grouped = catalog.Apps
            .Where(a => !a.Featured)
            .GroupBy(a => a.CategoryId)
            .OrderBy(g => g.Key.HasValue && categoryNames.ContainsKey(g.Key.Value)
                ? catalog.Categories.First(c => c.Id == g.Key.Value).DisplayOrder
                : int.MaxValue);

        foreach (var group in grouped)
        {
            var name = group.Key.HasValue && categoryNames.TryGetValue(group.Key.Value, out var n) ? n : "Other";
            _body.Controls.Add(SectionHeader(name));
            foreach (var app in group.OrderBy(a => a.DisplayOrder)) _body.Controls.Add(BuildTile(app, large: false));
        }

        _body.ResumeLayout();
    }

    private Label SectionHeader(string text) => new()
    {
        Text = text, ForeColor = Color.White, Font = new Font("Segoe UI", 12, FontStyle.Bold),
        AutoSize = false, Width = 1200, Height = 30, Margin = new Padding(0, 16, 0, 6)
    };

    private Control BuildTile(AppCatalogEntry app, bool large)
    {
        var size = large ? 220 : 160;
        var tile = new Panel
        {
            Width = size, Height = size + 30, Margin = new Padding(8), Cursor = Cursors.Hand,
            BackColor = Color.FromArgb(40, 40, 40)
        };

        var art = new PictureBox { Dock = DockStyle.Top, Height = size, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.FromArgb(55, 55, 55) };
        var artPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), "icon.png");
        if (File.Exists(artPath))
        {
            try { art.Image = Image.FromFile(artPath); } catch { /* corrupt/locked file - fall through to placeholder */ }
        }

        var nameLabel = new Label
        {
            Text = app.Name, ForeColor = Color.White, Font = new Font("Segoe UI", 9, FontStyle.Bold),
            Dock = DockStyle.Bottom, Height = 30, TextAlign = ContentAlignment.MiddleCenter
        };

        tile.Controls.Add(nameLabel);
        tile.Controls.Add(art);

        // The click target needs to cover the whole tile, not just the
        // background Panel - every child control needs the same handler,
        // since a click on the PictureBox/Label wouldn't otherwise bubble
        // up to the Panel's own Click event.
        void OnClick(object? _, EventArgs __) => LaunchApp(app);
        tile.Click += OnClick;
        art.Click += OnClick;
        nameLabel.Click += OnClick;

        return tile;
    }

    private void LaunchApp(AppCatalogEntry app)
    {
        System.Diagnostics.Process process;
        try
        {
            var startInfo = new System.Diagnostics.ProcessStartInfo(app.ExecutablePath) { UseShellExecute = true };
            var started = System.Diagnostics.Process.Start(startInfo);
            if (started == null) throw new InvalidOperationException("Process.Start returned null");
            process = started;
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not launch {app.Name}:\n{ex.Message}\n\nCheck the executable path in PC Rental > Café Home.",
                "Café Home", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        IsProgramRunning = true;
        HideHome();

        // No Process.Exited event subscription (that fires on a
        // threadpool thread and still needs marshaling back to the UI
        // thread either way) - a simple UI-thread poll timer is simpler
        // and this doesn't need sub-second responsiveness.
        _launchedProcessWatcher?.Stop();
        _launchedProcessWatcher?.Dispose();
        _launchedProcessWatcher = new System.Windows.Forms.Timer { Interval = 2000 };
        _launchedProcessWatcher.Tick += (_, _) =>
        {
            if (process.HasExited)
            {
                _launchedProcessWatcher!.Stop();
                IsProgramRunning = false;
                ShowHome();
            }
        };
        _launchedProcessWatcher.Start();
    }
}
