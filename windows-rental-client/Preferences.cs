using System.Text.Json;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

// User-facing display/behavior preferences (Settings page, V1.0.0
// mockup rebuild) - deliberately a SEPARATE file from ClientConfig
// (config.json), which holds pairing/identity data. Same exact
// load/save pattern as ClientConfig, just a second small JSON file
// next to it.
//
// Not every field here is functionally wired up yet - see the ones
// marked below. Storing an honest, inert preference is fine; silently
// pretending a toggle does something it doesn't is not.
public class ClientPreferences
{
    public ThemeName Theme { get; set; } = ThemeName.Dark;
    public bool AutoLogoutEnabled { get; set; } = true;
    public int AutoLogoutMinutes { get; set; } = 15;
    public bool StartOnBoot { get; set; }
    // Notification toggles - stored only, no delivery system exists yet
    // to actually gate (see Pages/SettingsPage.cs).
    public bool NotifySessionAlerts { get; set; } = true;
    public bool NotifyPromotions { get; set; } = true;
    public bool NotifyRewardsUpdates { get; set; } = true;
    public bool SessionReminderEnabled { get; set; } = true;
    public int SessionReminderMinutesBefore { get; set; } = 5;
    public bool CleanUpOnExit { get; set; } = true;

    private static readonly string PreferencesDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental");
    private static readonly string PreferencesPath = Path.Combine(PreferencesDir, "preferences.json");

    public static ClientPreferences Load()
    {
        if (!File.Exists(PreferencesPath)) return new ClientPreferences();
        try
        {
            var json = File.ReadAllText(PreferencesPath);
            return JsonSerializer.Deserialize<ClientPreferences>(json) ?? new ClientPreferences();
        }
        catch
        {
            return new ClientPreferences();
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(PreferencesDir);
        File.WriteAllText(PreferencesPath, JsonSerializer.Serialize(this));
    }
}
