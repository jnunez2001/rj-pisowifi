using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class RedeemRate
{
	[JsonPropertyName("id")]
	public int Id { get; set; }

	[JsonPropertyName("points")]
	public int Points { get; set; }

	[JsonPropertyName("reward_seconds")]
	public int RewardSeconds { get; set; }
}
