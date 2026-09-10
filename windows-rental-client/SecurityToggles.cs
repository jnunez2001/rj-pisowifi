using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32;

namespace StarkFiRentalClient;

// Genuinely security-sensitive OS-level toggles for the Admin Panel's
// Security section. Each of the three toggles talks to a real, standard
// Windows mechanism - never a fake/inert preference - and every write is
// wrapped in try/catch so a failure (most commonly: the app isn't running
// elevated) surfaces a clear message to the operator instead of crashing
// the panel or silently no-op'ing.
public static class SecurityToggles
{
    public static bool IsElevated()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    // --- Task Manager -------------------------------------------------
    // Exact same HKCU value install.bat already sets by hand
    // (`reg add ... DisableTaskMgr /t REG_DWORD /d 1`). A per-user HKCU
    // key, so this does not require elevation.
    private const string PoliciesSystemKey = @"Software\Microsoft\Windows\CurrentVersion\Policies\System";
    private const string DisableTaskMgrValue = "DisableTaskMgr";

    public static bool IsTaskManagerDisabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(PoliciesSystemKey, writable: false);
            return key?.GetValue(DisableTaskMgrValue) is int i && i == 1;
        }
        catch
        {
            return false;
        }
    }

    public static (bool Ok, string? Error) SetTaskManagerDisabled(bool disabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(PoliciesSystemKey, writable: true);
            if (key == null) return (false, "Could not open the registry key for this setting.");
            if (disabled) key.SetValue(DisableTaskMgrValue, 1, RegistryValueKind.DWord);
            else key.DeleteValue(DisableTaskMgrValue, throwOnMissingValue: false);
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, $"Could not change the Task Manager lock: {ex.Message}");
        }
    }

    // --- USB mass storage ----------------------------------------------
    // The well-established, standard, reversible Windows mechanism: the
    // USBSTOR driver's own Start value. 4 = disabled, 3 = enabled. This
    // ONLY affects USB mass storage (flash drives) - it never touches the
    // USB bus itself, so keyboard/mouse/coin-acceptor HID devices keep
    // working either way. HKLM, so this requires the process to be
    // elevated.
    private const string UsbStorKey = @"SYSTEM\CurrentControlSet\Services\USBSTOR";
    private const string UsbStorStartValue = "Start";
    private const int UsbStorDisabledStart = 4;
    private const int UsbStorEnabledStart = 3;

    // null = current state could not be determined (key/value missing or
    // unreadable) - callers should treat this as "unknown", not "off".
    public static bool? IsUsbStorageDisabled()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(UsbStorKey, writable: false);
            if (key?.GetValue(UsbStorStartValue) is not int i) return null;
            return i == UsbStorDisabledStart;
        }
        catch
        {
            return null;
        }
    }

    public static (bool Ok, string? Error) SetUsbStorageDisabled(bool disabled)
    {
        if (!IsElevated()) return (false, "This toggle requires the app to be running as Administrator.");
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(UsbStorKey, writable: true);
            if (key == null) return (false, "Could not open the USB storage service key.");
            key.SetValue(UsbStorStartValue, disabled ? UsbStorDisabledStart : UsbStorEnabledStart, RegistryValueKind.DWord);
            return (true, null);
        }
        catch (UnauthorizedAccessException)
        {
            return (false, "This toggle requires the app to be running as Administrator.");
        }
        catch (Exception ex)
        {
            return (false, $"Could not change the USB storage setting: {ex.Message}");
        }
    }

    // --- Protect install folder -----------------------------------------
    // A conservative deny-write-only NTFS ACL rule for the standard
    // "Users" (BuiltinUsersSid) group on the install folder. Denies only
    // WriteData/Delete/DeleteSubdirectoriesAndFiles - Read/ReadAndExecute
    // are never touched, so the running app (and anything else reading its
    // files) keeps working normally either way. Modifying ACLs under
    // Program Files requires elevation.
    private static readonly FileSystemRights ProtectDenyRights =
        FileSystemRights.WriteData | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles;

    public static string GetInstallFolder()
    {
        try
        {
            var exePath = Environment.ProcessPath ?? Application.ExecutablePath;
            return Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory;
        }
        catch
        {
            return AppContext.BaseDirectory;
        }
    }

    // null = current state could not be determined (folder missing, ACL
    // unreadable) - callers should treat this as "unknown", not "off".
    public static bool? IsInstallFolderProtected(string folder)
    {
        try
        {
            if (!Directory.Exists(folder)) return null;
            var info = new DirectoryInfo(folder);
            var security = info.GetAccessControl(AccessControlSections.Access);
            var usersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType == AccessControlType.Deny &&
                    rule.IdentityReference is SecurityIdentifier sid && sid == usersSid &&
                    (rule.FileSystemRights & FileSystemRights.WriteData) == FileSystemRights.WriteData)
                {
                    return true;
                }
            }
            return false;
        }
        catch
        {
            return null;
        }
    }

    public static (bool Ok, string? Error) SetInstallFolderProtected(string folder, bool protect)
    {
        if (!IsElevated()) return (false, "This toggle requires the app to be running as Administrator.");
        try
        {
            if (!Directory.Exists(folder)) return (false, $"Install folder not found: {folder}");
            var info = new DirectoryInfo(folder);
            var security = info.GetAccessControl(AccessControlSections.Access);
            var usersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            var rule = new FileSystemAccessRule(
                usersSid, ProtectDenyRights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None,
                AccessControlType.Deny);
            if (protect) security.AddAccessRule(rule);
            else security.RemoveAccessRule(rule);
            info.SetAccessControl(security);
            return (true, null);
        }
        catch (UnauthorizedAccessException)
        {
            return (false, "This toggle requires the app to be running as Administrator.");
        }
        catch (Exception ex)
        {
            return (false, $"Could not change folder protection: {ex.Message}");
        }
    }
}
