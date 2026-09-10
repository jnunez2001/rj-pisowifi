using System;
using System.Diagnostics;
using System.Windows.Forms;

namespace StarkFiRentalClient.UI;

public static class AppLauncher
{
	private static Timer? _watcher;

	public static bool IsProgramRunning { get; private set; }

	public static event Action? ProcessExited;

	public static void Launch(AppCatalogEntry app)
	{
		Process process2;
		try
		{
			Process process = Process.Start(new ProcessStartInfo(app.ExecutablePath)
			{
				UseShellExecute = true
			});
			if (process == null)
			{
				throw new InvalidOperationException("Process.Start returned null");
			}
			process2 = process;
		}
		catch (Exception ex)
		{
			MessageBox.Show($"Could not launch {app.Name}:\n{ex.Message}\n\nCheck the executable path in PC Rental > Café Home.", "Café Home", MessageBoxButtons.OK, MessageBoxIcon.Hand);
			return;
		}
		IsProgramRunning = true;
		_watcher?.Stop();
		_watcher?.Dispose();
		_watcher = new Timer
		{
			Interval = 2000
		};
		_watcher.Tick += delegate
		{
			if (process2.HasExited)
			{
				_watcher.Stop();
				IsProgramRunning = false;
				ProcessExited?.Invoke();
			}
		};
		_watcher.Start();
	}
}
