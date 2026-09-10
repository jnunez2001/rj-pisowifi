using System;
using System.Windows.Forms;
using Microsoft.Win32;

namespace StarkFiRentalClient;

public static class StartupManager
{
	private const string RunKeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

	private const string ValueName = "StarkFiRentalClient";

	public static void SetEnabled(bool enabled)
	{
		try
		{
			using RegistryKey registryKey = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", writable: true);
			if (registryKey != null)
			{
				if (enabled)
				{
					string text = Environment.ProcessPath ?? Application.ExecutablePath;
					registryKey.SetValue("StarkFiRentalClient", "\"" + text + "\"");
				}
				else
				{
					registryKey.DeleteValue("StarkFiRentalClient", throwOnMissingValue: false);
				}
			}
		}
		catch
		{
		}
	}

	public static bool IsEnabled()
	{
		try
		{
			using RegistryKey registryKey = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", writable: false);
			return registryKey?.GetValue("StarkFiRentalClient") != null;
		}
		catch
		{
			return false;
		}
	}
}
