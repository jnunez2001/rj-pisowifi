using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class AppCatalogEntry
{
	[JsonPropertyName("id")]
	public int Id { get; set; }

	[JsonPropertyName("name")]
	public string Name { get; set; } = "";

	[JsonPropertyName("category_id")]
	public int? CategoryId { get; set; }

	[JsonPropertyName("type")]
	public string Type { get; set; } = "game";

	[JsonPropertyName("executable_path")]
	public string ExecutablePath { get; set; } = "";

	[JsonPropertyName("description")]
	public string? Description { get; set; }

	[JsonPropertyName("featured")]
	public bool Featured { get; set; }

	[JsonPropertyName("display_order")]
	public int DisplayOrder { get; set; }
}
