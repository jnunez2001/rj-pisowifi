using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient.Pages;

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

	private List<AppCatalogEntry> _featured = new List<AppCatalogEntry>();

	private int _carouselIndex;

	private readonly Timer _carouselAutoAdvance;

	public event Action<string>? NavigateRequested;

	public HomePage(RentalApiClient api, ClientConfig config)
	{
		_api = api;
		_config = config;
		Dock = DockStyle.Fill;
		BackColor = Theme.Background;
		AutoScroll = true;
		_carousel = new RoundedPanel
		{
			Height = 300,
			Dock = DockStyle.Top,
			Margin = new Padding(20),
			CornerRadius = 16
		};
		Panel panel = new Panel
		{
			Height = 340,
			Dock = DockStyle.Top,
			Padding = new Padding(20)
		};
		panel.Controls.Add(_carousel);
		base.Controls.Add(panel);
		_carouselArt = new PictureBox
		{
			Dock = DockStyle.Fill,
			SizeMode = PictureBoxSizeMode.StretchImage
		};
		_carousel.Controls.Add(_carouselArt);
		_carouselFeaturedLabel = new Label
		{
			Text = "FEATURED GAME",
			ForeColor = Theme.TextMuted,
			Font = new Font("Segoe UI", 9f, FontStyle.Bold),
			AutoSize = true,
			Left = 30,
			Top = 30
		};
		_carouselTitle = new Label
		{
			ForeColor = Color.White,
			Font = new Font("Segoe UI", 26f, FontStyle.Bold),
			AutoSize = true,
			Left = 30,
			Top = 56
		};
		_carouselPlayButton = new CardButton
		{
			Text = "PLAY NOW",
			Width = 160,
			Height = 40,
			Left = 30,
			Top = 130,
			CornerRadius = 8,
			BackColor = Theme.Accent
		};
		_carouselPlayButton.Click += delegate
		{
			if (_featured.Count > 0)
			{
				AppLauncher.Launch(_featured[_carouselIndex]);
			}
		};
		_emptyLabel = new Label
		{
			Text = "No featured games yet.",
			ForeColor = Theme.TextMuted,
			Font = new Font("Segoe UI", 12f),
			AutoSize = true,
			Left = 30,
			Top = 30,
			Visible = false
		};
		CardButton prevBtn = new CardButton
		{
			Text = "<",
			Width = 36,
			Height = 36,
			CornerRadius = 18
		};
		prevBtn.Click += delegate
		{
			AdvanceCarousel(-1);
		};
		CardButton nextBtn = new CardButton
		{
			Text = ">",
			Width = 36,
			Height = 36,
			CornerRadius = 18
		};
		nextBtn.Click += delegate
		{
			AdvanceCarousel(1);
		};
		_dotsPanel = new FlowLayoutPanel
		{
			AutoSize = true,
			FlowDirection = FlowDirection.LeftToRight,
			BackColor = Color.Transparent
		};
		_carousel.Controls.Add(_carouselFeaturedLabel);
		_carousel.Controls.Add(_carouselTitle);
		_carousel.Controls.Add(_carouselPlayButton);
		_carousel.Controls.Add(_emptyLabel);
		_carousel.Controls.Add(prevBtn);
		_carousel.Controls.Add(nextBtn);
		_carousel.Controls.Add(_dotsPanel);
		_carousel.Resize += delegate
		{
			prevBtn.Location = new Point(_carousel.Width - 100, _carousel.Height - 56);
			nextBtn.Location = new Point(_carousel.Width - 56, _carousel.Height - 56);
			_dotsPanel.Location = new Point(30, _carousel.Height - 40);
		};
		Panel panel2 = SectionHeaderRow("GAMES", out _gamesViewAll);
		_gamesViewAll.Click += delegate
		{
			NavigateRequested?.Invoke("games");
		};
		base.Controls.Add(_gamesRow = PreviewRow());
		base.Controls.Add(panel2);
		Panel panel3 = SectionHeaderRow("APPLICATIONS", out _appsViewAll);
		_appsViewAll.Click += delegate
		{
			NavigateRequested?.Invoke("applications");
		};
		base.Controls.Add(_appsRow = PreviewRow());
		base.Controls.Add(panel3);
		panel2.BringToFront();
		_gamesRow.BringToFront();
		panel3.BringToFront();
		_appsRow.BringToFront();
		panel.BringToFront();
		_carouselAutoAdvance = new Timer
		{
			Interval = 8000
		};
		_carouselAutoAdvance.Tick += delegate
		{
			AdvanceCarousel(1);
		};
		Theme.Changed += delegate
		{
			if (base.IsHandleCreated)
			{
				BeginInvoke(ApplyTheme);
			}
		};
		ApplyTheme();
	}

	private FlowLayoutPanel PreviewRow()
	{
		return new FlowLayoutPanel
		{
			Dock = DockStyle.Top,
			Height = 190,
			FlowDirection = FlowDirection.LeftToRight,
			Padding = new Padding(20, 0, 20, 10),
			AutoSize = false
		};
	}

	private Panel SectionHeaderRow(string title, out CardButton viewAllButton)
	{
		Panel row = new Panel
		{
			Dock = DockStyle.Top,
			Height = 40,
			Padding = new Padding(20, 10, 20, 0)
		};
		Label value = new Label
		{
			Text = title,
			Font = new Font("Segoe UI", 12f, FontStyle.Bold),
			AutoSize = true,
			Left = 20,
			Top = 10
		};
		CardButton button = new CardButton
		{
			Text = "VIEW ALL >",
			Width = 100,
			Height = 24,
			Font = new Font("Segoe UI", 8f, FontStyle.Bold),
			CornerRadius = 4
		};
		row.Controls.Add(value);
		row.Controls.Add(button);
		row.Resize += delegate
		{
			button.Location = new Point(row.Width - 120, 10);
		};
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
		AppCatalogResponse appCatalogResponse;
		try
		{
			appCatalogResponse = await _api.GetAppsAsync(_config.Mac, _config.DeviceSecret);
		}
		catch
		{
			return;
		}
		if (!base.IsDisposed && base.IsHandleCreated && appCatalogResponse != null && appCatalogResponse.Success)
		{
			_featured = (from a in appCatalogResponse.Apps
				where a.Featured
				orderby a.DisplayOrder
				select a).ToList();
			if (_carouselIndex >= _featured.Count)
			{
				_carouselIndex = 0;
			}
			RenderCarousel();
			RenderRow(_gamesRow, (from a in appCatalogResponse.Apps
				where a.Type == "game"
				orderby a.DisplayOrder
				select a).Take(5));
			RenderRow(_appsRow, (from a in appCatalogResponse.Apps
				where a.Type == "app"
				orderby a.DisplayOrder
				select a).Take(5));
		}
	}

	private void RenderRow(FlowLayoutPanel row, IEnumerable<AppCatalogEntry> apps)
	{
		row.SuspendLayout();
		row.Controls.Clear();
		foreach (AppCatalogEntry app in apps)
		{
			row.Controls.Add(CatalogTiles.BuildTile(app, large: false, AppLauncher.Launch));
		}
		row.ResumeLayout();
	}

	private void AdvanceCarousel(int direction)
	{
		if (_featured.Count != 0)
		{
			_carouselIndex = (_carouselIndex + direction + _featured.Count) % _featured.Count;
			RenderCarousel();
		}
	}

	private void RenderCarousel()
	{
		bool flag = _featured.Count > 0;
		_carouselFeaturedLabel.Visible = flag;
		_carouselTitle.Visible = flag;
		_carouselPlayButton.Visible = flag;
		_emptyLabel.Visible = !flag;
		_carouselArt.Image = null;
		_dotsPanel.Controls.Clear();
		if (!flag)
		{
			_carouselAutoAdvance.Stop();
			return;
		}
		AppCatalogEntry appCatalogEntry = _featured[_carouselIndex];
		_carouselTitle.Text = appCatalogEntry.Name;
		string text = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", appCatalogEntry.Id.ToString(), "banner.png");
		if (File.Exists(text))
		{
			try
			{
				_carouselArt.Image = Image.FromFile(text);
			}
			catch
			{
			}
		}
		for (int i = 0; i < _featured.Count; i++)
		{
			Label value = new Label
			{
				Text = "●",
				Width = 20,
				Height = 20,
				TextAlign = ContentAlignment.MiddleCenter,
				ForeColor = ((i == _carouselIndex) ? Theme.Accent : Theme.TextMuted)
			};
			_dotsPanel.Controls.Add(value);
		}
		if (_featured.Count > 1)
		{
			_carouselAutoAdvance.Start();
		}
		else
		{
			_carouselAutoAdvance.Stop();
		}
	}

	public void OnShown()
	{
		_carouselAutoAdvance.Start();
	}

	public void OnHidden()
	{
		_carouselAutoAdvance.Stop();
	}
}
