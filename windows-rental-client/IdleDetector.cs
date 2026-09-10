using System.Runtime.InteropServices;

namespace StarkFiRentalClient;

// Settings > Auto Logout - real idle detection via the standard
// GetLastInputInfo Win32 API (P/Invoke, same interop pattern
// KeyboardBlocker.cs already establishes for user32.dll). Only fires
// while a member is logged in (Start/Stop are called from Program.cs's
// HandleStatus) - there's no session to "auto logout" for a guest.
public class IdleDetector
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    private readonly System.Windows.Forms.Timer _timer;
    private int _idleMinutesThreshold = 15;

    public event Action? IdleTimeoutReached;

    public IdleDetector()
    {
        _timer = new System.Windows.Forms.Timer { Interval = 15000 }; // check every 15s, minute-level threshold doesn't need finer
        _timer.Tick += (_, _) => CheckIdle();
    }

    public void Start(int idleMinutesThreshold)
    {
        _idleMinutesThreshold = Math.Max(1, idleMinutesThreshold);
        _timer.Start();
    }

    public void Stop() => _timer.Stop();

    private void CheckIdle()
    {
        var idleMs = GetIdleMilliseconds();
        if (idleMs >= _idleMinutesThreshold * 60_000)
        {
            _timer.Stop(); // caller restarts via Start() on the next member login
            IdleTimeoutReached?.Invoke();
        }
    }

    private static long GetIdleMilliseconds()
    {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return 0;
        return Environment.TickCount - info.dwTime;
    }
}
