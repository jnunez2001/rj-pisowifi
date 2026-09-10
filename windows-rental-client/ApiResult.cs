using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class ApiResult
{
	[JsonPropertyName("success")]
	public bool Success { get; set; }

	[JsonPropertyName("message")]
	public string? Message { get; set; }

	[JsonPropertyName("minutes_remaining")]
	public double MinutesRemaining { get; set; }

	[JsonPropertyName("pc_id")]
	public int PcId { get; set; }

	[JsonPropertyName("device_secret")]
	public string? DeviceSecret { get; set; }

	[JsonPropertyName("reason")]
	public string? Reason { get; set; }

	[JsonPropertyName("needed")]
	public int Needed { get; set; }

	[JsonPropertyName("total")]
	public int Total { get; set; }

	[JsonPropertyName("account_created")]
	public bool AccountCreated { get; set; }

	[JsonPropertyName("username")]
	public string? Username { get; set; }

	[JsonPropertyName("seconds")]
	public int Seconds { get; set; }

	[JsonPropertyName("points")]
	public int Points { get; set; }

	[JsonPropertyName("redeem_rates")]
	public List<RedeemRate>? RedeemRates { get; set; }

	[JsonPropertyName("remaining_points")]
	public int RemainingPoints { get; set; }

	[JsonPropertyName("seconds_added")]
	public int SecondsAdded { get; set; }
}
