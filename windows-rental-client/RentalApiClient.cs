using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class StatusResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("locked")] public bool Locked { get; set; }
    [JsonPropertyName("paused")] public bool Paused { get; set; }
    [JsonPropertyName("pc_name")] public string PcName { get; set; } = "";
    [JsonPropertyName("minutes_remaining")] public double MinutesRemaining { get; set; }
    [JsonPropertyName("adopted")] public bool Adopted { get; set; }
    [JsonPropertyName("logged_in_user")] public string? LoggedInUser { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("logo_url")] public string? LogoUrl { get; set; }
    [JsonPropertyName("wallpaper_url")] public string? WallpaperUrl { get; set; }
    [JsonPropertyName("lock_announcement")] public string? LockAnnouncement { get; set; }
}

public class ApiResult
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("minutes_remaining")] public double MinutesRemaining { get; set; }
    [JsonPropertyName("pc_id")] public int PcId { get; set; }
    [JsonPropertyName("device_secret")] public string? DeviceSecret { get; set; }
}

// Thin wrapper over the device-facing endpoints in server/routes/
// rental.js - every call here authenticates with mac+device_secret,
// never an admin session (this client can't have one). Mirrors the
// "dumb terminal" principle from the original design notes: this class
// only ever reports what the server says, it never computes lock state
// itself beyond the defensive "3 failed polls -> lock" fallback in
// StatusPoller.
public class RentalApiClient
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;

    public RentalApiClient(string baseUrl)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
    }

    public async Task<ApiResult?> RegisterAsync(string mac, string name, string? deviceSecret)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/register", new
        {
            mac,
            name,
            ip = GetLocalIp(),
            device_secret = deviceSecret
        });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<StatusResponse?> GetStatusAsync(string mac, string deviceSecret)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/rental/status?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}");
        return await res.Content.ReadFromJsonAsync<StatusResponse>();
    }

    public async Task<ApiResult?> MemberLoginAsync(string mac, string deviceSecret, string username, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/member-login", new
        {
            mac,
            device_secret = deviceSecret,
            username,
            password
        });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> MemberLogoutAsync(string mac, string deviceSecret)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/member-logout", new { mac, device_secret = deviceSecret });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> StaffOverrideAsync(string mac, string deviceSecret, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/staff-override", new { mac, device_secret = deviceSecret, password });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // Maintenance pause - distinct from StaffOverrideAsync above: override
    // is a short local-only unlock that never touches server state, this
    // suspends real enforcement (server-side) until ResumeAsync is called.
    public async Task<ApiResult?> PauseAsync(string mac, string deviceSecret, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/pause", new { mac, device_secret = deviceSecret, password });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> ResumeAsync(string mac, string deviceSecret)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/resume", new { mac, device_secret = deviceSecret });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    private static string GetLocalIp()
    {
        try
        {
            using var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Dgram, 0);
            socket.Connect("8.8.8.8", 65530);
            return (socket.LocalEndPoint as System.Net.IPEndPoint)?.Address.ToString() ?? "";
        }
        catch
        {
            return "";
        }
    }
}
