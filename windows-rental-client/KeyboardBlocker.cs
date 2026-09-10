using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace StarkFiRentalClient;

public class KeyboardBlocker : IDisposable
{
	private struct KBDLLHOOKSTRUCT
	{
		public int vkCode;

		public int scanCode;

		public int flags;

		public int time;

		public nint dwExtraInfo;
	}

	private delegate nint LowLevelKeyboardProc(int nCode, nint wParam, nint lParam);

	private const int WH_KEYBOARD_LL = 13;

	private const int WM_KEYDOWN = 256;

	private const int WM_SYSKEYDOWN = 260;

	private const int VK_TAB = 9;

	private const int VK_ESCAPE = 27;

	private const int VK_LWIN = 91;

	private const int VK_RWIN = 92;

	private nint _hookId = IntPtr.Zero;

	private readonly LowLevelKeyboardProc _proc;

	[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
	private static extern nint SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, nint hMod, uint dwThreadId);

	[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
	private static extern bool UnhookWindowsHookEx(nint hhk);

	[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
	private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

	[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
	private static extern nint GetModuleHandle(string lpModuleName);

	[DllImport("user32.dll")]
	private static extern short GetAsyncKeyState(int vKey);

	public KeyboardBlocker()
	{
		_proc = HookCallback;
	}

	public void Install()
	{
		using Process process = Process.GetCurrentProcess();
		using ProcessModule processModule = process.MainModule;
		_hookId = SetWindowsHookEx(13, _proc, GetModuleHandle(processModule.ModuleName), 0u);
	}

	public void Uninstall()
	{
		if (_hookId != IntPtr.Zero)
		{
			UnhookWindowsHookEx(_hookId);
			_hookId = IntPtr.Zero;
		}
	}

	private nint HookCallback(int nCode, nint wParam, nint lParam)
	{
		if (nCode >= 0 && (wParam == 256 || wParam == 260))
		{
			KBDLLHOOKSTRUCT kBDLLHOOKSTRUCT = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
			if (((GetAsyncKeyState(18) & 0x8000) != 0 && kBDLLHOOKSTRUCT.vkCode == 9) || kBDLLHOOKSTRUCT.vkCode == 91 || kBDLLHOOKSTRUCT.vkCode == 92 || ((GetAsyncKeyState(17) & 0x8000) != 0 && kBDLLHOOKSTRUCT.vkCode == 27))
			{
				return 1;
			}
		}
		return CallNextHookEx(_hookId, nCode, wParam, lParam);
	}

	public void Dispose()
	{
		Uninstall();
	}
}
