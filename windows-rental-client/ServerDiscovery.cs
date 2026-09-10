using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace StarkFiRentalClient;

public static class ServerDiscovery
{
	private class DiscoveryReply
	{
		public string? address { get; set; }

		public int port { get; set; }
	}

	private const int DiscoveryPort = 6970;

	private const string RequestMessage = "STARKFI_DISCOVER_V1";

	public static async Task<string?> TryDiscoverAsync(int timeoutMs = 2000)
	{
		_ = 2;
		try
		{
			using UdpClient socket = new UdpClient();
			socket.EnableBroadcast = true;
			byte[] bytes = Encoding.UTF8.GetBytes("STARKFI_DISCOVER_V1");
			await socket.SendAsync(bytes, bytes.Length, new IPEndPoint(IPAddress.Broadcast, 6970));
			Task<UdpReceiveResult> receiveTask = socket.ReceiveAsync();
			Task task = Task.Delay(timeoutMs);
			if (await Task.WhenAny(receiveTask, task) != receiveTask)
			{
				return null;
			}
			DiscoveryReply discoveryReply = JsonSerializer.Deserialize<DiscoveryReply>((await receiveTask).Buffer);
			if (discoveryReply == null || string.IsNullOrEmpty(discoveryReply.address) || discoveryReply.port <= 0)
			{
				return null;
			}
			return $"http://{discoveryReply.address}:{discoveryReply.port}";
		}
		catch
		{
			return null;
		}
	}
}
