using System.Runtime.InteropServices;

namespace StarkFiRentalClient;

// Low-level keyboard hook blocking the common desktop-escape combos while
// the lock screen is showing: Alt+Tab, the Windows key, and Ctrl+Esc
// (Start menu). This is the genuinely novel systems-level piece flagged
// in the plan as most likely to need iteration once tested on real
// hardware.
//
// Honest limitation: Ctrl+Alt+Del is Windows' own Secure Attention
// Sequence (SAS) - by design, NO user-mode application, hook, or driver
// can intercept or block it (this is intentional OS security, not a gap
// in this implementation). A customer pressing it will still reach the
// real Windows security screen (Task Manager, Sign out, etc), and from
// there could potentially get around the lock. Fully preventing that
// needs either the "custom Shell" registry replacement (documented in
// README.md - makes explorer.exe itself not the shell, which changes
// what Ctrl+Alt+Del's options even lead to) or a Group Policy /
// Software Restriction Policy on the machine - neither of those are
// things this app can silently apply on your behalf, they're
// deliberate, documented setup steps for the operator.
public class KeyboardBlocker : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;

    private const int VK_TAB = 0x09;
    private const int VK_ESCAPE = 0x1B;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private IntPtr _hookId = IntPtr.Zero;
    private readonly LowLevelKeyboardProc _proc;

    public KeyboardBlocker()
    {
        _proc = HookCallback;
    }

    public void Install()
    {
        using var curProcess = System.Diagnostics.Process.GetCurrentProcess();
        using var curModule = curProcess.MainModule!;
        _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(curModule.ModuleName!), 0);
    }

    public void Uninstall()
    {
        if (_hookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hookId);
            _hookId = IntPtr.Zero;
        }
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN))
        {
            var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var altPressed = (GetAsyncKeyState(0x12) & 0x8000) != 0; // VK_MENU

            bool block =
                (altPressed && data.vkCode == VK_TAB) ||
                data.vkCode == VK_LWIN || data.vkCode == VK_RWIN ||
                ((GetAsyncKeyState(0x11) & 0x8000) != 0 && data.vkCode == VK_ESCAPE); // Ctrl+Esc

            if (block) return (IntPtr)1; // non-zero = swallow the key
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    public void Dispose() => Uninstall();
}
