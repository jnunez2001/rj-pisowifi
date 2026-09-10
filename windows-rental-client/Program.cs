using System;
using System.Windows.Forms;
using StarkFiRentalClient.UI;

namespace StarkFiRentalClient;

public static class Program
{
	private static LockForm _lockForm = null;

	private static CafeHomeForm _cafeHome = null;

	private static bool _lockShowing = true;

	private static bool _wasLocked = true;

	[STAThread]
	public static void Main()
	{
		Application.SetHighDpiMode(HighDpiMode.SystemAware);
		Application.EnableVisualStyles();
		Application.SetCompatibleTextRenderingDefault(defaultValue: false);
		ClientPreferences clientPreferences = ClientPreferences.Load();
		Theme.Apply(clientPreferences.Theme);
		ClientConfig clientConfig = ClientConfig.Load();
		if (clientConfig == null || string.IsNullOrEmpty(clientConfig.ServerUrl))
		{
			string result = ServerDiscovery.TryDiscoverAsync().GetAwaiter().GetResult();
			string label = ((result != null) ? "Found a StarkFi server automatically - press Enter to use it, or type a different address:" : "Server address (e.g. http://192.168.1.10:3000):");
			string text = PromptDialog.Show("StarkFi Rental Setup", label, isPassword: false, result ?? "");
			if (string.IsNullOrWhiteSpace(text))
			{
				MessageBox.Show("A server address is required to continue.", "StarkFi Rental", MessageBoxButtons.OK, MessageBoxIcon.Hand);
				return;
			}
			clientConfig = new ClientConfig
			{
				ServerUrl = text.Trim(),
				Mac = ClientConfig.GetMacAddress()
			};
		}
		RentalApiClient rentalApiClient = new RentalApiClient(clientConfig.ServerUrl);
		try
		{
			ApiResult result2 = rentalApiClient.RegisterAsync(clientConfig.Mac, Environment.MachineName, string.IsNullOrEmpty(clientConfig.DeviceSecret) ? null : clientConfig.DeviceSecret).GetAwaiter().GetResult();
			if (result2 != null && result2.Success && !string.IsNullOrEmpty(result2.DeviceSecret))
			{
				clientConfig.DeviceSecret = result2.DeviceSecret;
				if (result2.PcId > 0)
				{
					clientConfig.PcId = result2.PcId;
				}
				clientConfig.Save();
			}
		}
		catch (Exception ex)
		{
			MessageBox.Show($"Could not reach the StarkFi server at {clientConfig.ServerUrl}:\n{ex.Message}\n\nWill keep retrying in the background.", "StarkFi Rental", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
		}
		_lockForm = new LockForm(rentalApiClient, clientConfig);
		_cafeHome = new CafeHomeForm(rentalApiClient, clientConfig, clientPreferences);
		StartupManager.SetEnabled(clientPreferences.StartOnBoot);
		StatusPoller statusPoller = new StatusPoller(rentalApiClient, clientConfig);
		statusPoller.StatusUpdated += delegate(StatusResponse status)
		{
			if (_lockForm.IsHandleCreated)
			{
				_lockForm.BeginInvoke(delegate
				{
					HandleStatus(status);
				});
			}
		};
		statusPoller.ConnectionLost += delegate
		{
			if (_lockForm.IsHandleCreated)
			{
				_lockForm.BeginInvoke(delegate
				{
					ShowLockDefensively();
				});
			}
		};
		statusPoller.Start();
		Application.Run(_lockForm);
	}

	private static void HandleStatus(StatusResponse status)
	{
		_lockForm.SetConnected(connected: true);
		if (status.Paused)
		{
			_lockShowing = false;
			_wasLocked = false;
			_lockForm.HideLock();
			_cafeHome.HideHome();
			_lockForm.ShowLock(new StatusResponse
			{
				Locked = true,
				PcName = status.PcName,
				LockAnnouncement = "Paused by staff - please wait.",
				WallpaperUrl = status.WallpaperUrl,
				LogoUrl = status.LogoUrl,
				InstructionsText = status.InstructionsText
			});
		}
		else if (status.Locked)
		{
			if (!_wasLocked)
			{
				_wasLocked = true;
				_cafeHome.CleanUpOnExitIfEnabledAsync();
			}
			_cafeHome.HideHome();
			if (!_lockShowing)
			{
				_lockShowing = true;
			}
			_lockForm.ShowLock(status);
		}
		else
		{
			_lockShowing = false;
			_wasLocked = false;
			_lockForm.HideLock();
			_cafeHome.UpdateFromStatus(status);
			_cafeHome.ShowHome();
		}
	}

	private static void ShowLockDefensively()
	{
		_lockForm.SetConnected(connected: false);
		if (!_lockShowing)
		{
			_lockShowing = true;
			_cafeHome.HideHome();
			_lockForm.Show();
		}
	}
}
