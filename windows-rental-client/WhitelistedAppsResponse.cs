using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class WhitelistedAppsResponse
{
	[JsonPropertyName("success")]
	public bool Success { get; set; }

	[JsonPropertyName("apps")]
	public List<string> Apps { get; set; } = new List<string>();
}
