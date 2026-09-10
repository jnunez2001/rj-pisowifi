using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace StarkFiRentalClient;

public class IdleDetector
{
	private struct LASTINPUTINFO
	{
		public uint cbSize;

		public uint dwTime;
	}

	private readonly Timer _timer;

	private int _idleMinutesThreshold = 15;

	public event Action? IdleTimeoutReached;

	[DllImport("user32.dll")]
	private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

	public IdleDetector()
	{
		_timer = new Timer
		{
			Interval = 15000
		};
		_timer.Tick += delegate
		{
			CheckIdle();
		};
	}

	public void Start(int idleMinutesThreshold)
	{
		_idleMinutesThreshold = Math.Max(1, idleMinutesThreshold);
		_timer.Start();
	}

	public void Stop()
	{
		_timer.Stop();
	}

	private void CheckIdle()
	{
		if (GetIdleMilliseconds() >= _idleMinutesThreshold * 60000)
		{
			_timer.Stop();
			IdleTimeoutReached?.Invoke();
		}
	}

	private static long GetIdleMilliseconds()
	{
		LASTINPUTINFO plii = default(LASTINPUTINFO);
		plii.cbSize = (uint)Marshal.SizeOf(plii);
		if (!GetLastInputInfo(ref plii))
		{
			return 0L;
		}
		return Environment.TickCount - plii.dwTime;
	}
}
