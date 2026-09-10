using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace StarkFiRentalClient.UI;

public class CardButton : Button
{
	private bool _hovering;

	public int CornerRadius { get; set; } = 10;

	public CardButton()
	{
		SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, value: true);
		base.FlatStyle = FlatStyle.Flat;
		base.FlatAppearance.BorderSize = 0;
		base.FlatAppearance.MouseOverBackColor = BackColor;
		base.FlatAppearance.MouseDownBackColor = BackColor;
		Cursor = Cursors.Hand;
		ForeColor = Theme.TextPrimary;
		Font = new Font("Segoe UI", 10f, FontStyle.Bold);
		base.MouseEnter += delegate
		{
			_hovering = true;
			Invalidate();
		};
		base.MouseLeave += delegate
		{
			_hovering = false;
			Invalidate();
		};
	}

	private GraphicsPath RoundedRect(Rectangle bounds, int radius)
	{
		GraphicsPath graphicsPath = new GraphicsPath();
		int num = radius * 2;
		if (num <= 0 || bounds.Width <= num || bounds.Height <= num)
		{
			graphicsPath.AddRectangle(bounds);
			return graphicsPath;
		}
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
		Color color = (_hovering ? Theme.Lighten(BackColor, 20) : BackColor);
		using GraphicsPath path = RoundedRect(bounds, CornerRadius);
		using SolidBrush brush = new SolidBrush(color);
		e.Graphics.FillPath(brush, path);
		TextFormatFlags flags = TextFormatFlags.EndEllipsis | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter;
		TextRenderer.DrawText(e.Graphics, Text, Font, bounds, ForeColor, flags);
	}
}
