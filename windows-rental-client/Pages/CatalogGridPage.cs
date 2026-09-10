using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

// Shared base for GamesPage/ApplicationsPage - identical category-
// grouped grid, just filtered by rental_apps.type ("game" vs "app").
// Constructed once by CafeHomeForm and shown/hidden (not recreated) on
// navigation, so an in-progress catalog load survives switching away
// and back.
public class CatalogGridPage : UserControl
{
    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private readonly string _type;
    private readonly FlowLayoutPanel _body;
    private readonly Label _loadingLabel;

    public CatalogGridPage(RentalApiClient api, ClientConfig config, string type, string emptyMessage)
    {
        _api = api;
        _config = config;
        _type = type;
        Dock = DockStyle.Fill;
        BackColor = Theme.Background;

        _loadingLabel = new Label
        {
            Text = "Loading...", ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 11),
            AutoSize = false, Dock = DockStyle.Top, Height = 40, TextAlign = ContentAlignment.MiddleCenter
        };
        Controls.Add(_loadingLabel);

        _body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, AutoScroll = true, WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(20), BackColor = Theme.Background
        };
        Controls.Add(_body);
        _body.BringToFront();
        _loadingLabel.BringToFront();

        EmptyMessage = emptyMessage;
        Theme.Changed += () => { if (IsHandleCreated) BeginInvoke(() => { BackColor = Theme.Background; _body.BackColor = Theme.Background; }); };
    }

    private string EmptyMessage { get; }

    public async Task RefreshAsync()
    {
        AppCatalogResponse? result;
        try
        {
            result = await _api.GetAppsAsync(_config.Mac, _config.DeviceSecret);
        }
        catch
        {
            return; // network hiccup - keep whatever's already showing
        }
        if (IsDisposed || !IsHandleCreated) return;

        if (result == null || !result.Success)
        {
            _loadingLabel.Text = "Could not load the catalog. Ask staff for help.";
            _loadingLabel.Visible = true;
            return;
        }

        _loadingLabel.Visible = false;
        Render(result);
    }

    private void Render(AppCatalogResponse catalog)
    {
        _body.SuspendLayout();
        _body.Controls.Clear();

        var apps = catalog.Apps.Where(a => a.Type == _type).ToList();
        if (apps.Count == 0)
        {
            _body.Controls.Add(new Label
            {
                Text = EmptyMessage, ForeColor = Theme.TextMuted, Font = new Font("Segoe UI", 11),
                AutoSize = true, Margin = new Padding(10, 40, 10, 10)
            });
            _body.ResumeLayout();
            return;
        }

        var categoryNames = catalog.Categories.ToDictionary(c => c.Id, c => c.Name);
        var grouped = apps
            .GroupBy(a => a.CategoryId)
            .OrderBy(g => g.Key.HasValue && categoryNames.ContainsKey(g.Key.Value)
                ? catalog.Categories.First(c => c.Id == g.Key.Value).DisplayOrder
                : int.MaxValue);

        foreach (var group in grouped)
        {
            var name = group.Key.HasValue && categoryNames.TryGetValue(group.Key.Value, out var n) ? n : "Other";
            _body.Controls.Add(CatalogTiles.SectionHeader(name));
            foreach (var app in group.OrderBy(a => a.DisplayOrder))
                _body.Controls.Add(CatalogTiles.BuildTile(app, large: false, AppLauncher.Launch));
        }

        _body.ResumeLayout();
    }
}
