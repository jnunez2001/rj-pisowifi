namespace StarkFiRentalClient;

// Tiny global read of the same connected/disconnected signal StatusPoller
// already computes (successful poll vs. ConnectionLost below) - exposed
// here so a screen with no poller reference of its own (the Admin Panel's
// Server Connection section) can show a live indicator without building a
// second, competing connectivity check. Program.cs is the only writer
// (see HandleStatus/ShowLockDefensively), matching where this state was
// already being tracked (LockForm.SetConnected) before this existed.
public static class ConnectionStatus
{
    public static bool IsConnected { get; private set; } = true;
    public static event Action<bool>? Changed;

    public static void Set(bool connected)
    {
        if (IsConnected == connected) return;
        IsConnected = connected;
        Changed?.Invoke(connected);
    }
}

public class StatusPoller
{
    private const int PollIntervalMs = 5000;
    private const int MaxConsecutiveFailures = 3; // ~15s, matches the design notes' default

    private readonly RentalApiClient _api;
    private readonly ClientConfig _config;
    private System.Threading.Timer? _timer;
    private int _consecutiveFailures;

    public event Action<StatusResponse>? StatusUpdated;
    // Fired only on the defensive "we lost contact, lock now, don't trust
    // a stale unlocked answer" path - distinct from a real server-
    // reported locked status.
    public event Action? ConnectionLost;

    public StatusPoller(RentalApiClient api, ClientConfig config)
    {
        _api = api;
        _config = config;
    }

    public void Start()
    {
        _timer = new System.Threading.Timer(async _ => await PollOnce(), null, 0, PollIntervalMs);
    }

    public void Stop() => _timer?.Dispose();

    private async Task PollOnce()
    {
        try
        {
            var status = await _api.GetStatusAsync(_config.Mac, _config.DeviceSecret);
            if (status == null || !status.Success)
            {
                RecordFailure();
                return;
            }
            _consecutiveFailures = 0;
            StatusUpdated?.Invoke(status);
        }
        catch
        {
            RecordFailure();
        }
    }

    private void RecordFailure()
    {
        _consecutiveFailures++;
        if (_consecutiveFailures >= MaxConsecutiveFailures)
        {
            ConnectionLost?.Invoke();
        }
    }
}
