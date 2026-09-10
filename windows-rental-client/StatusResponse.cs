using System.Text.Json.Serialization;

namespace StarkFiRentalClient;

public class StatusResponse
{
	[JsonPropertyName("success")]
	public bool Success { get; set; }

	[JsonPropertyName("locked")]
	public bool Locked { get; set; }

	[JsonPropertyName("paused")]
	public bool Paused { get; set; }

	[JsonPropertyName("pc_name")]
	public string PcName { get; set; } = "";

	[JsonPropertyName("minutes_remaining")]
	public double MinutesRemaining { get; set; }

	[JsonPropertyName("adopted")]
	public bool Adopted { get; set; }

	[JsonPropertyName("logged_in_user")]
	public string? LoggedInUser { get; set; }

	[JsonPropertyName("message")]
	public string? Message { get; set; }

	[JsonPropertyName("logo_url")]
	public string? LogoUrl { get; set; }

	[JsonPropertyName("wallpaper_url")]
	public string? WallpaperUrl { get; set; }

	[JsonPropertyName("lock_announcement")]
	public string? LockAnnouncement { get; set; }

	[JsonPropertyName("instructions_text")]
	public string? InstructionsText { get; set; }

	[JsonPropertyName("logged_in_points")]
	public int? LoggedInPoints { get; set; }
}
