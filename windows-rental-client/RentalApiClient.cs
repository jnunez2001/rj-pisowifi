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
    [JsonPropertyName("reason")] public string? Reason { get; set; }
    [JsonPropertyName("needed")] public int Needed { get; set; }
    [JsonPropertyName("total")] public int Total { get; set; }
    [JsonPropertyName("account_created")] public bool AccountCreated { get; set; }
    [JsonPropertyName("username")] public string? Username { get; set; }
    [JsonPropertyName("seconds")] public int Seconds { get; set; }
    [JsonPropertyName("points")] public int Points { get; set; }
    [JsonPropertyName("redeem_rates")] public List<RedeemRate>? RedeemRates { get; set; }
    [JsonPropertyName("remaining_points")] public int RemainingPoints { get; set; }
    [JsonPropertyName("seconds_added")] public int SecondsAdded { get; set; }
}

public class RedeemRate
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("points")] public int Points { get; set; }
    [JsonPropertyName("reward_seconds")] public int RewardSeconds { get; set; }
}

// GET /api/rental/apps response - Café Home's game/app catalog.
// Metadata only, no image URLs: the blueprint's Local Game Library
// design explicitly says artwork must live locally on each PC, not be
// downloaded from the server - see CafeHomeForm's GameArt\<id>\
// folder convention for how art is actually resolved.
public class AppCatalogResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("categories")] public List<AppCategory> Categories { get; set; } = new();
    [JsonPropertyName("apps")] public List<AppCatalogEntry> Apps { get; set; } = new();
}

public class AppCategory
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("display_order")] public int DisplayOrder { get; set; }
}

public class AppCatalogEntry
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("category_id")] public int? CategoryId { get; set; }
    [JsonPropertyName("type")] public string Type { get; set; } = "game";
    [JsonPropertyName("executable_path")] public string ExecutablePath { get; set; } = "";
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("featured")] public bool Featured { get; set; }
    [JsonPropertyName("display_order")] public int DisplayOrder { get; set; }
}

// GET /api/coin/pending/:mac response - a plain running-total poll, not
// mac+device_secret gated (matches how the WiFi portal itself uses this
// same endpoint).
public class PendingCoinStatus
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("pending")] public bool Pending { get; set; }
    [JsonPropertyName("total")] public int Total { get; set; }
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

    // --- Coin insert flow (server/routes/coin.js, not rental.js - a
    // different base path, and not mac+device_secret gated the way
    // everything else here is; matches how the WiFi portal itself talks
    // to these same three endpoints). Shared by Insert Coins, Create
    // Account, and Add Time in the UI - see CoinInsertPanel.cs.

    // mode: 'pc_rental' (guest credit) or 'pc_rental_create_account'
    // (username/password required for the latter).
    public async Task<ApiResult?> OpenCoinPendingAsync(string mac, string mode, string? username = null, string? password = null)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/coin/pending", new { mac, mode, username, password });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<PendingCoinStatus?> GetPendingCoinStatusAsync(string mac)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/coin/pending/{Uri.EscapeDataString(mac)}");
        return await res.Content.ReadFromJsonAsync<PendingCoinStatus>();
    }

    public async Task<ApiResult?> FinalizeCoinsAsync(string mac)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/coin/finalize", new { mac });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // Café Home's game/app catalog. Fetched far less often than status
    // (a caller polls this on its own longer interval, e.g. once at
    // Café Home entry and every ~60s after) - see CafeHomeForm.
    public async Task<AppCatalogResponse?> GetAppsAsync(string mac, string deviceSecret)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/rental/apps?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}");
        return await res.Content.ReadFromJsonAsync<AppCatalogResponse>();
    }

    // --- Points / account (server/routes/rental.js) ---

    public async Task<ApiResult?> GetMemberPointsAsync(string mac, string deviceSecret)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/rental/member-points?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}");
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> RedeemAsync(string mac, string deviceSecret, int redeemRateId)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/redeem", new { mac, device_secret = deviceSecret, redeem_rate_id = redeemRateId });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> ChangePasswordAsync(string mac, string deviceSecret, string currentPassword, string newPassword)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/change-password", new { mac, device_secret = deviceSecret, current_password = currentPassword, new_password = newPassword });
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
