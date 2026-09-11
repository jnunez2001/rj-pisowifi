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
    [JsonPropertyName("instructions_text")] public string? InstructionsText { get; set; }
    [JsonPropertyName("logged_in_points")] public int? LoggedInPoints { get; set; }
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

// POST /api/rental/admin-panel/client-version response - the OTA
// self-update version check (server/routes/rental.js).
public class ClientUpdateVersionResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
}

// POST /api/rental/admin-panel/settings/read response - the Admin Panel
// screen's read-only settings bundle (server/routes/rental.js).
public class AdminPanelSettingsResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("min_credit_to_register")] public int MinCreditToRegister { get; set; }
    [JsonPropertyName("idle_shutdown_secs")] public int IdleShutdownSecs { get; set; }
    [JsonPropertyName("guest_conversion_enabled")] public bool GuestConversionEnabled { get; set; }
    [JsonPropertyName("guest_conversion_min_minutes")] public int GuestConversionMinMinutes { get; set; }
    [JsonPropertyName("redeem_rates")] public List<RedeemRate> RedeemRates { get; set; } = new();
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

// GET /api/rental/whitelisted-apps response - Clean Up on Exit's
// allow-list (process names exempt from being force-closed).
public class WhitelistedAppsResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("apps")] public List<string> Apps { get; set; } = new();
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

// GET /api/rental/share-time/targets response - Share Time's "Send to PC"
// picker (server/routes/rental.js).
public class ShareTimeTargetsResponse
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("targets")] public List<ShareTimeTarget> Targets { get; set; } = new();
}

public class ShareTimeTarget
{
    [JsonPropertyName("pc_id")] public int PcId { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("occupant_label")] public string OccupantLabel { get; set; } = "";
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

    // Lock screen's "Call Staff" button - no password gate, this is a
    // customer flagging that they need help, distinct from staff
    // authenticating themselves (StaffOverrideAsync/PauseAsync above).
    public async Task<ApiResult?> RequestHelpAsync(string mac, string deviceSecret)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/help-request", new { mac, device_secret = deviceSecret });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // Clean Up on Exit's allow-list.
    public async Task<WhitelistedAppsResponse?> GetWhitelistedAppsAsync(string mac, string deviceSecret)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/rental/whitelisted-apps?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}");
        return await res.Content.ReadFromJsonAsync<WhitelistedAppsResponse>();
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

    // --- Share Time (server/routes/rental.js) - a logged-in member sending
    // some of their own rental_members.seconds balance to another active
    // PC's occupant or directly to another member by username. Member-only
    // at the server (a guest has no shareable balance) - see CafeHomeForm's
    // member-only menu visibility for the client-side mirror of that rule.

    public async Task<ShareTimeTargetsResponse?> GetShareTimeTargetsAsync(string mac, string deviceSecret)
    {
        var res = await _http.GetAsync($"{_baseUrl}/api/rental/share-time/targets?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}");
        return await res.Content.ReadFromJsonAsync<ShareTimeTargetsResponse>();
    }

    public async Task<ApiResult?> ShareTimeAsync(string mac, string deviceSecret, int minutes, string targetType, int? targetPcId, string? targetUsername)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/share-time", new
        {
            mac,
            device_secret = deviceSecret,
            minutes,
            target_type = targetType,
            target_pc_id = targetPcId,
            target_username = targetUsername
        });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // --- Kiosk Admin Panel (server/routes/rental.js's device-scoped
    // "Kiosk Admin Panel" block) - authenticated by mac+device_secret
    // exactly like every other call above, PLUS a password checked
    // against the separate rental_admin_panel_password setting (never the
    // site's real global admin password). Deliberately narrow: only the
    // settings/redeem-rate fields these five endpoints expose, never a
    // generic passthrough.

    public async Task<ApiResult?> VerifyAdminPanelPasswordAsync(string mac, string deviceSecret, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/admin-panel/verify", new { mac, device_secret = deviceSecret, password });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // POST, not GET - device_secret/password are carried in the JSON body
    // rather than the URL query string, matching the reasoning already used
    // for the other admin-panel calls below (keeps credentials out of any
    // proxy/access logs or browser history).
    public async Task<AdminPanelSettingsResponse?> GetAdminPanelSettingsAsync(string mac, string deviceSecret, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/admin-panel/settings/read", new { mac, device_secret = deviceSecret, password });
        return await res.Content.ReadFromJsonAsync<AdminPanelSettingsResponse>();
    }

    // Partial update - only pass the field(s) that actually changed, since
    // the endpoint only ever touches whichever of these two exact keys is
    // present in the body (see server/routes/rental.js's comment on this
    // route).
    public async Task<ApiResult?> SaveAdminPanelSettingsAsync(string mac, string deviceSecret, string password, bool? guestConversionEnabled = null, int? guestConversionMinMinutes = null)
    {
        var body = new Dictionary<string, object?> { ["mac"] = mac, ["device_secret"] = deviceSecret, ["password"] = password };
        if (guestConversionEnabled.HasValue) body["guest_conversion_enabled"] = guestConversionEnabled.Value;
        if (guestConversionMinMinutes.HasValue) body["guest_conversion_min_minutes"] = guestConversionMinMinutes.Value;
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/admin-panel/settings", body);
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    public async Task<ApiResult?> AddAdminPanelRedeemRateAsync(string mac, string deviceSecret, string password, int points, int rewardSeconds)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/admin-panel/redeem-rates", new { mac, device_secret = deviceSecret, password, points, reward_seconds = rewardSeconds });
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // DELETE with mac/device_secret/password in the JSON body (not query) -
    // matches the server route's own reasoning for keeping credentials out
    // of any URL/query string or logs.
    public async Task<ApiResult?> DeleteAdminPanelRedeemRateAsync(string mac, string deviceSecret, string password, int id)
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, $"{_baseUrl}/api/rental/admin-panel/redeem-rates/{id}")
        {
            Content = JsonContent.Create(new { mac, device_secret = deviceSecret, password })
        };
        var res = await _http.SendAsync(request);
        return await res.Content.ReadFromJsonAsync<ApiResult>();
    }

    // --- OTA self-update (server/routes/rental.js's admin-panel/client-*
    // routes) - the Windows client's own analog of the ESP8266 vendo
    // firmware's version-check/download pair. Same requireAdminPanelAuth
    // gate and body-credentials convention as every other admin-panel call
    // above.

    public async Task<string?> GetClientUpdateVersionAsync(string mac, string deviceSecret, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/rental/admin-panel/client-version", new { mac, device_secret = deviceSecret, password });
        var body = await res.Content.ReadFromJsonAsync<ClientUpdateVersionResponse>();
        return body?.Success == true ? body.Version : null;
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
