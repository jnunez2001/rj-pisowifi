using System;
using System.IO;
using System.Text.Json;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

public class ClientPreferences
{
	private static readonly string PreferencesDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental");

	private static readonly string PreferencesPath = Path.Combine(PreferencesDir, "preferences.json");

	public ThemeName Theme { get; set; }

	public bool AutoLogoutEnabled { get; set; } = true;

	public int AutoLogoutMinutes { get; set; } = 15;

	public bool StartOnBoot { get; set; }

	public bool NotifySessionAlerts { get; set; } = true;

	public bool NotifyPromotions { get; set; } = true;

	public bool NotifyRewardsUpdates { get; set; } = true;

	public bool SessionReminderEnabled { get; set; } = true;

	public int SessionReminderMinutesBefore { get; set; } = 5;

	public bool CleanUpOnExit { get; set; } = true;

	public static ClientPreferences Load()
	{
		if (!File.Exists(PreferencesPath))
		{
			return new ClientPreferences();
		}
		try
		{
			return JsonSerializer.Deserialize<ClientPreferences>(File.ReadAllText(PreferencesPath)) ?? new ClientPreferences();
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
