using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class AppCatalogResponse
{
	[JsonPropertyName("success")]
	public bool Success { get; set; }

	[JsonPropertyName("categories")]
	public List<AppCategory> Categories { get; set; } = new List<AppCategory>();

	[JsonPropertyName("apps")]
	public List<AppCatalogEntry> Apps { get; set; } = new List<AppCatalogEntry>();
}
