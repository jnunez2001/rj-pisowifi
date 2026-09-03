using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Café Home's landing page - featured carousel on top, then Games and
// Applications preview rows below (each capped to a handful of tiles
// with a "View All" link to the full page - the actual full grids live
// in GamesPage/ApplicationsPage, not duplicated here).
public class HomePage : UserControl
{
    private const int PreviewRowCount = 5;

    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;

    private readonly Panel _carousel;
    private readonly PictureBox _carouselArt;
    private readonly Label _carouselFeaturedLabel;
    private readonly Label _carouselTitle;
    private readonly CardButton _carouselPlayButton;
    private readonly FlowLayoutPanel _dotsPanel;
    private readonly Label _emptyLabel;

    private readonly FlowLayoutPanel _gamesRow;
    private readonly CardButton _gamesViewAll;
    private readonly FlowLayoutPanel _appsRow;
    private readonly CardButton _appsViewAll;

    private List<AppCatalogEntry> _featured = new();
    private int _carouselIndex;
    private readonly System.Windows.Forms.Timer _carouselAutoAdvance;

    public event Action<string>? NavigateRequested;

    public HomePage(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
        Dock = DockStyle.Fill;
        BackColor = Theme.Background;
        AutoScroll = true;

        _carousel = new RoundedPanel { Height = 300, Dock = DockStyle.Top, Margin = new Padding(20), CornerRadius = 16 };
        var carouselWrap = new Panel { Height = 340, Dock = DockStyle.Top, Padding = new Padding(20) };
        carouselWrap.Controls.Add(_carousel);
        Controls.Add(carouselWrap);

        _carouselArt = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.StretchImage };
        _carousel.Controls.Add(_carouselArt);

        _carouselFeaturedLabel = new Label { Text = "FEATURED GAME", ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 9, FontStyle.Bold), AutoSize = true, Left = 30, Top = 30 };
        _carouselTitle = new Label { ForeColor = Color.White, Font = new Font("Segoe UI", 26, FontStyle.Bold), AutoSize = true, Left = 30, Top = 56 };
        _carouselPlayButton = new CardButton { Text = "PLAY NOW", Width = 160, Height = 40, Left = 30, Top = 130, CornerRadius = 8, BackColor = Theme.Accent };
        _carouselPlayButton.Click += (_, _) => { if (_featured.Count > 0) AppLauncher.Launch(_featured[_carouselIndex]); };
        _emptyLabel = new Label { Text = "No featured games yet.", ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 12), AutoSize = true, Left = 30, Top = 30, Visible = false };

        var prevBtn = new CardButton { Text = "<", Width = 36, Height = 36, CornerRadius = 18 };
        prevBtn.Click += (_, _) => AdvanceCarousel(-1);
        var nextBtn = new CardButton { Text = ">", Width = 36, Height = 36, CornerRadius = 18 };
        nextBtn.Click += (_, _) => AdvanceCarousel(1);
        _dotsPanel = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = Color.Transparent };

        _carousel.Controls.Add(_carouselFeaturedLabel);
        _carousel.Controls.Add(_carouselTitle);
        _carousel.Controls.Add(_carouselPlayButton);
        _carousel.Controls.Add(_emptyLabel);
        _carousel.Controls.Add(prevBtn);
        _carousel.Controls.Add(nextBtn);
        _carousel.Controls.Add(_dotsPanel);
        _carousel.Resize += (_, _) =>
        {
            prevBtn.Location = new Point(_carousel.Width - 100, _carousel.Height - 56);
            nextBtn.Location = new Point(_carousel.Width - 56, _carousel.Height - 56);
            _dotsPanel.Location = new Point(30, _carousel.Height - 40);
        };

        var gamesHeaderRow = SectionHeaderRow("GAMES", out _gamesViewAll);
        _gamesViewAll.Click += (_, _) => NavigateRequested?.Invoke("games");
        Controls.Add(_gamesRow = PreviewRow());
        Controls.Add(gamesHeaderRow);

        var appsHeaderRow = SectionHeaderRow("APPLICATIONS", out _appsViewAll);
        _appsViewAll.Click += (_, _) => NavigateRequested?.Invoke("applications");
        Controls.Add(_appsRow = PreviewRow());
        Controls.Add(appsHeaderRow);

        // Docked controls stack in reverse-add order for DockStyle.Top -
        // adding header-then-row per section, but wanting header ABOVE
        // its row visually, means adding row first, header second, for
        // each section, then relying on BringToFront ordering below to
        // get carousel -> games header -> games row -> apps header ->
        // apps row top-to-bottom.
        gamesHeaderRow.BringToFront();
        _gamesRow.BringToFront();
        appsHeaderRow.BringToFront();
        _appsRow.BringToFront();
        carouselWrap.BringToFront();

        _carouselAutoAdvance = new System.Windows.Forms.Timer { Interval = 8000 };
        _carouselAutoAdvance.Tick += (_, _) => AdvanceCarousel(1);

        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(ApplyTheme); };
        ApplyTheme();
    }

    private FlowLayoutPanel PreviewRow() => new()
    {
        Dock = DockStyle.Top, Height = 190, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(20, 0, 20, 10), AutoSize = false
    };

    private Panel SectionHeaderRow(string title, out CardButton viewAllButton)
    {
        var row = new Panel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(20, 10, 20, 0) };
        var label = new Label { Text = title, Font = new Font("Segoe UI", 12, FontStyle.Bold), AutoSize = true, Left = 20, Top = 10 };
        var button = new CardButton { Text = "VIEW ALL >", Width = 100, Height = 24, Font = new Font("Segoe UI", 8, FontStyle.Bold), CornerRadius = 4 };
        row.Controls.Add(label);
        row.Controls.Add(button);
        row.Resize += (_, _) => { button.Location = new Point(row.Width - 120, 10); };
        viewAllButton = button;
        return row;
    }

    private void ApplyTheme()
    {
        BackColor = Theme.Background;
        _carousel.BackColor = Theme.Surface;
        _carouselFeaturedLabel.ForeColor = Theme.TextMuted;
        _carouselPlayButton.BackColor = Theme.Accent;
        _emptyLabel.ForeColor = Theme.TextMuted;
    }

    public async Task RefreshAsync()
    {
        AppCatalogResponse? result;
        try
        {
            result = await _api.GetAppsAsync(_config.Mac, _config.DeviceSecret);
        }
        catch
        {
            return;
        }
        if (IsDisposed || !IsHandleCreated || result == null || !result.Success) return;

        _featured = result.Apps.Where(a => a.Featured).OrderBy(a => a.DisplayOrder).ToList();
        if (_carouselIndex >= _featured.Count) _carouselIndex = 0;
        RenderCarousel();

        RenderRow(_gamesRow, result.Apps.Where(a => a.Type == "game").OrderBy(a => a.DisplayOrder).Take(PreviewRowCount));
        RenderRow(_appsRow, result.Apps.Where(a => a.Type == "app").OrderBy(a => a.DisplayOrder).Take(PreviewRowCount));
    }

    private void RenderRow(FlowLayoutPanel row, IEnumerable<AppCatalogEntry> apps)
    {
        row.SuspendLayout();
        row.Controls.Clear();
        foreach (var app in apps) row.Controls.Add(CatalogTiles.BuildTile(app, large: false, AppLauncher.Launch));
        row.ResumeLayout();
    }

    private void AdvanceCarousel(int direction)
    {
        if (_featured.Count == 0) return;
        _carouselIndex = (_carouselIndex + direction + _featured.Count) % _featured.Count;
        RenderCarousel();
    }

    private void RenderCarousel()
    {
        var hasFeatured = _featured.Count > 0;
        _carouselFeaturedLabel.Visible = hasFeatured;
        _carouselTitle.Visible = hasFeatured;
        _carouselPlayButton.Visible = hasFeatured;
        _emptyLabel.Visible = !hasFeatured;
        _carouselArt.Image = null;

        _dotsPanel.Controls.Clear();
        if (!hasFeatured)
        {
            _carouselAutoAdvance.Stop();
            return;
        }

        var app = _featured[_carouselIndex];
        _carouselTitle.Text = app.Name;

        var artPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), "banner.png");
        if (File.Exists(artPath))
        {
            try { _carouselArt.Image = Image.FromFile(artPath); } catch { /* fall through, keep blank */ }
        }

        for (var i = 0; i < _featured.Count; i++)
        {
            var dot = new Label
            {
                Text = "●", Width = 20, Height = 20, TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = i == _carouselIndex ? Theme.Accent : Theme.TextMuted
            };
            _dotsPanel.Controls.Add(dot);
        }

        if (_featured.Count > 1) _carouselAutoAdvance.Start();
        else _carouselAutoAdvance.Stop();
    }

    public void OnShown() => _carouselAutoAdvance.Start();
    public void OnHidden() => _carouselAutoAdvance.Stop();
}
