using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace StarkFiRentalClient;

// Reuses the exact same zero-config protocol server/services/
// vendoDiscoveryService.js already implements for ESP32 Vendos
// ("STARKFI_DISCOVER_V1" broadcast on UDP 6970, JSON reply with
// address+port) rather than inventing a second discovery scheme for
// this client. The server's reply shape was already generic (no
// vendo-specific fields), so no server change was needed to reuse it
// here.
public static class ServerDiscovery
{
    private const int DiscoveryPort = 6970;
    private const string RequestMessage = "STARKFI_DISCOVER_V1";

    private class DiscoveryReply
    {
        public string? address { get; set; }
        public int port { get; set; }
    }

    // Broadcasts once and waits up to `timeoutMs` for a reply. Returns
    // null on timeout/any failure - callers fall back to manual entry,
    // this never throws out to the caller.
    public static async Task<string?> TryDiscoverAsync(int timeoutMs = 2000)
    {
        try
        {
            using var socket = new UdpClient();
            socket.EnableBroadcast = true;
            var requestBytes = Encoding.UTF8.GetBytes(RequestMessage);
            await socket.SendAsync(requestBytes, requestBytes.Length, new IPEndPoint(IPAddress.Broadcast, DiscoveryPort));

            var receiveTask = socket.ReceiveAsync();
            var timeoutTask = Task.Delay(timeoutMs);
            var completed = await Task.WhenAny(receiveTask, timeoutTask);
            if (completed != receiveTask) return null;

            var result = await receiveTask;
            var reply = JsonSerializer.Deserialize<DiscoveryReply>(result.Buffer);
            if (reply == null || string.IsNullOrEmpty(reply.address) || reply.port <= 0) return null;

            return $"http://{reply.address}:{reply.port}";
        }
        catch
        {
            return null;
        }
    }
}
