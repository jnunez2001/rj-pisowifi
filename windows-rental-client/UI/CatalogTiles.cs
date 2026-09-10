using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace StarkFiRentalClient.UI;

public static class CatalogTiles
{
	public static Label SectionHeader(string text)
	{
		return new Label
		{
			Text = text,
			ForeColor = Theme.TextPrimary,
			Font = new Font("Segoe UI", 12f, FontStyle.Bold),
			AutoSize = false,
			Width = 1200,
			Height = 30,
			Margin = new Padding(0, 16, 0, 6)
		};
	}

	public static Control BuildTile(AppCatalogEntry app, bool large, Action<AppCatalogEntry> onLaunch)
	{
		int num = (large ? 220 : 160);
		Panel panel = new Panel
		{
			Width = num,
			Height = num + 30,
			Margin = new Padding(8),
			Cursor = Cursors.Hand,
			BackColor = Theme.Surface
		};
		PictureBox pictureBox = new PictureBox
		{
			Dock = DockStyle.Top,
			Height = num,
			SizeMode = PictureBoxSizeMode.Zoom,
			BackColor = Theme.Lighten(Theme.Surface, 15)
		};
		string text = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), large ? "banner.png" : "icon.png");
		if (!File.Exists(text))
		{
			text = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GameArt", app.Id.ToString(), "icon.png");
		}
		if (File.Exists(text))
		{
			try
			{
				pictureBox.Image = Image.FromFile(text);
			}
			catch
			{
			}
		}
		Label label = new Label
		{
			Text = app.Name,
			ForeColor = Theme.TextPrimary,
			Font = new Font("Segoe UI", 9f, FontStyle.Bold),
			Dock = DockStyle.Bottom,
			Height = 30,
			TextAlign = ContentAlignment.MiddleCenter
		};
		panel.Controls.Add(label);
		panel.Controls.Add(pictureBox);
		panel.Click += OnClick;
		pictureBox.Click += OnClick;
		label.Click += OnClick;
		return panel;
		void OnClick(object? _, EventArgs __)
		{
			onLaunch(app);
		}
	}
}
