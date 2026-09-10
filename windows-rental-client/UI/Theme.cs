namespace StarkFiRentalClient.UI;

// Runtime-swappable color palette (V1.0.0 mockup rebuild) - three presets
// matching Settings > Theme exactly ("Dark", "Neon Purple", "Light
// Gaming"). Every screen reads colors from here instead of hardcoding
// Color.FromArgb() calls per-control the way the original LockForm/
// CountdownWidget did, so picking a new theme actually re-paints
// already-open screens instead of needing a restart.
public enum ThemeName { Dark, NeonPurple, LightGaming }

public static class Theme
{
    public static ThemeName Current { get; private set; } = ThemeName.LightGaming;

    public static Color Background { get; private set; }
    public static Color Surface { get; private set; } // card/panel background
    public static Color SurfaceAlt { get; private set; } // sidebar/top bar background
    public static Color Border { get; private set; } // card/button outlines (LightGaming's outlined CardButton)
    public static Color Accent { get; private set; } // primary (blue/green) - Guest card, nav highlight
    public static Color AccentAlt { get; private set; } // secondary - Member card
    public static Color OnAccent { get; private set; } // text/icon color painted on top of Accent
    public static Color OnAccentAlt { get; private set; } // text/icon color painted on top of AccentAlt
    public static Color TextPrimary { get; private set; }
    public static Color TextMuted { get; private set; }
    public static Color Success { get; private set; }
    public static Color Danger { get; private set; }

    // Other forms subscribe to this to repaint themselves the moment
    // Settings > Theme changes, rather than requiring a restart.
    public static event Action? Changed;

    static Theme()
    {
        Apply(ThemeName.LightGaming);
    }

    public static void Apply(ThemeName name)
    {
        Current = name;
        if (name == ThemeName.NeonPurple)
        {
            Background = Color.FromArgb(15, 10, 25);
            Surface = Color.FromArgb(30, 20, 48);
            SurfaceAlt = Color.FromArgb(22, 14, 38);
            Border = Color.FromArgb(30, 20, 48);
            Accent = Color.FromArgb(139, 92, 246);
            AccentAlt = Color.FromArgb(236, 72, 153);
            OnAccent = Color.White;
            OnAccentAlt = Color.White;
            TextPrimary = Color.White;
            TextMuted = Color.FromArgb(180, 168, 200);
            Success = Color.FromArgb(74, 222, 128);
            Danger = Color.FromArgb(248, 113, 113);
        }
        else if (name == ThemeName.LightGaming)
        {
            Background = Color.FromArgb(0xFB, 0xFA, 0xF8);
            Surface = Color.FromArgb(0xFF, 0xFF, 0xFF);
            SurfaceAlt = Color.FromArgb(0xF3, 0xF2, 0xEE);
            Border = Color.FromArgb(0xD9, 0xD7, 0xD4);
            Accent = Color.FromArgb(0x2F, 0xAE, 0x6E);
            AccentAlt = Color.FromArgb(0xD9, 0xD7, 0xD4);
            OnAccent = Color.White;
            OnAccentAlt = Color.FromArgb(0x23, 0x21, 0x1C);
            TextPrimary = Color.FromArgb(0x23, 0x21, 0x1C);
            TextMuted = Color.FromArgb(0x65, 0x63, 0x5D);
            Success = Color.FromArgb(0x2F, 0xAE, 0x6E);
            Danger = Color.FromArgb(0xCA, 0x55, 0x51);
        }
        else
        {
            Background = Color.FromArgb(10, 14, 26);
            Surface = Color.FromArgb(19, 26, 43);
            SurfaceAlt = Color.FromArgb(14, 19, 33);
            Border = Color.FromArgb(19, 26, 43);
            Accent = Color.FromArgb(47, 111, 237);
            AccentAlt = Color.FromArgb(230, 57, 70);
            OnAccent = Color.White;
            OnAccentAlt = Color.White;
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
