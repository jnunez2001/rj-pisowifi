using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace StarkFiRentalClient;

public class RentalApiClient
{
	private readonly HttpClient _http;

	private readonly string _baseUrl;

	public RentalApiClient(string baseUrl)
	{
		_baseUrl = baseUrl.TrimEnd('/');
		_http = new HttpClient
		{
			Timeout = TimeSpan.FromSeconds(8.0)
		};
	}

	public async Task<ApiResult?> RegisterAsync(string mac, string name, string? deviceSecret)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/register", new
		{
			mac = mac,
			name = name,
			ip = GetLocalIp(),
			device_secret = deviceSecret
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<StatusResponse?> GetStatusAsync(string mac, string deviceSecret)
	{
		return await (await _http.GetAsync($"{_baseUrl}/api/rental/status?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}")).Content.ReadFromJsonAsync<StatusResponse>();
	}

	public async Task<ApiResult?> MemberLoginAsync(string mac, string deviceSecret, string username, string password)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/member-login", new
		{
			mac = mac,
			device_secret = deviceSecret,
			username = username,
			password = password
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> MemberLogoutAsync(string mac, string deviceSecret)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/member-logout", new
		{
			mac = mac,
			device_secret = deviceSecret
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> StaffOverrideAsync(string mac, string deviceSecret, string password)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/staff-override", new
		{
			mac = mac,
			device_secret = deviceSecret,
			password = password
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> PauseAsync(string mac, string deviceSecret, string password)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/pause", new
		{
			mac = mac,
			device_secret = deviceSecret,
			password = password
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> ResumeAsync(string mac, string deviceSecret)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/resume", new
		{
			mac = mac,
			device_secret = deviceSecret
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> OpenCoinPendingAsync(string mac, string mode, string? username = null, string? password = null)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/coin/pending", new { mac, mode, username, password })).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<PendingCoinStatus?> GetPendingCoinStatusAsync(string mac)
	{
		return await (await _http.GetAsync(_baseUrl + "/api/coin/pending/" + Uri.EscapeDataString(mac))).Content.ReadFromJsonAsync<PendingCoinStatus>();
	}

	public async Task<ApiResult?> FinalizeCoinsAsync(string mac)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/coin/finalize", new { mac })).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<AppCatalogResponse?> GetAppsAsync(string mac, string deviceSecret)
	{
		return await (await _http.GetAsync($"{_baseUrl}/api/rental/apps?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}")).Content.ReadFromJsonAsync<AppCatalogResponse>();
	}

	public async Task<ApiResult?> RequestHelpAsync(string mac, string deviceSecret)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/help-request", new
		{
			mac = mac,
			device_secret = deviceSecret
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<WhitelistedAppsResponse?> GetWhitelistedAppsAsync(string mac, string deviceSecret)
	{
		return await (await _http.GetAsync($"{_baseUrl}/api/rental/whitelisted-apps?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}")).Content.ReadFromJsonAsync<WhitelistedAppsResponse>();
	}

	public async Task<ApiResult?> GetMemberPointsAsync(string mac, string deviceSecret)
	{
		return await (await _http.GetAsync($"{_baseUrl}/api/rental/member-points?mac={Uri.EscapeDataString(mac)}&device_secret={Uri.EscapeDataString(deviceSecret)}")).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> RedeemAsync(string mac, string deviceSecret, int redeemRateId)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/redeem", new
		{
			mac = mac,
			device_secret = deviceSecret,
			redeem_rate_id = redeemRateId
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	public async Task<ApiResult?> ChangePasswordAsync(string mac, string deviceSecret, string currentPassword, string newPassword)
	{
		return await (await _http.PostAsJsonAsync(_baseUrl + "/api/rental/change-password", new
		{
			mac = mac,
			device_secret = deviceSecret,
			current_password = currentPassword,
			new_password = newPassword
		})).Content.ReadFromJsonAsync<ApiResult>();
	}

	private static string GetLocalIp()
	{
		try
		{
			using Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.IP);
			socket.Connect("8.8.8.8", 65530);
			return (socket.LocalEndPoint as IPEndPoint)?.Address.ToString() ?? "";
		}
		catch
		{
			return "";
		}
	}
}
