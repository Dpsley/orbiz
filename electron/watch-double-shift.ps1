$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$interval = 450
$parsedInterval = 0
if ([int]::TryParse($env:CODEX_SCREEN_DOUBLE_SHIFT_MS, [ref]$parsedInterval)) {
  $interval = [Math]::Max(200, [Math]::Min(1500, $parsedInterval))
}

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class DoubleShiftWatcher
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int VK_CONTROL = 0x11;
    private const int VK_SHIFT = 0x10;
    private const int VK_MENU = 0x12;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_LSHIFT = 0xA0;
    private const int VK_RSHIFT = 0xA1;
    private const int VK_LMENU = 0xA4;
    private const int VK_RMENU = 0xA5;

    private static LowLevelKeyboardProc proc = HookCallback;
    private static IntPtr hookId = IntPtr.Zero;
    private static bool shiftDown = false;
    private static bool ctrlAltActive = false;
    private static bool ctrlShiftActive = false;
    private static long ctrlAltLastEmitAt = 0;
    private static long ctrlShiftLastEmitAt = 0;
    private static long lastShiftAt = 0;
    private static int intervalMs = 450;
    private static int scrollRepeatMs = 220;

    public static void Run(int interval)
    {
        intervalMs = interval;
        hookId = SetHook(proc);

        if (hookId == IntPtr.Zero)
        {
            Console.Error.WriteLine("hook-failed:" + Marshal.GetLastWin32Error());
            Environment.Exit(1);
        }

        Thread pollThread = new Thread(PollScrollChords);
        pollThread.IsBackground = true;
        pollThread.Start();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0))
        {
        }

        UnhookWindowsHookEx(hookId);
    }

    private static IntPtr SetHook(LowLevelKeyboardProc callback)
    {
        using (Process currentProcess = Process.GetCurrentProcess())
        using (ProcessModule currentModule = currentProcess.MainModule)
        {
            return SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(currentModule.ModuleName), 0);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            int vkCode = Marshal.ReadInt32(lParam);
            bool isCtrl = vkCode == VK_CONTROL || vkCode == VK_LCONTROL || vkCode == VK_RCONTROL;
            bool isShift = vkCode == VK_SHIFT || vkCode == VK_LSHIFT || vkCode == VK_RSHIFT;
            bool isAlt = vkCode == VK_MENU || vkCode == VK_LMENU || vkCode == VK_RMENU;
            bool isKeyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool isKeyUp = message == WM_KEYUP || message == WM_SYSKEYUP;

            if (isKeyDown)
            {
                if (isCtrl)
                {
                }
                else if (isAlt)
                {
                }
                else if (isShift)
                {
                    if (!shiftDown)
                    {
                        if (!IsAnyCtrlDown() && !IsAnyAltDown())
                        {
                            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                            if (lastShiftAt > 0 && now - lastShiftAt <= intervalMs)
                            {
                                Emit("shift-shift");
                                lastShiftAt = 0;
                            }
                            else
                            {
                                lastShiftAt = now;
                            }
                        }

                        shiftDown = true;
                    }
                }

                UpdateScrollChords();
            }
            else if (isKeyUp)
            {
                if (isCtrl)
                {
                }
                else if (isAlt)
                {
                }
                else if (isShift)
                {
                    shiftDown = false;
                }

                UpdateScrollChords();
            }
        }

        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    private static void UpdateScrollChords()
    {
        bool actualCtrlDown = IsAnyCtrlDown();
        bool actualShiftDown = IsAnyShiftDown();
        bool actualAltDown = IsAnyAltDown();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (actualCtrlDown && actualAltDown)
        {
            if (!ctrlAltActive || now - ctrlAltLastEmitAt >= scrollRepeatMs)
            {
                Emit("overlay-scroll-down");
                ctrlAltActive = true;
                ctrlAltLastEmitAt = now;
            }
        }
        else
        {
            ctrlAltActive = false;
            ctrlAltLastEmitAt = 0;
        }

        if (actualCtrlDown && actualShiftDown)
        {
            if (!ctrlShiftActive || now - ctrlShiftLastEmitAt >= scrollRepeatMs)
            {
                Emit("overlay-scroll-up");
                ctrlShiftActive = true;
                ctrlShiftLastEmitAt = now;
            }
        }
        else
        {
            ctrlShiftActive = false;
            ctrlShiftLastEmitAt = 0;
        }
    }

    private static void PollScrollChords()
    {
        while (true)
        {
            UpdateScrollChords();
            Thread.Sleep(50);
        }
    }

    private static bool IsKeyCurrentlyDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    private static bool IsAnyCtrlDown()
    {
        return IsKeyCurrentlyDown(VK_CONTROL) || IsKeyCurrentlyDown(VK_LCONTROL) || IsKeyCurrentlyDown(VK_RCONTROL);
    }

    private static bool IsAnyShiftDown()
    {
        return IsKeyCurrentlyDown(VK_SHIFT) || IsKeyCurrentlyDown(VK_LSHIFT) || IsKeyCurrentlyDown(VK_RSHIFT);
    }

    private static bool IsAnyAltDown()
    {
        return IsKeyCurrentlyDown(VK_MENU) || IsKeyCurrentlyDown(VK_LMENU) || IsKeyCurrentlyDown(VK_RMENU);
    }

    private static void Emit(string value)
    {
        Console.WriteLine(value);
        Console.Out.Flush();
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }
}
"@

if ($env:CODEX_SCREEN_WATCHER_COMPILE_ONLY -eq "1") {
  Write-Output "compile-ok"
  exit 0
}

[DoubleShiftWatcher]::Run($interval)
