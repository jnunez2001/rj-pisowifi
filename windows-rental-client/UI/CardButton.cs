using System.Drawing.Drawing2D;

namespace StarkFiRentalClient.UI;

// Rounded, hover-brightening button - used for every clickable card in
// the mockup (Guest/Member login, sidebar nav items, game/app tiles,
// footer buttons) instead of a plain flat System.Windows.Forms.Button,
// which can't produce rounded corners or a hover glow on its own.
public class CardButton : Button
{
    public int CornerRadius { get; set; } = 10;
    private bool _hovering;

    public CardButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        FlatAppearance.MouseOverBackColor = BackColor;
        FlatAppearance.MouseDownBackColor = BackColor;
        Cursor = Cursors.Hand;
        ForeColor = Theme.TextPrimary;
        Font = new Font("Segoe UI", 10, FontStyle.Bold);
        MouseEnter += (_, _) => { _hovering = true; Invalidate(); };
        MouseLeave += (_, _) => { _hovering = false; Invalidate(); };
    }

    private GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        if (d <= 0 || bounds.Width <= d || bounds.Height <= d)
        {
            path.AddRectangle(bounds);
            return path;
        }
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        var fillColor = _hovering ? Theme.Lighten(BackColor, 20) : BackColor;
        using var path = RoundedRect(bounds, CornerRadius);
        using var fill = new SolidBrush(fillColor);
        e.Graphics.FillPath(fill, path);

        var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis;
        TextRenderer.DrawText(e.Graphics, Text, Font, bounds, ForeColor, flags);
    }
}
