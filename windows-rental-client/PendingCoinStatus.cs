using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class PendingCoinStatus
{
	[JsonPropertyName("success")]
	public bool Success { get; set; }

	[JsonPropertyName("pending")]
	public bool Pending { get; set; }

	[JsonPropertyName("total")]
	public int Total { get; set; }
}
