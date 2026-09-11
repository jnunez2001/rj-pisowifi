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
    // Goal: the physically-present kiosk customer (an unprivileged, standard
    // interactive user) must not be able to delete or overwrite the app's
    // files, while the operator (an elevated Administrator) and the OS
    // itself keep full access - so install.bat's upgrade `copy /Y` and
    // uninstall.bat's `rmdir /S /Q` still work when run as administrator.
    //
    // This is done with ALLOW ACEs only - never a Deny ACE. A Deny ACE is
    // the wrong tool here: the obvious "Deny write to BUILTIN\Users" also
    // hits the operator, because an elevated administrator's token still
    // carries the Users SID. Pairing that Deny with an explicit
    // Allow-FullControl for Administrators does NOT rescue it either:
    // Windows/.NET canonicalize a DACL on write by ordering explicit Deny
    // ACEs ahead of explicit Allow ACEs, so the Deny is evaluated first for
    // the admin's token and the later Allow is never reached for those
    // bits. Access checks stop at the first matching ACE, and no ordering
    // trick changes that while the two ACEs' trustees overlap.
    //
    // So instead of denying anybody, protection works by REMOVING the
    // write/delete grants that the unprivileged groups have:
    //   1. Inheritance is broken with the inherited rules copied down as
    //      explicit rules (nothing legitimate is lost).
    //   2. Every explicit Allow rule for Users / Everyone / Authenticated
    //      Users has just its write/delete bits stripped - Read, Execute,
    //      ListDirectory and Traverse are preserved, so the app still runs
    //      and the customer can still read/launch it.
    //   3. Explicit Allow(FullControl) is ensured for Administrators and
    //      LocalSystem. With no competing Deny ACE in the DACL, this simply
    //      works - the operator and the OS always retain full access.
    // The pre-protection DACL is snapshotted to ProgramData first so that
    // turning the toggle back off restores the real original ACL rather
    // than a guessed approximation.
    //
    // Modifying ACLs under Program Files requires elevation.

    // The bits stripped from unprivileged groups: everything that could
    // modify, replace, create, delete or re-permission the folder and its
    // contents. Read/Execute/List/Traverse/ReadPermissions are deliberately
    // not in this set.
    private static readonly FileSystemRights ProtectStrippedRights =
        FileSystemRights.WriteData                  // == CreateFiles
        | FileSystemRights.AppendData               // == CreateDirectories
        | FileSystemRights.WriteAttributes
        | FileSystemRights.WriteExtendedAttributes
        | FileSystemRights.Delete
        | FileSystemRights.DeleteSubdirectoriesAndFiles
        | FileSystemRights.ChangePermissions
        | FileSystemRights.TakeOwnership;

    private const InheritanceFlags ProtectInheritanceFlags = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    private const PropagationFlags ProtectPropagationFlags = PropagationFlags.None;

    private static SecurityIdentifier UsersSid => new(WellKnownSidType.BuiltinUsersSid, null);
    private static SecurityIdentifier EveryoneSid => new(WellKnownSidType.WorldSid, null);
    private static SecurityIdentifier AuthenticatedUsersSid => new(WellKnownSidType.AuthenticatedUserSid, null);
    private static SecurityIdentifier AdministratorsSid => new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static SecurityIdentifier LocalSystemSid => new(WellKnownSidType.LocalSystemSid, null);

    private static bool IsUnprivilegedTrustee(IdentityReference identity) =>
        identity is SecurityIdentifier sid &&
        (sid == UsersSid || sid == EveryoneSid || sid == AuthenticatedUsersSid);

    // Snapshot of the folder's DACL as it was immediately before protection
    // was first turned on, so turning it off restores exactly that.
    private static readonly string AclBackupFile =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental", "install_folder_acl.sddl");

    // %ProgramData%\StarkFiRental\install_path.txt is the authoritative
    // install location, written by install.bat and read back by
    // uninstall.bat - this mirrors that so the folder this toggle protects
    // is always the real install folder, not wherever the running exe
    // happens to be launched from (a dev build launched straight out of
    // bin\Debug, for instance).
    private static readonly string InstallMarkerFile =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "StarkFiRental", "install_path.txt");

    public static string GetInstallFolder()
    {
        try
        {
            if (File.Exists(InstallMarkerFile))
            {
                var marked = File.ReadAllText(InstallMarkerFile).Trim();
                if (!string.IsNullOrWhiteSpace(marked) && Directory.Exists(marked)) return marked;
            }
        }
        catch
        {
            // fall through to the exe-directory fallback below
        }

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
            var security = new DirectoryInfo(folder).GetAccessControl(AccessControlSections.Access);

            // Protection is "on" when both halves of the mechanism hold:
            // inheritance is broken (so a parent folder can't hand the
            // write back), and no rule of any kind still grants a
            // write/delete bit to an unprivileged group.
            if (!security.AreAccessRulesProtected) return false;

            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                if (!IsUnprivilegedTrustee(rule.IdentityReference)) continue;
                if ((rule.FileSystemRights & ProtectStrippedRights) != 0) return false;
            }
            return true;
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
            if (protect) ApplyInstallFolderProtection(info);
            else RemoveInstallFolderProtection(info);
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

    private static void ApplyInstallFolderProtection(DirectoryInfo info)
    {
        var original = info.GetAccessControl(AccessControlSections.Access);
        SaveAclBackup(original);

        // Step 1: break inheritance, copying the currently inherited rules
        // down as explicit rules so nothing legitimate (SYSTEM, TrustedInstaller,
        // a service account, whatever the parent granted) is lost. Written
        // out on its own so step 2 works from the real, freshly re-read
        // on-disk DACL rather than from an in-memory prediction of it.
        if (!original.AreAccessRulesProtected)
        {
            original.SetAccessRuleProtection(isProtected: true, preserveInheritance: true);
            info.SetAccessControl(original);
        }

        // Step 2: strip the write/delete bits from every explicit Allow rule
        // held by an unprivileged group, keeping their read/execute bits.
        var security = info.GetAccessControl(AccessControlSections.Access);
        var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToList();

        foreach (var rule in rules)
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            if (!IsUnprivilegedTrustee(rule.IdentityReference)) continue;
            if ((rule.FileSystemRights & ProtectStrippedRights) == 0) continue;

            // RemoveAccessRuleSpecific matches on the exact identity, rights,
            // flags and type - and this rule object came straight out of the
            // DACL, so it always matches exactly that one ACE and nothing else.
            security.RemoveAccessRuleSpecific(rule);

            var remaining = rule.FileSystemRights & ~ProtectStrippedRights;
            if (remaining != 0)
            {
                security.AddAccessRule(new FileSystemAccessRule(
                    rule.IdentityReference, remaining,
                    rule.InheritanceFlags, rule.PropagationFlags,
                    AccessControlType.Allow));
            }
        }

        // Step 3: guarantee the operator and the OS keep full access. Pure
        // Allow rules, no Deny anywhere in this DACL, so there is nothing
        // for them to be shadowed by.
        security.AddAccessRule(new FileSystemAccessRule(
            AdministratorsSid, FileSystemRights.FullControl,
            ProtectInheritanceFlags, ProtectPropagationFlags, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(
            LocalSystemSid, FileSystemRights.FullControl,
            ProtectInheritanceFlags, ProtectPropagationFlags, AccessControlType.Allow));

        info.SetAccessControl(security);
    }

    private static void RemoveInstallFolderProtection(DirectoryInfo info)
    {
        // Preferred path: put back the exact DACL that was in place before
        // protection was turned on. Re-enabling inheritance on its own is
        // not enough - the explicit copies made when inheritance was broken
        // stay behind as explicit rules, so a stripped Users rule would keep
        // sitting there next to the restored inherited one.
        if (TryRestoreAclBackup(info)) return;

        // Fallback for when the snapshot is missing (protection turned on by
        // an older build, ProgramData wiped, and so on): re-enable
        // inheritance, then remove only the explicit rules this feature is
        // known to create, letting the parent's inherited rules take over
        // again. Deliberately does not touch explicit rules it did not write.
        var security = info.GetAccessControl(AccessControlSections.Access);
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);
        info.SetAccessControl(security);

        security = info.GetAccessControl(AccessControlSections.Access);
        var changed = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;

            var isStrippedUnprivilegedCopy =
                IsUnprivilegedTrustee(rule.IdentityReference) &&
                (rule.FileSystemRights & ProtectStrippedRights) == 0;

            var isOurFullControlGrant =
                rule.IdentityReference is SecurityIdentifier sid &&
                (sid == AdministratorsSid || sid == LocalSystemSid) &&
                rule.FileSystemRights == FileSystemRights.FullControl &&
                rule.InheritanceFlags == ProtectInheritanceFlags &&
                rule.PropagationFlags == ProtectPropagationFlags;

            if (!isStrippedUnprivilegedCopy && !isOurFullControlGrant) continue;

            security.RemoveAccessRuleSpecific(rule);
            changed = true;
        }
        if (changed) info.SetAccessControl(security);
    }

    private static void SaveAclBackup(DirectorySecurity original)
    {
        try
        {
            // Never overwrite an existing snapshot - protection may be
            // re-applied over itself, and the first snapshot is the only one
            // that reflects the genuine pre-protection state.
            if (File.Exists(AclBackupFile)) return;
            var dir = Path.GetDirectoryName(AclBackupFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(AclBackupFile, original.GetSecurityDescriptorSddlForm(AccessControlSections.Access));
        }
        catch
        {
            // A missing snapshot only costs us the exact-restore path on
            // toggle-off (the fallback above still works), so this must never
            // block protection itself from being applied.
        }
    }

    private static bool TryRestoreAclBackup(DirectoryInfo info)
    {
        try
        {
            if (!File.Exists(AclBackupFile)) return false;
            var sddl = File.ReadAllText(AclBackupFile).Trim();
            if (string.IsNullOrWhiteSpace(sddl)) return false;

            var restored = new DirectorySecurity();
            restored.SetSecurityDescriptorSddlForm(sddl, AccessControlSections.Access);
            info.SetAccessControl(restored);

            try { File.Delete(AclBackupFile); } catch { /* stale snapshot is harmless */ }
            return true;
        }
        catch
        {
            return false;
        }
    }
}
