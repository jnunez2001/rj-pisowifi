using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace StarkFiRentalClient.UI;

public class RoundedPanel : Panel
{
	public int CornerRadius { get; set; } = 12;

	public Color BorderColor { get; set; } = Color.Transparent;

	public int BorderWidth { get; set; } = 2;

	public RoundedPanel()
	{
		SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, value: true);
		BackColor = Theme.Surface;
	}

	private GraphicsPath RoundedRect(Rectangle bounds, int radius)
	{
		GraphicsPath graphicsPath = new GraphicsPath();
		int num = radius * 2;
		graphicsPath.AddArc(bounds.X, bounds.Y, num, num, 180f, 90f);
		graphicsPath.AddArc(bounds.Right - num, bounds.Y, num, num, 270f, 90f);
		graphicsPath.AddArc(bounds.Right - num, bounds.Bottom - num, num, num, 0f, 90f);
		graphicsPath.AddArc(bounds.X, bounds.Bottom - num, num, num, 90f, 90f);
		graphicsPath.CloseFigure();
		return graphicsPath;
	}

	protected override void OnPaint(PaintEventArgs e)
	{
		e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
		Rectangle bounds = new Rectangle(0, 0, base.Width - 1, base.Height - 1);
		using GraphicsPath path = RoundedRect(bounds, CornerRadius);
		using SolidBrush brush = new SolidBrush(BackColor);
		e.Graphics.FillPath(brush, path);
		if (BorderColor != Color.Transparent && BorderWidth > 0)
		{
			using Pen pen = new Pen(BorderColor, BorderWidth);
			e.Graphics.DrawPath(pen, path);
		}
		base.OnPaint(e);
	}
}
