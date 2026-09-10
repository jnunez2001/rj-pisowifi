using System;
using System.Threading;
using System.Threading.Tasks;

namespace StarkFiRentalClient;

public class StatusPoller
{
	private const int PollIntervalMs = 5000;

	private const int MaxConsecutiveFailures = 3;

	private readonly RentalApiClient _api;

	private readonly ClientConfig _config;

	private Timer? _timer;

	private int _consecutiveFailures;

	public event Action<StatusResponse>? StatusUpdated;

	public event Action? ConnectionLost;

	public StatusPoller(RentalApiClient api, ClientConfig config)
	{
		_api = api;
		_config = config;
	}

	public void Start()
	{
		_timer = new Timer(async delegate
		{
			await PollOnce();
		}, null, 0, 5000);
	}

	public void Stop()
	{
		_timer?.Dispose();
	}

	private async Task PollOnce()
	{
		try
		{
			StatusResponse statusResponse = await _api.GetStatusAsync(_config.Mac, _config.DeviceSecret);
			if (statusResponse == null || !statusResponse.Success)
			{
				RecordFailure();
				return;
			}
			_consecutiveFailures = 0;
			StatusUpdated?.Invoke(statusResponse);
		}
		catch
		{
			RecordFailure();
		}
	}

	private void RecordFailure()
	{
		_consecutiveFailures++;
		if (_consecutiveFailures >= 3)
		{
			ConnectionLost?.Invoke();
		}
	}
}
