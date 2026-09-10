using System;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StarkFiRentalClient;

public class ClientConfig
{
	private static readonly string ConfigDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental");

	private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");

	public string ServerUrl { get; set; } = "";

	public string Mac { get; set; } = "";

	public string DeviceSecret { get; set; } = "";

	public int PcId { get; set; }

	public static string GetMacAddress()
	{
		NetworkInterface[] allNetworkInterfaces = NetworkInterface.GetAllNetworkInterfaces();
		foreach (NetworkInterface networkInterface in allNetworkInterfaces)
		{
			if (networkInterface.OperationalStatus != OperationalStatus.Up || networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback)
			{
				continue;
			}
			string text = networkInterface.GetPhysicalAddress().ToString();
			if (!string.IsNullOrEmpty(text))
			{
				return string.Join(":", from m in Regex.Matches(text, "..")
					select m.Value).ToLowerInvariant();
			}
		}
		throw new InvalidOperationException("No network adapter with a MAC address found.");
	}

	public static ClientConfig? Load()
	{
		if (!File.Exists(ConfigPath))
		{
			return null;
		}
		try
		{
			return JsonSerializer.Deserialize<ClientConfig>(File.ReadAllText(ConfigPath));
		}
		catch
		{
			return null;
		}
	}

	public void Save()
	{
		Directory.CreateDirectory(ConfigDir);
		File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this));
	}
}
