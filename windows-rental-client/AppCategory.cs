using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class AppCategory
{
	[JsonPropertyName("id")]
	public int Id { get; set; }

	[JsonPropertyName("name")]
	public string Name { get; set; } = "";

	[JsonPropertyName("display_order")]
	public int DisplayOrder { get; set; }
}
