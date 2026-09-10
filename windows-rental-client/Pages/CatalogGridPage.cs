using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

public class CatalogGridPage : UserControl
{
	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private readonly string _type;

	private readonly FlowLayoutPanel _body;

	private readonly Label _loadingLabel;

	private string EmptyMessage { get; }

	public CatalogGridPage(RentalApiClient api, ClientConfig config, string type, string emptyMessage)
	{
		_api = api;
		_config = config;
		_type = type;
		Dock = DockStyle.Fill;
		BackColor = Theme.Background;
		_loadingLabel = new Label
		{
			Text = "Loading...",
			ForeColor = Theme.TextMuted,
			Font = new Font("Segoe UI", 11f),
			AutoSize = false,
			Dock = DockStyle.Top,
			Height = 40,
			TextAlign = ContentAlignment.MiddleCenter
		};
		base.Controls.Add(_loadingLabel);
		_body = new FlowLayoutPanel
		{
			Dock = DockStyle.Fill,
			AutoScroll = true,
			WrapContents = true,
			FlowDirection = FlowDirection.LeftToRight,
			Padding = new Padding(20),
			BackColor = Theme.Background
		};
		base.Controls.Add(_body);
		_body.BringToFront();
		_loadingLabel.BringToFront();
		EmptyMessage = emptyMessage;
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(delegate
				{
					BackColor = Theme.Background;
					_body.BackColor = Theme.Background;
				});
			}
		};
	}

	public async Task RefreshAsync()
	{
		AppCatalogResponse appCatalogResponse;
		try
		{
			appCatalogResponse = await _api.GetAppsAsync(_config.Mac, _config.DeviceSecret);
		}
		catch
		{
			return;
		}
		if (!base.IsDisposed && base.IsHandleCreated)
		{
			if (appCatalogResponse == null || !appCatalogResponse.Success)
			{
				_loadingLabel.Text = "Could not load the catalog. Ask staff for help.";
				_loadingLabel.Visible = true;
			}
			else
			{
				_loadingLabel.Visible = false;
				Render(appCatalogResponse);
			}
		}
	}

	private void Render(AppCatalogResponse catalog)
	{
		_body.SuspendLayout();
		_body.Controls.Clear();
		List<AppCatalogEntry> list = catalog.Apps.Where((AppCatalogEntry a) => a.Type == _type).ToList();
		if (list.Count == 0)
		{
			_body.Controls.Add(new Label
			{
				Text = EmptyMessage,
				ForeColor = Theme.TextMuted,
				Font = new Font("Segoe UI", 11f),
				AutoSize = true,
				Margin = new Padding(10, 40, 10, 10)
			});
			_body.ResumeLayout();
			return;
		}
		Dictionary<int, string> categoryNames = catalog.Categories.ToDictionary((AppCategory c) => c.Id, (AppCategory c) => c.Name);
		foreach (IGrouping<int?, AppCatalogEntry> item in from a in list
			group a by a.CategoryId into g
			orderby (!g.Key.HasValue || !categoryNames.ContainsKey(g.Key.Value)) ? int.MaxValue : catalog.Categories.First((AppCategory c) => c.Id == g.Key.Value).DisplayOrder
			select g)
		{
			string text = ((item.Key.HasValue && categoryNames.TryGetValue(item.Key.Value, out var value)) ? value : "Other");
			_body.Controls.Add(CatalogTiles.SectionHeader(text));
			foreach (AppCatalogEntry item2 in item.OrderBy((AppCatalogEntry a) => a.DisplayOrder))
			{
				_body.Controls.Add(CatalogTiles.BuildTile(item2, large: false, AppLauncher.Launch));
			}
		}
		_body.ResumeLayout();
	}
}
