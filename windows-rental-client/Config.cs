using System.Linq;
using System.Net.NetworkInformation;
using System.Text.Json;

namespace StarkFiRentalClient;

// Local pairing state - generated once on first run, then reused forever
// (or until the operator deletes the file, which forces a fresh
// registration as a new 'candidate' PC). Same shape as every other
// device pairing in this app (vendos/satellite_kiosks/rental_pcs):
// server issues a device_secret on first contact, this file is the only
// place it's stored.
public class ClientConfig
{
    public string ServerUrl { get; set; } = "";
    public string Mac { get; set; } = "";
    public string DeviceSecret { get; set; } = "";
    public int PcId { get; set; }

    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");

    public static string GetMacAddress()
    {
        // First up, non-loopback, non-virtual adapter with a real MAC -
        // matches the "one real network identity" assumption the server
        // side already makes for every other device type in this app.
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            var mac = nic.GetPhysicalAddress().ToString();
            if (string.IsNullOrEmpty(mac)) continue;
            return string.Join(":", System.Text.RegularExpressions.Regex.Matches(mac, "..").Select(m => m.Value)).ToLowerInvariant();
        }
        throw new InvalidOperationException("No network adapter with a MAC address found.");
    }

    public static ClientConfig? Load()
    {
        if (!File.Exists(ConfigPath)) return null;
        try
        {
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<ClientConfig>(json);
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
