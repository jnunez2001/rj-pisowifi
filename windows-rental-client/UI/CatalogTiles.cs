namespace StarkFiRentalClient.UI;

// Shared game/app tile rendering - used by HomePage's Games/Applications
// rows, GamesPage, and ApplicationsPage alike, so the tile look and
// click behavior is defined once instead of three times. Deliberately
// does NOT fetch or render any artwork from the server - the blueprint's
// Local Game Library section is explicit that the launcher must not
// depend on downloading images. Icon art is resolved from a local
// per-app-id folder next to this exe (GameArt\<id>\icon.png), falling
// back to a plain placeholder tile when that file hasn't been placed on
// this particular PC yet.
public static class CatalogTiles
{
    public static Label SectionHeader(string text) => new()
    {
        Text = text, ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 12, FontStyle.Bold),
        AutoSize = false, Width = 1200, Height = 30, Margin = new Padding(0, 16, 0, 6)
    };

    public static Control BuildTile(AppCatalogEntry app, bool large, Action<AppCatalogEntry> onLaunch)
    {
        var size = large ? 220 : 160;
        var tile = new Panel
        {
            Width = size, Height = size + 30, Margin = new Padding(8), Cursor = Cursors.Hand,
            BackColor = Theme.Surface
        };

        var art = new PictureBox { Dock = DockStyle.Top, Height = size, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Theme.Lighten(Theme.Surface, 15) };
        var artPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), large ? "banner.png" : "icon.png");
        if (!File.Exists(artPath)) artPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), "icon.png");
        if (File.Exists(artPath))
        {
            try { art.Image = Image.FromFile(artPath); } catch { /* corrupt/locked file - fall through to placeholder */ }
        }

        var nameLabel = new Label
        {
            Text = app.Name, ForeColor = Theme.TextPrimary, Font = new Font("Segoe UI", 9, FontStyle.Bold),
            Dock = DockStyle.Bottom, Height = 30, TextAlign = ContentAlignment.MiddleCenter
        };

        tile.Controls.Add(nameLabel);
        tile.Controls.Add(art);

        // The click target needs to cover the whole tile, not just the
        // background Panel - every child control needs the same handler,
        // since a click on the PictureBox/Label wouldn't otherwise bubble
        // up to the Panel's own Click event.
        void OnClick(object? _, EventArgs __) => onLaunch(app);
        tile.Click += OnClick;
        art.Click += OnClick;
        nameLabel.Click += OnClick;

        return tile;
    }
}

// Shared "launch this executable and know when it exits" logic - static
// so the running-state (IsProgramRunning) is visible from anywhere that
// needs to avoid popping a screen up over an active game, not just the
// form that happened to launch it.
public static class AppLauncher
{
    public static bool IsProgramRunning { get; private set; }
    public static event Action? ProcessExited;

    private static System.Windows.Forms.Timer? _watcher;

    public static void Launch(AppCatalogEntry app)
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

        // No Process.Exited event subscription (that fires on a
        // threadpool thread and still needs marshaling back to the UI
        // thread either way) - a simple UI-thread poll timer is simpler
        // and this doesn't need sub-second responsiveness.
        _watcher?.Stop();
        _watcher?.Dispose();
        _watcher = new System.Windows.Forms.Timer { Interval = 2000 };
        _watcher.Tick += (_, _) =>
        {
            if (process.HasExited)
            {
                _watcher!.Stop();
                IsProgramRunning = false;
                ProcessExited?.Invoke();
            }
        };
        _watcher.Start();
    }
}
