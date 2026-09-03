using Microsoft.Win32;

namespace StarkFiRentalClient;

// Settings > Start on Boot toggle - a real-time equivalent of what
// install.bat already does once at install time via a Startup-folder
// shortcut. Either mechanism achieves the same autorun; this one is
// toggleable from the app itself without re-running the installer.
public static class StartupManager
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "StarkFiRentalClient";

    public static void SetEnabled(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key == null) return;
            if (enabled)
            {
                var exePath = Environment.ProcessPath ?? Application.ExecutablePath;
                key.SetValue(ValueName, $"\"{exePath}\"");
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }
        }
        catch
        {
            // Registry access can fail under a locked-down/restricted
            // account - this is a convenience toggle, not something
            // worth crashing Settings over if it can't apply.
        }
    }

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            return key?.GetValue(ValueName) != null;
        }
        catch
        {
            return false;
        }
    }
}
