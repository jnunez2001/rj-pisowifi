namespace StarkFiRentalClient.UI;

// Runtime-swappable color palette (V1.0.0 mockup rebuild) - two presets
// matching Settings > Theme exactly ("Dark", "Neon Purple"). Every
// screen reads colors from here instead of hardcoding Color.FromArgb()
// calls per-control the way the original LockForm/CountdownWidget did,
// so picking a new theme actually re-paints already-open screens
// instead of needing a restart.
public enum ThemeName { Dark, NeonPurple }

public static class Theme
{
    public static ThemeName Current { get; private set; } = ThemeName.Dark;

    public static Color Background { get; private set; }
    public static Color Surface { get; private set; } // card/panel background
    public static Color SurfaceAlt { get; private set; } // sidebar/top bar background
    public static Color Accent { get; private set; } // primary (blue) - Guest card, nav highlight
    public static Color AccentAlt { get; private set; } // secondary (red) - Member card
    public static Color TextPrimary { get; private set; }
    public static Color TextMuted { get; private set; }
    public static Color Success { get; private set; }
    public static Color Danger { get; private set; }

    // Other forms subscribe to this to repaint themselves the moment
    // Settings > Theme changes, rather than requiring a restart.
    public static event Action? Changed;

    static Theme()
    {
        Apply(ThemeName.Dark);
    }

    public static void Apply(ThemeName name)
    {
        Current = name;
        if (name == ThemeName.NeonPurple)
        {
            Background = Color.FromArgb(15, 10, 25);
            Surface = Color.FromArgb(30, 20, 48);
            SurfaceAlt = Color.FromArgb(22, 14, 38);
            Accent = Color.FromArgb(139, 92, 246);
            AccentAlt = Color.FromArgb(236, 72, 153);
            TextPrimary = Color.White;
            TextMuted = Color.FromArgb(180, 168, 200);
            Success = Color.FromArgb(74, 222, 128);
            Danger = Color.FromArgb(248, 113, 113);
        }
        else
        {
            Background = Color.FromArgb(10, 14, 26);
            Surface = Color.FromArgb(19, 26, 43);
            SurfaceAlt = Color.FromArgb(14, 19, 33);
            Accent = Color.FromArgb(47, 111, 237);
            AccentAlt = Color.FromArgb(230, 57, 70);
            TextPrimary = Color.White;
            TextMuted = Color.FromArgb(158, 168, 189);
            Success = Color.FromArgb(52, 211, 153);
            Danger = Color.FromArgb(248, 113, 113);
        }
        Changed?.Invoke();
    }

    public static Color Lighten(Color c, int amount)
    {
        return Color.FromArgb(c.A, Math.Min(255, c.R + amount), Math.Min(255, c.G + amount), Math.Min(255, c.B + amount));
    }
}
