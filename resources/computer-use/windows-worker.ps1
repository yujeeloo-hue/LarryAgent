# JellyBot computer-use worker for Windows.
# Protocol: one JSON request per stdin line {"id","cmd","args"}; one JSON response per stdout line.
# The first stdout line is {"ready":true,...} once the native types are loaded.
# Windows PowerShell 5.1 compiles the C# below with the in-box C# 5 compiler: keep it C# 5 compatible.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace JellyBotComputerUse
{
    public class WorkerException : Exception
    {
        public string Code;
        public WorkerException(string code, string message) : base(message) { Code = code; }
    }

    public static class Win32
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint dpiX, out uint dpiY);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        public delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int hookId, LowLevelMouseProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr64(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "GetClassLongW")] public static extern uint GetClassLong32(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);

        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
    }

    public class PointerTarget
    {
        public IntPtr Hwnd;
        public IntPtr Root;
        public int Pid;
        public string ClassName;
        public string RootClass;
        public bool Desktop;
        public bool Surface;
        public bool Deaf;
    }

    public class HeldPress
    {
        public PointerTarget Target;
        public string Button;
        public double X;
        public double Y;
    }

    public class WindowInfo
    {
        public IntPtr Hwnd;
        public int Pid;
        public string Title;
        public string ClassName;
        public Win32.RECT Rect;
        public bool Minimized;
    }

    public class OcrBuilder
    {
        private double inverse = 1.0;
        private int width;
        private int height;
        private string language = "";
        private readonly List<object> lines = new List<object>();
        private string lineText;
        private List<object> words;

        public Dictionary<string, object> Result;

        public void Begin(double factor, int imageWidth, int imageHeight, string languageTag)
        {
            inverse = factor > 0 ? 1.0 / factor : 1.0;
            width = imageWidth;
            height = imageHeight;
            language = languageTag ?? "";
        }

        public void BeginLine(string text)
        {
            Flush();
            lineText = text ?? "";
            words = new List<object>();
        }

        public void AddWord(string text, double x, double y, double w, double h)
        {
            if (words == null) BeginLine("");
            words.Add(Worker.Box(text ?? "", x * inverse, y * inverse, w * inverse, h * inverse));
        }

        public void End()
        {
            Flush();
            Result = new Dictionary<string, object>();
            Result["width"] = width;
            Result["height"] = height;
            Result["language"] = language;
            Result["lines"] = lines;
        }

        private void Flush()
        {
            if (lineText == null) return;
            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
            foreach (object o in words)
            {
                Dictionary<string, object> word = (Dictionary<string, object>)o;
                double wx = Convert.ToDouble(word["x"]), wy = Convert.ToDouble(word["y"]);
                double ww = Convert.ToDouble(word["width"]), wh = Convert.ToDouble(word["height"]);
                x0 = Math.Min(x0, wx); y0 = Math.Min(y0, wy);
                x1 = Math.Max(x1, wx + ww); y1 = Math.Max(y1, wy + wh);
            }
            Dictionary<string, object> line = words.Count > 0
                ? Worker.Box(lineText, x0, y0, x1 - x0, y1 - y0)
                : Worker.Box(lineText, 0, 0, 0, 0);
            line["words"] = words;
            lines.Add(line);
            lineText = null;
            words = null;
        }
    }

    public static class Worker
    {
        public const string Version = "2";
        private static readonly JavaScriptSerializer Json = CreateSerializer();
        private static readonly HashSet<string> HeldButtons = new HashSet<string>();
        private static long lastUserPointerTicks;
        private static long lastSyntheticTicks;
        private static bool hookActive;
        private static IntPtr hookHandle = IntPtr.Zero;
        private static Win32.LowLevelMouseProc hookProc;
        private static HeldPress heldPress;
        private static bool borrowing;
        private static Win32.POINT borrowedCursor;
        private static List<string> borrowedModifiers = new List<string>();
        public static object PendingId;
        public static Dictionary<string, object> PendingArgs;

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            s.RecursionLimit = 256;
            return s;
        }

        public static void Init()
        {
            try { if (Win32.SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            try { if (Win32.SetProcessDpiAwareness(2) == 0) return; } catch { }
            try { Win32.SetProcessDPIAware(); } catch { }
        }

        public static void InitTimers()
        {
            try { Win32.timeBeginPeriod(1); } catch { }
        }

        public static void StartPointerHook()
        {
            ManualResetEvent ready = new ManualResetEvent(false);
            Thread thread = new Thread(delegate ()
            {
                try
                {
                    hookProc = new Win32.LowLevelMouseProc(PointerHook);
                    hookHandle = Win32.SetWindowsHookEx(14, hookProc, Win32.GetModuleHandle(null), 0);
                    hookActive = hookHandle != IntPtr.Zero;
                }
                catch { hookActive = false; }
                ready.Set();
                if (!hookActive) return;
                Win32.MSG msg;
                while (Win32.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            });
            thread.IsBackground = true;
            thread.Name = "jellybot-pointer-hook";
            thread.Start();
            ready.WaitOne(2000);
        }

        private static IntPtr PointerHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                int flags = Marshal.ReadInt32(lParam, 12);
                if ((flags & 0x3) == 0) Interlocked.Exchange(ref lastUserPointerTicks, DateTime.UtcNow.Ticks);
            }
            return Win32.CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        private static void MarkSynthetic()
        {
            Interlocked.Exchange(ref lastSyntheticTicks, DateTime.UtcNow.Ticks);
        }

        public static string ReadyLine()
        {
            Dictionary<string, object> ready = new Dictionary<string, object>();
            ready["ready"] = true;
            ready["version"] = Version;
            ready["pid"] = Process.GetCurrentProcess().Id;
            return Json.Serialize(ready);
        }

        // Returns the JSON response line, or "" when the command must be finished by the PowerShell host.
        public static string HandleLine(string line)
        {
            object id = null;
            try
            {
                Dictionary<string, object> request = Json.DeserializeObject(line) as Dictionary<string, object>;
                if (request == null) throw new WorkerException("invalid_request", "Request must be a JSON object.");
                id = request.ContainsKey("id") ? request["id"] : null;
                string cmd = request.ContainsKey("cmd") ? Convert.ToString(request["cmd"]) : "";
                Dictionary<string, object> args = (request.ContainsKey("args") ? request["args"] : null) as Dictionary<string, object>;
                if (args == null) args = new Dictionary<string, object>();
                if (cmd == "screen.ocr")
                {
                    PendingId = id;
                    PendingArgs = args;
                    return "";
                }
                return Ok(id, Dispatch(cmd, args));
            }
            catch (Exception error)
            {
                return Fail(id, error);
            }
        }

        public static string Ok(object id, object result)
        {
            Dictionary<string, object> response = new Dictionary<string, object>();
            response["id"] = id;
            response["ok"] = true;
            response["result"] = result;
            return Json.Serialize(response);
        }

        public static string Fail(object id, Exception error)
        {
            Exception inner = error;
            while (inner.InnerException != null && !(inner is WorkerException)) inner = inner.InnerException;
            WorkerException known = inner as WorkerException;
            Dictionary<string, object> response = new Dictionary<string, object>();
            response["id"] = id;
            response["ok"] = false;
            response["code"] = known != null ? known.Code : "native_error";
            response["error"] = inner.Message;
            return Json.Serialize(response);
        }

        public static object Dispatch(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                case "ping": return Ping();
                case "system.info": return SystemInfo();
                case "permissions.request": return SystemInfo()["permissions"];
                case "screens": return Wrap("screens", Screens());
                case "mouse.position": return Position();
                case "input.activity": return InputActivity();
                case "input.sequence": return RunSequence(Arr(a, "events"));
                case "input.hover": return InputHover(a);
                case "input.click_at": return InputClickAt(a);
                case "input.drag_path": return InputDragPath(a);
                case "input.scroll_at": return InputScrollAt(a);
                case "input.button_at": return InputButtonAt(a);
                case "key.char_vk": return CharVk(Str(a, "char"));
                case "ui.find_app": return Wrap("app", FindApp(a.ContainsKey("target") ? a["target"] : null));
                case "ui.windows": return Wrap("windows", AppWindows(Int(a, "pid", 0)));
                case "ui.find": return UiFind(a);
                case "ui.batch_state": return BatchDesktopState(a);
                case "ui.dock": return Dock(Str(a, "name"));
                case "ui.menubar": return Menubar(Str(a, "menu"));
                case "ui.hit_test": return HitTest(Num(a, "x", 0), Num(a, "y", 0));
                case "ui.prepare_password": return PreparePassword(a);
                case "ui.fill_password": return FillPassword(a);
                case "ui.discard_password": return DiscardPassword(a);
                case "screen.capture": return Capture(Arr(a, "region"), Str(a, "path"));
                default: throw new WorkerException("unknown_command", "Unknown command: " + cmd);
            }
        }

        // ---------------------------------------------------------------- args

        public static string Str(Dictionary<string, object> a, string key)
        {
            if (a == null || !a.ContainsKey(key) || a[key] == null) return null;
            return Convert.ToString(a[key], CultureInfo.InvariantCulture);
        }

        public static double Num(Dictionary<string, object> a, string key, double fallback)
        {
            if (a == null || !a.ContainsKey(key) || a[key] == null) return fallback;
            return Convert.ToDouble(a[key], CultureInfo.InvariantCulture);
        }

        public static int Int(Dictionary<string, object> a, string key, int fallback)
        {
            return (int)Math.Round(Num(a, key, fallback));
        }

        public static bool Bool(Dictionary<string, object> a, string key, bool fallback)
        {
            if (a == null || !a.ContainsKey(key) || a[key] == null) return fallback;
            return Convert.ToBoolean(a[key], CultureInfo.InvariantCulture);
        }

        public static object[] Arr(Dictionary<string, object> a, string key)
        {
            if (a == null || !a.ContainsKey(key) || a[key] == null) return null;
            object[] array = a[key] as object[];
            if (array != null) return array;
            ArrayList list = a[key] as ArrayList;
            return list != null ? list.ToArray() : null;
        }

        private static Dictionary<string, object> Wrap(string key, object value)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d[key] = value;
            return d;
        }

        private static double R1(double v) { return Math.Round(v, 1); }

        public static Dictionary<string, object> Point(double x, double y)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["x"] = R1(x);
            d["y"] = R1(y);
            return d;
        }

        public static Dictionary<string, object> Rect(double x, double y, double w, double h)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["x"] = R1(x);
            d["y"] = R1(y);
            d["width"] = R1(w);
            d["height"] = R1(h);
            return d;
        }

        public static Dictionary<string, object> Box(string text, double x, double y, double w, double h)
        {
            Dictionary<string, object> d = Rect(x, y, w, h);
            d["text"] = text;
            return d;
        }

        // ---------------------------------------------------------------- system

        private static Dictionary<string, object> Ping()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["version"] = Version;
            d["platform"] = "windows";
            d["pid"] = Process.GetCurrentProcess().Id;
            return d;
        }

        private static Dictionary<string, object> SystemInfo()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["version"] = Version;
            d["platform"] = "windows";
            d["screens"] = Screens();
            Dictionary<string, object> permissions = new Dictionary<string, object>();
            permissions["accessibility"] = true;
            permissions["screen_capture"] = true;
            permissions["hints"] = new List<object> {
                "Windows uses the current interactive session; no Accessibility / Screen Recording grant is needed.",
                "Pointer actions go to the window under the point (background), through UI Automation, or briefly borrow the cursor; result.delivery.mode says which.",
                "Input cannot reach windows of elevated (administrator) apps unless JellyBot itself runs elevated."
            };
            d["pointer_hook"] = hookActive;
            d["permissions"] = permissions;
            d["frontmost_pid"] = ForegroundPid();
            return d;
        }

        public static List<object> Screens()
        {
            List<object> list = new List<object>();
            Win32.MonitorEnumProc callback = delegate (IntPtr monitor, IntPtr hdc, ref Win32.RECT rect, IntPtr data)
            {
                Win32.MONITORINFOEX info = new Win32.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Win32.MONITORINFOEX));
                if (Win32.GetMonitorInfo(monitor, ref info))
                {
                    double scale = 1.0;
                    try
                    {
                        uint dpiX, dpiY;
                        if (Win32.GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) == 0 && dpiX > 0) scale = dpiX / 96.0;
                    }
                    catch { }
                    Win32.RECT r = info.rcMonitor;
                    Dictionary<string, object> s = new Dictionary<string, object>();
                    s["id"] = monitor.ToInt64();
                    s["is_main"] = (info.dwFlags & 1) != 0;
                    s["x"] = r.Left;
                    s["y"] = r.Top;
                    s["width"] = r.Right - r.Left;
                    s["height"] = r.Bottom - r.Top;
                    s["pixels_wide"] = r.Right - r.Left;
                    s["pixels_high"] = r.Bottom - r.Top;
                    s["scale"] = Math.Round(scale, 3);
                    s["device"] = info.szDevice ?? "";
                    list.Add(s);
                }
                return true;
            };
            Win32.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            if (list.Count == 0)
            {
                Dictionary<string, object> s = new Dictionary<string, object>();
                s["id"] = 0;
                s["is_main"] = true;
                s["x"] = Win32.GetSystemMetrics(76);
                s["y"] = Win32.GetSystemMetrics(77);
                s["width"] = Win32.GetSystemMetrics(78);
                s["height"] = Win32.GetSystemMetrics(79);
                s["pixels_wide"] = s["width"];
                s["pixels_high"] = s["height"];
                s["scale"] = 1.0;
                s["device"] = "";
                list.Add(s);
            }
            return list;
        }

        // ---------------------------------------------------------------- input

        private static Dictionary<string, object> Position()
        {
            Win32.POINT p;
            Win32.GetCursorPos(out p);
            return Point(p.X, p.Y);
        }

        private static void Send(Win32.INPUT input)
        {
            Win32.INPUT[] inputs = new Win32.INPUT[] { input };
            MarkSynthetic();
            if (Win32.SendInput(1, inputs, Marshal.SizeOf(typeof(Win32.INPUT))) == 0)
            {
                throw new WorkerException("input_blocked", "SendInput was blocked (error " + Marshal.GetLastWin32Error() + "). The target may be an elevated window or a secure desktop.");
            }
        }

        private static Win32.INPUT MouseInput(int dx, int dy, uint data, uint flags)
        {
            Win32.INPUT input = new Win32.INPUT();
            input.type = Win32.INPUT_MOUSE;
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.mouseData = data;
            input.u.mi.dwFlags = flags;
            return input;
        }

        private static Win32.INPUT KeyInput(ushort vk, ushort scan, uint flags)
        {
            Win32.INPUT input = new Win32.INPUT();
            input.type = Win32.INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            return input;
        }

        private static void MoveTo(double x, double y)
        {
            int vx = Win32.GetSystemMetrics(76), vy = Win32.GetSystemMetrics(77);
            int vw = Win32.GetSystemMetrics(78), vh = Win32.GetSystemMetrics(79);
            int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(vw - 1, 1));
            int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(vh - 1, 1));
            Send(MouseInput(nx, ny, 0, Win32.MOUSEEVENTF_MOVE | Win32.MOUSEEVENTF_ABSOLUTE | Win32.MOUSEEVENTF_VIRTUALDESK));
            int tx = (int)Math.Round(x), ty = (int)Math.Round(y);
            Win32.POINT p;
            if (Win32.GetCursorPos(out p) && (p.X != tx || p.Y != ty))
            {
                MarkSynthetic();
                Win32.SetCursorPos(tx, ty);
            }
        }

        private static uint ButtonFlag(string button, bool down)
        {
            switch (button)
            {
                case "right": return down ? Win32.MOUSEEVENTF_RIGHTDOWN : Win32.MOUSEEVENTF_RIGHTUP;
                case "middle": return down ? Win32.MOUSEEVENTF_MIDDLEDOWN : Win32.MOUSEEVENTF_MIDDLEUP;
                default: return down ? Win32.MOUSEEVENTF_LEFTDOWN : Win32.MOUSEEVENTF_LEFTUP;
            }
        }

        private static Dictionary<string, object> RunSequence(object[] events)
        {
            if (events == null) throw new WorkerException("invalid_arguments", "events is required");
            foreach (object item in events)
            {
                Dictionary<string, object> e = item as Dictionary<string, object>;
                if (e == null) continue;
                string type = Str(e, "t");
                switch (type)
                {
                    case "move":
                        MoveTo(Num(e, "x", 0), Num(e, "y", 0));
                        break;
                    case "button":
                    {
                        string button = Str(e, "button") ?? "left";
                        bool down = Bool(e, "down", true);
                        if (e.ContainsKey("x") && e.ContainsKey("y") && e["x"] != null && e["y"] != null) MoveTo(Num(e, "x", 0), Num(e, "y", 0));
                        Send(MouseInput(0, 0, 0, ButtonFlag(button, down)));
                        if (down) HeldButtons.Add(button); else HeldButtons.Remove(button);
                        break;
                    }
                    case "scroll":
                    {
                        double factor = Str(e, "unit") == "pixel" ? 1.0 : 120.0;
                        int dy = (int)Math.Round(Num(e, "dy", 0) * factor);
                        int dx = (int)Math.Round(Num(e, "dx", 0) * factor);
                        if (dy != 0) Send(MouseInput(0, 0, unchecked((uint)dy), Win32.MOUSEEVENTF_WHEEL));
                        if (dx != 0) Send(MouseInput(0, 0, unchecked((uint)dx), Win32.MOUSEEVENTF_HWHEEL));
                        break;
                    }
                    case "vk":
                    {
                        ushort vk = (ushort)Int(e, "code", 0);
                        uint flags = (Bool(e, "down", true) ? 0u : Win32.KEYEVENTF_KEYUP) | (Bool(e, "extended", false) ? Win32.KEYEVENTF_EXTENDEDKEY : 0u);
                        Send(KeyInput(vk, (ushort)Win32.MapVirtualKey(vk, 0), flags));
                        break;
                    }
                    case "char":
                    {
                        string text = Str(e, "text") ?? "";
                        uint flags = Win32.KEYEVENTF_UNICODE | (Bool(e, "down", true) ? 0u : Win32.KEYEVENTF_KEYUP);
                        foreach (char unit in text) Send(KeyInput(0, unit, flags));
                        break;
                    }
                    case "sleep":
                    {
                        int ms = Int(e, "ms", 0);
                        if (ms > 0) Thread.Sleep(ms);
                        break;
                    }
                    default:
                        throw new WorkerException("invalid_arguments", "Unknown input event type: " + type);
                }
            }
            Dictionary<string, object> result = Position();
            result["held_buttons"] = new List<string>(HeldButtons);
            return result;
        }

        private static Dictionary<string, object> CharVk(string ch)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            if (string.IsNullOrEmpty(ch) || ch.Length != 1)
            {
                d["vk"] = null;
                return d;
            }
            short scan = Win32.VkKeyScan(ch[0]);
            if (scan == -1)
            {
                d["vk"] = null;
                return d;
            }
            d["vk"] = scan & 0xFF;
            d["shift_state"] = (scan >> 8) & 0xFF;
            return d;
        }

        private static readonly HashSet<string> DesktopClasses = new HashSet<string> { "Progman", "WorkerW" };

        private static readonly HashSet<string> SurfaceClasses = new HashSet<string> {
            "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
            "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "Xaml_WindowedPopupClass", "MultitaskingViewFrame",
            "ForegroundStaging"
        };

        private static readonly HashSet<string> DeafClasses = new HashSet<string> {
            "ApplicationFrameWindow", "ApplicationFrameInputSinkWindow", "Windows.UI.Core.CoreWindow",
            "Windows.UI.Input.InputSite.WindowClass", "Microsoft.UI.Content.DesktopChildSiteBridge",
            "Windows.UI.Composition.DesktopWindowContentBridge", "InputSiteWindowClass", "#32768"
        };

        private static Dictionary<string, object> InputActivity()
        {
            Win32.POINT cursor;
            Win32.GetCursorPos(out cursor);
            long now = DateTime.UtcNow.Ticks;
            double idle = 1e9;
            if (hookActive)
            {
                long last = Interlocked.Read(ref lastUserPointerTicks);
                if (last != 0) idle = (now - last) / 1e7;
            }
            else
            {
                Win32.LASTINPUTINFO info = new Win32.LASTINPUTINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(Win32.LASTINPUTINFO));
                if (Win32.GetLastInputInfo(ref info)) idle = unchecked((uint)Environment.TickCount - info.dwTime) / 1000.0;
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["pointer_idle_s"] = Math.Round(idle, 3);
            d["cursor"] = Point(cursor.X, cursor.Y);
            long synthetic = Interlocked.Read(ref lastSyntheticTicks);
            if (synthetic != 0) d["synthetic_age_s"] = Math.Round((now - synthetic) / 1e7, 3);
            d["source"] = hookActive ? "hook" : "last_input";
            return d;
        }

        private static string ClassOf(IntPtr hwnd)
        {
            StringBuilder cls = new StringBuilder(256);
            Win32.GetClassName(hwnd, cls, cls.Capacity);
            return cls.ToString();
        }

        private static Win32.POINT ScreenPoint(double x, double y)
        {
            Win32.POINT p;
            p.X = (int)Math.Round(x);
            p.Y = (int)Math.Round(y);
            return p;
        }

        private static PointerTarget TargetAt(double x, double y)
        {
            IntPtr hwnd = Win32.WindowFromPoint(ScreenPoint(x, y));
            if (hwnd == IntPtr.Zero) return null;
            IntPtr root = Win32.GetAncestor(hwnd, 2);
            if (root == IntPtr.Zero) root = hwnd;
            PointerTarget t = new PointerTarget();
            t.Hwnd = hwnd;
            t.Root = root;
            uint pid;
            Win32.GetWindowThreadProcessId(root, out pid);
            t.Pid = (int)pid;
            t.ClassName = ClassOf(hwnd);
            t.RootClass = root == hwnd ? t.ClassName : ClassOf(root);
            t.Desktop = DesktopClasses.Contains(t.RootClass);
            t.Surface = SurfaceClasses.Contains(t.RootClass);
            t.Deaf = t.Surface || DeafClasses.Contains(t.ClassName) || DeafClasses.Contains(t.RootClass);
            if (!t.Deaf && !t.Desktop && hwnd == root) t.Deaf = DeafChildAt(root, x, y);
            return t;
        }

        private static bool DeafChildAt(IntPtr root, double x, double y)
        {
            bool found = false;
            Win32.POINT p = ScreenPoint(x, y);
            Win32.EnumWindowsProc callback = delegate (IntPtr hwnd, IntPtr lParam)
            {
                if (!Win32.IsWindowVisible(hwnd) || !DeafClasses.Contains(ClassOf(hwnd))) return true;
                Win32.RECT r;
                if (Win32.GetWindowRect(hwnd, out r) && p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom)
                {
                    found = true;
                    return false;
                }
                return true;
            };
            Win32.EnumChildWindows(root, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }

        private static double MonitorScaleAt(double x, double y)
        {
            try
            {
                uint dpiX, dpiY;
                if (Win32.GetDpiForMonitor(Win32.MonitorFromPoint(ScreenPoint(x, y), 2), 0, out dpiX, out dpiY) == 0 && dpiX > 0) return dpiX / 96.0;
            }
            catch { }
            return 1.0;
        }

        private static bool CaptionAt(double x, double y)
        {
            AutomationElement element = ElementAt(x, y);
            if (element == null) return false;
            try
            {
                ControlType type = element.Current.ControlType;
                if (type == ControlType.TitleBar || type == ControlType.Window || type == ControlType.Pane || type == ControlType.ToolBar) return true;
                AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(element);
                return type == ControlType.Text && parent != null && parent.Current.ControlType == ControlType.TitleBar;
            }
            catch { return false; }
        }

        private static IntPtr MakeLParam(int lo, int hi)
        {
            return new IntPtr(unchecked((int)((((uint)hi & 0xFFFF) << 16) | ((uint)lo & 0xFFFF))));
        }

        private static IntPtr ClientLParam(IntPtr hwnd, double x, double y)
        {
            Win32.POINT origin = new Win32.POINT();
            Win32.ClientToScreen(hwnd, ref origin);
            return MakeLParam((int)Math.Round(x - origin.X), (int)Math.Round(y - origin.Y));
        }

        private static IntPtr ScreenLParam(double x, double y)
        {
            Win32.POINT p = ScreenPoint(x, y);
            return MakeLParam(p.X, p.Y);
        }

        private static int ButtonMask(string button)
        {
            switch (button)
            {
                case "right": return 0x0002;
                case "middle": return 0x0010;
                default: return 0x0001;
            }
        }

        private static int HeldMask()
        {
            int mask = 0;
            foreach (string button in HeldButtons) mask |= ButtonMask(button);
            return mask;
        }

        private static uint ButtonMessage(string button, bool down, bool doubleClick)
        {
            switch (button)
            {
                case "right": return doubleClick ? 0x0206u : down ? 0x0204u : 0x0205u;
                case "middle": return doubleClick ? 0x0209u : down ? 0x0207u : 0x0208u;
                default: return doubleClick ? 0x0203u : down ? 0x0201u : 0x0202u;
            }
        }

        private static bool WantsDoubleClicks(IntPtr hwnd)
        {
            try
            {
                long style = IntPtr.Size == 8 ? Win32.GetClassLongPtr64(hwnd, -26).ToInt64() : Win32.GetClassLong32(hwnd, -26);
                return (style & 0x0008) != 0;
            }
            catch { return false; }
        }

        private static bool Post(IntPtr hwnd, uint message, int wParam, IntPtr lParam)
        {
            return Win32.PostMessage(hwnd, message, new IntPtr(wParam), lParam);
        }

        private static void Pause(int ms)
        {
            if (ms > 0) Thread.Sleep(ms);
        }

        private static List<string> Modifiers(Dictionary<string, object> a)
        {
            List<string> names = new List<string>();
            object[] raw = Arr(a, "modifiers");
            if (raw == null) return names;
            foreach (object item in raw)
            {
                string name = Convert.ToString(item, CultureInfo.InvariantCulture);
                if (!string.IsNullOrEmpty(name) && !names.Contains(name)) names.Add(name);
            }
            return names;
        }

        private static void PressModifiers(List<string> names, bool down)
        {
            List<string> ordered = new List<string>(names);
            if (!down) ordered.Reverse();
            foreach (string name in ordered)
            {
                ushort vk;
                bool extended = false;
                switch (name)
                {
                    case "ctrl": vk = 0x11; break;
                    case "shift": vk = 0x10; break;
                    case "alt": vk = 0x12; break;
                    case "win": vk = 0x5B; extended = true; break;
                    default: continue;
                }
                uint flags = (down ? 0u : Win32.KEYEVENTF_KEYUP) | (extended ? Win32.KEYEVENTF_EXTENDEDKEY : 0u);
                Send(KeyInput(vk, (ushort)Win32.MapVirtualKey(vk, 0), flags));
                Thread.Sleep(8);
            }
        }

        private static List<Dictionary<string, object>> PointList(Dictionary<string, object> a, string key)
        {
            List<Dictionary<string, object>> points = new List<Dictionary<string, object>>();
            object[] raw = Arr(a, key);
            if (raw == null) return points;
            foreach (object item in raw)
            {
                Dictionary<string, object> entry = item as Dictionary<string, object>;
                if (entry == null || !entry.ContainsKey("x") || !entry.ContainsKey("y")) continue;
                points.Add(Point(Num(entry, "x", 0), Num(entry, "y", 0)));
            }
            return points;
        }

        private static double PX(Dictionary<string, object> p) { return Convert.ToDouble(p["x"], CultureInfo.InvariantCulture); }
        private static double PY(Dictionary<string, object> p) { return Convert.ToDouble(p["y"], CultureInfo.InvariantCulture); }

        private static Dictionary<string, object> BackgroundDelivery(PointerTarget t)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["mode"] = "background";
            d["pid"] = t.Pid;
            d["window"] = t.Hwnd.ToInt64();
            d["app"] = ProcessName(t.Pid);
            return d;
        }

        private static Dictionary<string, object> BorrowedDelivery(bool restored, string reason)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["mode"] = "borrowed";
            d["cursor_restored"] = restored;
            if (reason != null) d["reason"] = reason;
            return d;
        }

        private static bool CanActivate(PointerTarget t)
        {
            if (t.Desktop || t.Surface) return false;
            int style = Win32.GetWindowLong(t.Root, -16);
            int exStyle = Win32.GetWindowLong(t.Root, -20);
            if ((exStyle & 0x08000000) != 0) return false;
            return (style & 0x00C00000) == 0x00C00000 || (exStyle & 0x00040000) != 0;
        }

        private static bool TryForeground(IntPtr root)
        {
            IntPtr foreground = Win32.GetForegroundWindow();
            uint ignored;
            uint foregroundThread = foreground != IntPtr.Zero ? Win32.GetWindowThreadProcessId(foreground, out ignored) : 0;
            uint self = Win32.GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != self && Win32.AttachThreadInput(self, foregroundThread, true);
            try
            {
                Win32.BringWindowToTop(root);
                Win32.SetForegroundWindow(root);
            }
            finally
            {
                if (attached) Win32.AttachThreadInput(self, foregroundThread, false);
            }
            for (int i = 0; i < 12 && Win32.GetForegroundWindow() != root; i++) Thread.Sleep(25);
            return Win32.GetForegroundWindow() == root;
        }

        private static void FocusForClick(PointerTarget t, Dictionary<string, object> delivery)
        {
            if (!CanActivate(t)) return;
            if (Win32.GetForegroundWindow() == t.Root)
            {
                delivery["activated"] = false;
                return;
            }
            if (Win32.IsIconic(t.Root)) Win32.ShowWindow(t.Root, 9);
            bool ok = TryForeground(t.Root);
            if (!ok)
            {
                Send(MouseInput(0, 0, 0, Win32.MOUSEEVENTF_MOVE));
                ok = TryForeground(t.Root);
            }
            delivery["activated"] = ok;
            if (!ok) delivery["activation_blocked"] = true;
            Thread.Sleep(60);
        }

        private static bool RunBounded(ThreadStart action, int timeoutMs)
        {
            Exception failure = null;
            Thread thread = new Thread(delegate ()
            {
                try { action(); }
                catch (Exception error) { failure = error; }
            });
            thread.IsBackground = true;
            thread.Start();
            if (!thread.Join(timeoutMs)) return true;
            return failure == null;
        }

        private static AutomationElement ElementAt(double x, double y)
        {
            try { return AutomationElement.FromPoint(new System.Windows.Point(x, y)); }
            catch { return null; }
        }

        private static Dictionary<string, object> AccessibilityDelivery(string action, AutomationElement element)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["mode"] = "accessibility";
            d["action"] = action;
            d["role"] = RoleOf(element) ?? "";
            d["name"] = NameOf(element) ?? "";
            try { d["pid"] = element.Current.ProcessId; } catch { }
            return d;
        }

        private static Dictionary<string, object> PressByAutomation(double x, double y)
        {
            AutomationElement element = ElementAt(x, y);
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int depth = 0; element != null && depth < 5; depth++)
            {
                object pattern;
                if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    InvokePattern invoke = (InvokePattern)pattern;
                    if (RunBounded(delegate () { invoke.Invoke(); }, 1500)) return AccessibilityDelivery("Invoke", element);
                    return null;
                }
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                {
                    TogglePattern toggle = (TogglePattern)pattern;
                    if (RunBounded(delegate () { toggle.Toggle(); }, 1500)) return AccessibilityDelivery("Toggle", element);
                    return null;
                }
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                {
                    SelectionItemPattern item = (SelectionItemPattern)pattern;
                    if (RunBounded(delegate () { item.Select(); }, 1500)) return AccessibilityDelivery("Select", element);
                    return null;
                }
                if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                {
                    ExpandCollapsePattern expand = (ExpandCollapsePattern)pattern;
                    bool collapsed = expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed;
                    if (RunBounded(delegate () { if (collapsed) expand.Expand(); else expand.Collapse(); }, 1500))
                    {
                        return AccessibilityDelivery(collapsed ? "Expand" : "Collapse", element);
                    }
                    return null;
                }
                try { element = walker.GetParent(element); }
                catch { element = null; }
                if (element == AutomationElement.RootElement) break;
            }
            return null;
        }

        private static Dictionary<string, object> MoveOrResizeWindow(PointerTarget t, double sx, double sy, double ex, double ey)
        {
            if (Win32.IsZoomed(t.Root) || Win32.IsIconic(t.Root)) return null;
            IntPtr hit;
            if (Win32.SendMessageTimeout(t.Root, 0x0084, IntPtr.Zero, ScreenLParam(sx, sy), 0x0002, 500, out hit) == IntPtr.Zero) return null;
            int code = unchecked((int)hit.ToInt64());
            Win32.RECT r;
            if (!Win32.GetWindowRect(t.Root, out r)) return null;
            int dx = (int)Math.Round(ex - sx), dy = (int)Math.Round(ey - sy);
            int left = r.Left, top = r.Top, right = r.Right, bottom = r.Bottom;
            double scale = MonitorScaleAt(sx, sy);
            double edge = 16 * scale;
            bool nearLeft = sx - r.Left <= edge, nearRight = r.Right - sx <= edge;
            bool nearTop = sy - r.Top <= edge, nearBottom = r.Bottom - sy <= edge;
            string control = "window_resize";
            switch (code)
            {
                case 2:
                    if (sy - r.Top > 64 * scale || !CaptionAt(sx, sy)) return null;
                    left += dx; right += dx; top += dy; bottom += dy; control = "window_move";
                    break;
                case 10: if (!nearLeft) return null; left += dx; break;
                case 11: if (!nearRight) return null; right += dx; break;
                case 12: if (!nearTop) return null; top += dy; break;
                case 13: if (!nearLeft || !nearTop) return null; left += dx; top += dy; break;
                case 14: if (!nearRight || !nearTop) return null; right += dx; top += dy; break;
                case 15: if (!nearBottom) return null; bottom += dy; break;
                case 16: if (!nearLeft || !nearBottom) return null; left += dx; bottom += dy; break;
                case 17: if (!nearRight || !nearBottom) return null; right += dx; bottom += dy; break;
                default: return null;
            }
            if (right - left < 40 || bottom - top < 40) return null;
            if (!Win32.SetWindowPos(t.Root, IntPtr.Zero, left, top, right - left, bottom - top, 0x0004 | 0x0010)) return null;
            Win32.RECT now;
            Win32.GetWindowRect(t.Root, out now);
            if (now.Left == r.Left && now.Top == r.Top && now.Right == r.Right && now.Bottom == r.Bottom) return null;
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["mode"] = "accessibility";
            d["control"] = control;
            d["frame"] = Rect(now.Left, now.Top, now.Right - now.Left, now.Bottom - now.Top);
            d["pid"] = t.Pid;
            return d;
        }

        private static Dictionary<string, object> SetSlider(double sx, double sy, double ex, double ey)
        {
            AutomationElement element = ElementAt(sx, sy);
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int depth = 0; element != null && depth < 3; depth++)
            {
                try { if (element.Current.ControlType == ControlType.Slider) break; } catch { return null; }
                try { element = walker.GetParent(element); } catch { return null; }
            }
            if (element == null) return null;
            try
            {
                if (element.Current.ControlType != ControlType.Slider) return null;
                object pattern;
                if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) return null;
                RangeValuePattern range = (RangeValuePattern)pattern;
                if (range.Current.IsReadOnly) return null;
                System.Windows.Rect frame = element.Current.BoundingRectangle;
                if (frame.IsEmpty || frame.Width <= 0 || frame.Height <= 0) return null;
                double minimum = range.Current.Minimum, maximum = range.Current.Maximum;
                if (maximum <= minimum) return null;
                OrientationType orientation = element.Current.Orientation;
                bool vertical = orientation == OrientationType.Vertical || (orientation == OrientationType.None && frame.Height > frame.Width);
                double fraction = vertical ? 1 - (ey - frame.Top) / frame.Height : (ex - frame.Left) / frame.Width;
                double wanted = minimum + Math.Max(0, Math.Min(1, fraction)) * (maximum - minimum);
                double value = range.Current.Value;
                if (Math.Abs(value - wanted) > (maximum - minimum) * 0.02)
                {
                    if (!RunBounded(delegate () { range.SetValue(wanted); }, 1500)) return null;
                    Thread.Sleep(120);
                    value = range.Current.Value;
                }
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["mode"] = "accessibility";
                d["control"] = "slider";
                d["value"] = value;
                d["target_value"] = wanted;
                d["pid"] = element.Current.ProcessId;
                return d;
            }
            catch { return null; }
        }

        private static void BeginBorrow()
        {
            if (borrowing) return;
            MarkSynthetic();
            Win32.GetCursorPos(out borrowedCursor);
            borrowing = true;
        }

        private static bool EndBorrow(double x, double y)
        {
            if (!borrowing) return false;
            MarkSynthetic();
            Win32.POINT now;
            Win32.GetCursorPos(out now);
            bool restored = false;
            if (Math.Abs(now.X - Math.Round(x)) <= 1.5 && Math.Abs(now.Y - Math.Round(y)) <= 1.5)
            {
                Win32.SetCursorPos(borrowedCursor.X, borrowedCursor.Y);
                Win32.POINT after;
                Win32.GetCursorPos(out after);
                restored = Math.Abs(after.X - borrowedCursor.X) <= 1 && Math.Abs(after.Y - borrowedCursor.Y) <= 1;
            }
            borrowing = false;
            return restored;
        }

        private static bool Busy()
        {
            return heldPress != null || borrowing;
        }

        private static Dictionary<string, object> InputHover(Dictionary<string, object> a)
        {
            List<Dictionary<string, object>> points = PointList(a, "points");
            if (points.Count == 0) throw new WorkerException("invalid_arguments", "points is required");
            int interval = Math.Max(0, Int(a, "interval_ms", 0));
            Win32.POINT before;
            Win32.GetCursorPos(out before);
            PointerTarget last = null;
            for (int i = 0; i < points.Count; i++)
            {
                double x = PX(points[i]), y = PY(points[i]);
                if (heldPress != null)
                {
                    Post(heldPress.Target.Hwnd, 0x0200, HeldMask(), ClientLParam(heldPress.Target.Hwnd, x, y));
                    heldPress.X = x;
                    heldPress.Y = y;
                    last = heldPress.Target;
                }
                else if (borrowing)
                {
                    MoveTo(x, y);
                }
                else
                {
                    PointerTarget t = TargetAt(x, y);
                    if (t != null && !t.Desktop && !t.Deaf && Post(t.Hwnd, 0x0200, HeldMask(), ClientLParam(t.Hwnd, x, y))) last = t;
                }
                if (i < points.Count - 1) Pause(interval);
            }
            Win32.POINT after;
            Win32.GetCursorPos(out after);
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["hovered"] = points.Count;
            d["target_pid"] = last != null ? (object)last.Pid : null;
            d["target_window"] = last != null ? (object)last.Hwnd.ToInt64() : null;
            d["pointer_moved"] = Math.Abs(after.X - before.X) + Math.Abs(after.Y - before.Y) > 0;
            return d;
        }

        private static bool PostClick(PointerTarget t, double x, double y, string button, int clicks, int holdMs, int gapMs)
        {
            IntPtr l = ClientLParam(t.Hwnd, x, y);
            if (!Post(t.Hwnd, 0x0200, HeldMask(), l)) return false;
            Thread.Sleep(8);
            bool doubles = WantsDoubleClicks(t.Hwnd);
            int mask = ButtonMask(button);
            for (int i = 1; i <= clicks; i++)
            {
                Post(t.Hwnd, ButtonMessage(button, true, doubles && i == 2), HeldMask() | mask, l);
                Pause(holdMs);
                Post(t.Hwnd, ButtonMessage(button, false, false), HeldMask() & ~mask, l);
                if (i < clicks) Pause(gapMs);
            }
            return true;
        }

        private static Dictionary<string, object> Clicked(double x, double y, int clicks, Dictionary<string, object> delivery)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["clicked"] = Point(x, y);
            d["clicks"] = clicks;
            d["delivery"] = delivery;
            return d;
        }

        private static Dictionary<string, object> InputClickAt(Dictionary<string, object> a)
        {
            double x = Num(a, "x", 0), y = Num(a, "y", 0);
            string button = Str(a, "button") ?? "left";
            int clicks = Math.Max(1, Math.Min(3, Int(a, "clicks", 1)));
            int holdMs = Math.Max(0, Int(a, "hold_ms", 50));
            int gapMs = Math.Max(0, Int(a, "gap_ms", 30));
            List<string> mods = Modifiers(a);
            string reason = null;
            if (Str(a, "delivery") != "borrow")
            {
                PointerTarget t = Busy() ? null : TargetAt(x, y);
                if (Busy()) reason = "button_held";
                else if (t == null) reason = "no_window";
                else if (t.Desktop) reason = "desktop";
                else if (t.Deaf)
                {
                    if (clicks == 1 && mods.Count == 0 && button == "left")
                    {
                        Dictionary<string, object> pressed = PressByAutomation(x, y);
                        if (pressed != null) return Clicked(x, y, 1, pressed);
                    }
                    reason = t.Surface ? "system_surface" : "input_sink";
                }
                else if (mods.Count > 0) reason = "modifiers";
                else
                {
                    Dictionary<string, object> delivery = BackgroundDelivery(t);
                    FocusForClick(t, delivery);
                    if (PostClick(t, x, y, button, clicks, holdMs, gapMs)) return Clicked(x, y, clicks, delivery);
                    reason = "post_blocked";
                }
            }
            BeginBorrow();
            bool restored = false;
            try
            {
                MoveTo(x, y);
                Thread.Sleep(8);
                PressModifiers(mods, true);
                try
                {
                    for (int i = 1; i <= clicks; i++)
                    {
                        Send(MouseInput(0, 0, 0, ButtonFlag(button, true)));
                        Pause(holdMs);
                        Send(MouseInput(0, 0, 0, ButtonFlag(button, false)));
                        if (i < clicks) Pause(gapMs);
                    }
                }
                finally
                {
                    PressModifiers(mods, false);
                }
            }
            finally
            {
                restored = EndBorrow(x, y);
            }
            return Clicked(x, y, clicks, BorrowedDelivery(restored, reason));
        }

        private static bool PostDrag(PointerTarget t, List<Dictionary<string, object>> points, string button, int intervalMs, int settleMs)
        {
            IntPtr hwnd = t.Hwnd;
            double sx = PX(points[0]), sy = PY(points[0]);
            if (!Post(hwnd, 0x0200, HeldMask(), ClientLParam(hwnd, sx, sy))) return false;
            Thread.Sleep(8);
            int mask = ButtonMask(button);
            Post(hwnd, ButtonMessage(button, true, false), HeldMask() | mask, ClientLParam(hwnd, sx, sy));
            Pause(settleMs);
            for (int i = 1; i < points.Count; i++)
            {
                Post(hwnd, 0x0200, HeldMask() | mask, ClientLParam(hwnd, PX(points[i]), PY(points[i])));
                Pause(intervalMs);
            }
            Pause(settleMs);
            Dictionary<string, object> end = points[points.Count - 1];
            Post(hwnd, ButtonMessage(button, false, false), HeldMask() & ~mask, ClientLParam(hwnd, PX(end), PY(end)));
            return true;
        }

        private static Dictionary<string, object> Dragged(Dictionary<string, object> summary, Dictionary<string, object> delivery)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["dragged"] = summary;
            d["delivery"] = delivery;
            return d;
        }

        private static Dictionary<string, object> InputDragPath(Dictionary<string, object> a)
        {
            List<Dictionary<string, object>> points = PointList(a, "points");
            if (points.Count < 2) throw new WorkerException("invalid_arguments", "points needs at least a start and an end");
            string button = Str(a, "button") ?? "left";
            int intervalMs = Math.Max(1, Int(a, "interval_ms", 8));
            int settleMs = Math.Max(0, Int(a, "settle_ms", 60));
            Dictionary<string, object> start = points[0], end = points[points.Count - 1];
            double sx = PX(start), sy = PY(start), ex = PX(end), ey = PY(end);
            Dictionary<string, object> summary = new Dictionary<string, object>();
            summary["from"] = start;
            summary["to"] = end;
            summary["frames"] = points.Count;
            string reason = null;
            if (Str(a, "delivery") != "borrow")
            {
                PointerTarget t = Busy() ? null : TargetAt(sx, sy);
                if (Busy()) reason = "button_held";
                else if (t == null) reason = "no_window";
                else if (t.Desktop) reason = "desktop";
                else
                {
                    if (button == "left" && !t.Surface)
                    {
                        Dictionary<string, object> adjusted = MoveOrResizeWindow(t, sx, sy, ex, ey) ?? SetSlider(sx, sy, ex, ey);
                        if (adjusted != null) return Dragged(summary, adjusted);
                    }
                    if (t.Deaf) reason = t.Surface ? "system_surface" : "input_sink";
                    else
                    {
                        Dictionary<string, object> delivery = BackgroundDelivery(t);
                        FocusForClick(t, delivery);
                        if (PostDrag(t, points, button, intervalMs, settleMs)) return Dragged(summary, delivery);
                        reason = "post_blocked";
                    }
                }
            }
            BeginBorrow();
            bool restored = false;
            try
            {
                MoveTo(sx, sy);
                Thread.Sleep(8);
                Send(MouseInput(0, 0, 0, ButtonFlag(button, true)));
                try
                {
                    Pause(settleMs);
                    for (int i = 1; i < points.Count; i++)
                    {
                        MoveTo(PX(points[i]), PY(points[i]));
                        Pause(intervalMs);
                    }
                    Pause(settleMs);
                }
                finally
                {
                    Send(MouseInput(0, 0, 0, ButtonFlag(button, false)));
                }
            }
            finally
            {
                restored = EndBorrow(ex, ey);
            }
            return Dragged(summary, BorrowedDelivery(restored, reason));
        }

        private static List<int> WheelSteps(int amount, bool pixel)
        {
            List<int> steps = new List<int>();
            if (amount == 0) return steps;
            int sign = amount < 0 ? -1 : 1;
            int remaining = Math.Abs(amount);
            if (pixel)
            {
                while (remaining > 0)
                {
                    int chunk = Math.Min(remaining, 30000);
                    steps.Add(sign * chunk);
                    remaining -= chunk;
                }
                return steps;
            }
            for (int i = 0; i < Math.Min(remaining, 100); i++) steps.Add(sign * 120);
            return steps;
        }

        private static Dictionary<string, object> InputScrollAt(Dictionary<string, object> a)
        {
            Win32.POINT cursor;
            Win32.GetCursorPos(out cursor);
            double x = Num(a, "x", cursor.X), y = Num(a, "y", cursor.Y);
            bool pixel = Str(a, "unit") == "pixel";
            int dy = (int)Math.Round(Num(a, "dy", 0)), dx = (int)Math.Round(Num(a, "dx", 0));
            Dictionary<string, object> scrolled = new Dictionary<string, object>();
            scrolled["delta_x"] = dx;
            scrolled["delta_y"] = dy;
            string reason = null;
            if (Str(a, "delivery") != "borrow")
            {
                PointerTarget t = Busy() ? null : TargetAt(x, y);
                if (Busy()) reason = "button_held";
                else if (t == null) reason = "no_window";
                else if (t.Desktop) reason = "desktop";
                else if (t.Deaf) reason = t.Surface ? "system_surface" : "input_sink";
                else
                {
                    IntPtr l = ScreenLParam(x, y);
                    bool ok = true;
                    foreach (int step in WheelSteps(dy, pixel)) ok &= Post(t.Hwnd, 0x020A, (int)MakeLParam(HeldMask(), step).ToInt64(), l);
                    foreach (int step in WheelSteps(dx, pixel)) ok &= Post(t.Hwnd, 0x020E, (int)MakeLParam(HeldMask(), step).ToInt64(), l);
                    if (ok)
                    {
                        Dictionary<string, object> done = new Dictionary<string, object>();
                        done["scrolled"] = scrolled;
                        done["at"] = Point(x, y);
                        done["delivery"] = BackgroundDelivery(t);
                        return done;
                    }
                    reason = "post_blocked";
                }
            }
            BeginBorrow();
            bool restored = false;
            try
            {
                MoveTo(x, y);
                Thread.Sleep(10);
                foreach (int step in WheelSteps(dy, pixel)) Send(MouseInput(0, 0, unchecked((uint)step), Win32.MOUSEEVENTF_WHEEL));
                foreach (int step in WheelSteps(dx, pixel)) Send(MouseInput(0, 0, unchecked((uint)step), Win32.MOUSEEVENTF_HWHEEL));
                Thread.Sleep(10);
            }
            finally
            {
                restored = EndBorrow(x, y);
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["scrolled"] = scrolled;
            result["at"] = Point(x, y);
            result["delivery"] = BorrowedDelivery(restored, reason);
            return result;
        }

        private static Dictionary<string, object> InputButtonAt(Dictionary<string, object> a)
        {
            string button = Str(a, "button") ?? "left";
            bool down = Bool(a, "down", true);
            List<string> mods = Modifiers(a);
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["button"] = button;
            if (down)
            {
                Win32.POINT cursor;
                Win32.GetCursorPos(out cursor);
                double x = Num(a, "x", cursor.X), y = Num(a, "y", cursor.Y);
                if (Str(a, "delivery") != "borrow" && !Busy() && mods.Count == 0)
                {
                    PointerTarget t = TargetAt(x, y);
                    if (t != null && !t.Desktop && !t.Deaf)
                    {
                        Dictionary<string, object> delivery = BackgroundDelivery(t);
                        FocusForClick(t, delivery);
                        IntPtr l = ClientLParam(t.Hwnd, x, y);
                        if (Post(t.Hwnd, 0x0200, HeldMask(), l))
                        {
                            Thread.Sleep(8);
                            HeldButtons.Add(button);
                            Post(t.Hwnd, ButtonMessage(button, true, false), HeldMask(), l);
                            heldPress = new HeldPress();
                            heldPress.Target = t;
                            heldPress.Button = button;
                            heldPress.X = x;
                            heldPress.Y = y;
                            d["held"] = Point(x, y);
                            d["held_buttons"] = new List<string>(HeldButtons);
                            d["delivery"] = delivery;
                            return d;
                        }
                    }
                }
                BeginBorrow();
                MoveTo(x, y);
                Thread.Sleep(8);
                PressModifiers(mods, true);
                foreach (string mod in mods) if (!borrowedModifiers.Contains(mod)) borrowedModifiers.Add(mod);
                Send(MouseInput(0, 0, 0, ButtonFlag(button, true)));
                HeldButtons.Add(button);
                Dictionary<string, object> borrowed = new Dictionary<string, object>();
                borrowed["mode"] = "borrowed";
                d["held"] = Point(x, y);
                d["held_buttons"] = new List<string>(HeldButtons);
                d["delivery"] = borrowed;
                return d;
            }
            if (heldPress != null && heldPress.Button == button)
            {
                HeldPress press = heldPress;
                heldPress = null;
                HeldButtons.Remove(button);
                Post(press.Target.Hwnd, ButtonMessage(button, false, false), HeldMask(), ClientLParam(press.Target.Hwnd, press.X, press.Y));
                d["released"] = Point(press.X, press.Y);
                d["held_buttons"] = new List<string>(HeldButtons);
                d["delivery"] = BackgroundDelivery(press.Target);
                return d;
            }
            Win32.POINT at;
            Win32.GetCursorPos(out at);
            bool restored = false;
            try
            {
                Send(MouseInput(0, 0, 0, ButtonFlag(button, false)));
            }
            finally
            {
                HeldButtons.Remove(button);
                if (HeldButtons.Count == 0 && borrowedModifiers.Count > 0)
                {
                    List<string> held = new List<string>(borrowedModifiers);
                    borrowedModifiers.Clear();
                    PressModifiers(held, false);
                }
                if (HeldButtons.Count == 0) restored = EndBorrow(at.X, at.Y);
            }
            d["released"] = Point(at.X, at.Y);
            d["held_buttons"] = new List<string>(HeldButtons);
            d["delivery"] = BorrowedDelivery(restored, null);
            return d;
        }

        // ---------------------------------------------------------------- apps & windows

        public static List<WindowInfo> TopWindows()
        {
            List<WindowInfo> list = new List<WindowInfo>();
            Win32.EnumWindowsProc callback = delegate (IntPtr hwnd, IntPtr lParam)
            {
                if (!Win32.IsWindowVisible(hwnd)) return true;
                try
                {
                    int cloaked;
                    if (Win32.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                }
                catch { }
                WindowInfo info = new WindowInfo();
                info.Hwnd = hwnd;
                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                info.Pid = (int)pid;
                int length = Win32.GetWindowTextLength(hwnd);
                StringBuilder title = new StringBuilder(length + 2);
                Win32.GetWindowText(hwnd, title, title.Capacity);
                info.Title = title.ToString();
                StringBuilder cls = new StringBuilder(256);
                Win32.GetClassName(hwnd, cls, cls.Capacity);
                info.ClassName = cls.ToString();
                Win32.GetWindowRect(hwnd, out info.Rect);
                info.Minimized = Win32.IsIconic(hwnd);
                list.Add(info);
                return true;
            };
            Win32.EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return list;
        }

        public static int ForegroundPid()
        {
            IntPtr hwnd = Win32.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return 0;
            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            return (int)pid;
        }

        private static string ProcessName(int pid)
        {
            try { return Process.GetProcessById(pid).ProcessName + ".exe"; }
            catch { return ""; }
        }

        private static Dictionary<string, object> AppInfo(int pid, string name)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["pid"] = pid;
            d["name"] = name;
            d["bundle_id"] = "";
            return d;
        }

        private static string Stem(string name)
        {
            string lower = (name ?? "").ToLowerInvariant();
            return lower.EndsWith(".exe") ? lower.Substring(0, lower.Length - 4) : lower;
        }

        public static Dictionary<string, object> FindApp(object target)
        {
            if (target == null) return null;
            List<WindowInfo> windows = TopWindows();
            string text = Convert.ToString(target, CultureInfo.InvariantCulture).Trim();
            int pid;
            if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
            {
                string name = ProcessName(pid);
                bool hasWindow = false;
                foreach (WindowInfo w in windows) if (w.Pid == pid) { hasWindow = true; break; }
                return name.Length > 0 || hasWindow ? AppInfo(pid, name) : null;
            }

            string wanted = Stem(text);
            List<int> order = new List<int>();
            HashSet<int> seen = new HashSet<int>();
            foreach (WindowInfo w in windows) if (w.Pid > 0 && seen.Add(w.Pid)) order.Add(w.Pid);
            Dictionary<int, string> names = new Dictionary<int, string>();
            foreach (Process p in Process.GetProcesses())
            {
                try
                {
                    names[p.Id] = p.ProcessName + ".exe";
                    if (seen.Add(p.Id)) order.Add(p.Id);
                }
                catch { }
            }
            foreach (int id in order)
            {
                string name;
                if (names.TryGetValue(id, out name) && Stem(name) == wanted) return AppInfo(id, name);
            }
            foreach (int id in order)
            {
                string name;
                if (names.TryGetValue(id, out name) && wanted.Length > 0 && Stem(name).Contains(wanted)) return AppInfo(id, name);
            }
            string lowered = text.ToLowerInvariant();
            foreach (WindowInfo w in windows)
            {
                if (!string.IsNullOrEmpty(w.Title) && w.Title.ToLowerInvariant().Contains(lowered)) return AppInfo(w.Pid, ProcessName(w.Pid));
            }
            return null;
        }

        public static List<object> AppWindows(int pid)
        {
            IntPtr foreground = Win32.GetForegroundWindow();
            List<object> list = new List<object>();
            foreach (WindowInfo w in TopWindows())
            {
                if (w.Pid != pid) continue;
                int width = w.Rect.Right - w.Rect.Left, height = w.Rect.Bottom - w.Rect.Top;
                if (width <= 0 || height <= 0) continue;
                Dictionary<string, object> d = Rect(w.Rect.Left, w.Rect.Top, width, height);
                d["title"] = w.Title;
                d["active"] = w.Hwnd == foreground;
                d["minimized"] = w.Minimized;
                d["handle"] = w.Hwnd.ToInt64();
                list.Add(d);
            }
            return list;
        }

        // ---------------------------------------------------------------- UI Automation

        private static Dictionary<string, object> BatchDesktopState(Dictionary<string, object> args)
        {
            IntPtr hwnd = Win32.GetForegroundWindow();
            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            var result = new Dictionary<string, object> { { "pid", (int)pid }, { "window", null }, { "modal", false } };
            if (args.ContainsKey("x") && args.ContainsKey("y"))
            {
                var point = new Win32.POINT { X = Int(args, "x", 0), Y = Int(args, "y", 0) };
                IntPtr hit = Win32.GetAncestor(Win32.WindowFromPoint(point), 2);
                result["hit_window_id"] = hit.ToInt64().ToString(CultureInfo.InvariantCulture);
            }
            if (hwnd == IntPtr.Zero) return result;
            Win32.RECT rect;
            if (!Win32.GetWindowRect(hwnd, out rect)) return result;
            int length = Win32.GetWindowTextLength(hwnd);
            var title = new StringBuilder(length + 2);
            Win32.GetWindowText(hwnd, title, title.Capacity);
            result["window"] = new Dictionary<string, object> {
                { "id", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture) }, { "title", title.ToString() },
                { "frame", Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top) }
            };
            if ((int)pid != Int(args, "pid", 0)) return result;
            var window = AutomationElement.FromHandle(hwnd);
            if (window == null)
            {
                result["window"] = null;
                return result;
            }
            object pattern;
            if (window.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) result["modal"] = ((WindowPattern)pattern).Current.IsModal;
            if (window.Current.ClassName == "#32770") result["modal"] = true;
            var focus = AutomationElement.FocusedElement;
            if (focus != null && focus.Current.ProcessId == (int)pid)
            {
                bool password = false;
                try { password = focus.Current.IsPassword; } catch { }
                Dictionary<string, object> focused = new Dictionary<string, object> {
                    { "role", RoleOf(focus) ?? "" }, { "name", NameOf(focus) ?? "" },
                    { "automation_id", focus.Current.AutomationId }, { "protected", password }
                };
                if (password && HasPasswordText(focus)) focused["password_present"] = true;
                result["focused"] = focused;
            }
            return result;
        }

        private static string RoleOf(AutomationElement element)
        {
            try
            {
                string name = element.Current.ControlType.ProgrammaticName ?? "";
                if (name.StartsWith("ControlType.")) name = name.Substring("ControlType.".Length);
                return name.Length > 0 ? name + "Control" : null;
            }
            catch { return null; }
        }

        private static string NameOf(AutomationElement element)
        {
            try
            {
                string name = element.Current.Name;
                return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
            }
            catch { return null; }
        }

        private static Dictionary<string, object> FrameOf(AutomationElement element)
        {
            try
            {
                System.Windows.Rect r = element.Current.BoundingRectangle;
                if (r.IsEmpty || double.IsInfinity(r.Width) || r.Width <= 0 || r.Height <= 0) return null;
                return Rect(r.X, r.Y, r.Width, r.Height);
            }
            catch { return null; }
        }

        private static bool MatchName(string query, string candidate)
        {
            string q = (query ?? "").Trim().ToLowerInvariant();
            if (q.Length == 0) return true;
            string c = (candidate ?? "").Trim().ToLowerInvariant();
            return c == q || c.StartsWith(q) || c.Contains(q);
        }

        private static Dictionary<string, object> Describe(AutomationElement element, string role, string name, Dictionary<string, object> frame)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["role"] = role ?? "";
            d["name"] = name ?? "";
            d["frame"] = frame;
            if (frame != null)
            {
                double x = Convert.ToDouble(frame["x"]), y = Convert.ToDouble(frame["y"]);
                double w = Convert.ToDouble(frame["width"]), h = Convert.ToDouble(frame["height"]);
                d["center"] = Point(x + w / 2, y + h / 2);
            }
            try
            {
                string automationId = element.Current.AutomationId;
                if (!string.IsNullOrEmpty(automationId)) d["automation_id"] = automationId;
                if (!element.Current.IsEnabled) d["enabled"] = false;
                if (element.Current.IsPassword && element.Current.ControlType == ControlType.Edit)
                {
                    d["protected"] = true;
                    if (HasPasswordText(element)) d["password_present"] = true;
                }
            }
            catch { }
            return d;
        }

        private static int Walk(AutomationElement root, string role, string name, DateTime deadline, int maxDepth, int maxNodes, List<object> results, ref bool truncated)
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            Queue<KeyValuePair<AutomationElement, int>> queue = new Queue<KeyValuePair<AutomationElement, int>>();
            queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
            int visited = 0;
            while (queue.Count > 0)
            {
                if (visited >= maxNodes || DateTime.UtcNow > deadline)
                {
                    truncated = true;
                    break;
                }
                KeyValuePair<AutomationElement, int> item = queue.Dequeue();
                AutomationElement element = item.Key;
                visited++;
                string elementRole = RoleOf(element);
                if (elementRole != null && (role == null || string.Equals(elementRole, role, StringComparison.OrdinalIgnoreCase)))
                {
                    string elementName = NameOf(element);
                    if (name == null || MatchName(name, elementName))
                    {
                        Dictionary<string, object> frame = FrameOf(element);
                        if (frame != null) results.Add(Describe(element, elementRole, elementName, frame));
                    }
                }
                if (item.Value >= maxDepth) continue;
                try
                {
                    AutomationElement child = walker.GetFirstChild(element);
                    while (child != null)
                    {
                        queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
                        child = walker.GetNextSibling(child);
                    }
                }
                catch { }
            }
            return visited;
        }

        private static List<object> Dedupe(List<object> items)
        {
            HashSet<string> seen = new HashSet<string>();
            List<object> unique = new List<object>();
            foreach (object o in items)
            {
                Dictionary<string, object> d = (Dictionary<string, object>)o;
                Dictionary<string, object> c = d.ContainsKey("center") ? d["center"] as Dictionary<string, object> : null;
                string key = d["role"] + "|" + d["name"] + "|" + (c != null ? c["x"] + "," + c["y"] : "");
                if (seen.Add(key)) unique.Add(d);
            }
            return unique;
        }

        private static Dictionary<string, object> UiFind(Dictionary<string, object> a)
        {
            int pid = Int(a, "pid", 0);
            string role = Str(a, "role");
            string name = Str(a, "name");
            string windowTitle = Str(a, "window_title");
            DateTime deadline = DateTime.UtcNow.AddSeconds(Math.Max(0.5, Num(a, "timeout", 5)));
            int maxDepth = Int(a, "max_depth", 15), maxNodes = Int(a, "max_nodes", 8000);
            List<object> results = new List<object>();
            bool truncated = false;
            int visited = 0, roots = 0;
            string wantedTitle = windowTitle == null ? null : windowTitle.Trim().ToLowerInvariant();
            foreach (WindowInfo w in TopWindows())
            {
                if (w.Pid != pid) continue;
                if (wantedTitle != null && !(w.Title ?? "").ToLowerInvariant().Contains(wantedTitle)) continue;
                AutomationElement root;
                try { root = AutomationElement.FromHandle(w.Hwnd); }
                catch { continue; }
                if (root == null) continue;
                roots++;
                visited += Walk(root, role, name, deadline, maxDepth, Math.Max(1, maxNodes - visited), results, ref truncated);
                if (truncated) break;
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["matches"] = Dedupe(results);
            d["visited"] = visited;
            d["roots"] = roots;
            d["truncated"] = truncated;
            return d;
        }

        private static Dictionary<string, object> Dock(string name)
        {
            List<object> icons = new List<object>();
            bool truncated = false;
            foreach (WindowInfo w in TopWindows())
            {
                if (w.ClassName != "Shell_TrayWnd" && w.ClassName != "Shell_SecondaryTrayWnd") continue;
                AutomationElement root;
                try { root = AutomationElement.FromHandle(w.Hwnd); }
                catch { continue; }
                List<object> hits = new List<object>();
                Walk(root, "ButtonControl", name, DateTime.UtcNow.AddSeconds(5), 8, 8000, hits, ref truncated);
                foreach (object o in hits)
                {
                    Dictionary<string, object> hit = (Dictionary<string, object>)o;
                    if (Convert.ToString(hit["name"]).Length > 0) icons.Add(hit);
                }
            }
            List<object> unique = Dedupe(icons);
            unique.Sort(delegate (object l, object r)
            {
                double lx = Convert.ToDouble(((Dictionary<string, object>)((Dictionary<string, object>)l)["center"])["x"]);
                double rx = Convert.ToDouble(((Dictionary<string, object>)((Dictionary<string, object>)r)["center"])["x"]);
                return lx.CompareTo(rx);
            });
            return Wrap("icons", unique);
        }

        private static Dictionary<string, object> Menubar(string menu)
        {
            IntPtr hwnd = Win32.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) throw new WorkerException("not_found", "No foreground window.");
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            List<object> hits = new List<object>();
            bool truncated = false;
            Walk(root, "MenuItemControl", null, DateTime.UtcNow.AddSeconds(5), 6, 8000, hits, ref truncated);
            List<object> items = new List<object>();
            foreach (object o in hits)
            {
                Dictionary<string, object> hit = (Dictionary<string, object>)o;
                string itemName = Convert.ToString(hit["name"]);
                if (itemName.Length == 0) continue;
                if (!string.IsNullOrEmpty(menu) && !itemName.ToLowerInvariant().Contains(menu.ToLowerInvariant())) continue;
                Dictionary<string, object> item = new Dictionary<string, object>();
                item["menu"] = itemName;
                item["frame"] = hit["frame"];
                item["center"] = hit["center"];
                items.Add(item);
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["app_pid"] = ForegroundPid();
            d["items"] = items;
            return d;
        }

        private static Dictionary<string, object> HitTest(double x, double y)
        {
            AutomationElement element;
            try { element = AutomationElement.FromPoint(new System.Windows.Point(x, y)); }
            catch (Exception error) { throw new WorkerException("not_found", "No accessible element at (" + x + ", " + y + "): " + error.Message); }
            if (element == null) throw new WorkerException("not_found", "No accessible element at (" + x + ", " + y + ").");
            string windowTitle = null;
            try
            {
                TreeWalker walker = TreeWalker.ControlViewWalker;
                AutomationElement current = element;
                AutomationElement parent = walker.GetParent(current);
                while (parent != null && parent != AutomationElement.RootElement)
                {
                    current = parent;
                    parent = walker.GetParent(current);
                }
                windowTitle = NameOf(current);
            }
            catch { }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["element"] = Describe(element, RoleOf(element), NameOf(element), FrameOf(element));
            d["window_title"] = windowTitle;
            try { d["pid"] = element.Current.ProcessId; } catch { }
            return d;
        }

        // ---------------------------------------------------------------- password

        const int PasswordFieldLimit = 32;
        const int LegacyValuePropertyId = 30093;
        const int ValuePropertyId = 30045;
        const int AriaPropertiesPropertyId = 30102;
        const int LandmarkTypePropertyId = 30157;
        const int FormLandmarkTypeId = 80001;
        static readonly Guid WintrustVerify = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        static readonly object PasswordLock = new object();
        static Dictionary<string, PasswordBinding> PasswordFields = new Dictionary<string, PasswordBinding>();

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, WinTrustData data);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        class WinTrustFileInfo
        {
            public uint StructSize;
            public IntPtr PathPtr;
            public IntPtr File;
            public IntPtr KnownSubject;

            public WinTrustFileInfo(string path)
            {
                StructSize = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo));
                PathPtr = Marshal.StringToCoTaskMemUni(path);
            }

            public void Free()
            {
                if (PathPtr == IntPtr.Zero) return;
                Marshal.FreeCoTaskMem(PathPtr);
                PathPtr = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        class WinTrustData
        {
            public uint StructSize;
            public IntPtr PolicyCallbackData;
            public IntPtr SIPClientData;
            public uint UIChoice;
            public uint RevocationChecks;
            public uint UnionChoice;
            public IntPtr FileInfoPtr;
            public uint StateAction;
            public IntPtr StateData;
            public IntPtr URLReference;
            public uint ProvFlags;
            public uint UIContext;

            public WinTrustData(IntPtr fileInfo)
            {
                StructSize = (uint)Marshal.SizeOf(typeof(WinTrustData));
                UIChoice = 2;
                UnionChoice = 1;
                FileInfoPtr = fileInfo;
                StateAction = 1;
                ProvFlags = 0x1000;
            }
        }

        class PasswordContext
        {
            public AutomationElement Window;
            public string Origin;
            public AutomationElement LoginScope;
        }

        class WebLogin
        {
            public string Origin;
            public AutomationElement AccountField;
            public string Account;
        }

        class PasswordBinding
        {
            public AutomationElement Element;
            public AutomationElement Window;
            public string Origin;
            public string LoginOrigin;
            public int Pid;
            public long StartTicks;
            public DateTime Expires;
        }

        public static string FieldToken(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            StringBuilder builder = new StringBuilder(value.Length);
            foreach (char c in value.ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(c)) builder.Append(c);
            }
            return builder.ToString();
        }

        public static string WebOrigin(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            Uri uri;
            if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out uri)) return null;
            string scheme = uri.Scheme.ToLowerInvariant();
            if (scheme != "https" && scheme != "http") return null;
            if (!string.IsNullOrEmpty(uri.UserInfo)) return null;
            if (string.IsNullOrEmpty(uri.Host)) return null;
            string host = uri.IdnHost.ToLowerInvariant();
            if (host.IndexOf(':') >= 0) host = "[" + host + "]";
            string origin = scheme + "://" + host;
            if (!uri.IsDefaultPort) origin += ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
            return origin;
        }

        static bool PublisherIs(string subject, string organization)
        {
            if (string.IsNullOrEmpty(subject)) return false;
            if (subject.IndexOf("O=\"" + organization + "\"", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            string token = "O=" + organization;
            int index = 0;
            while (index < subject.Length)
            {
                int found = subject.IndexOf(token, index, StringComparison.OrdinalIgnoreCase);
                if (found < 0) return false;
                int end = found + token.Length;
                if (end >= subject.Length || subject[end] == ',' || subject[end] == ';') return true;
                index = end;
            }
            return false;
        }

        public static bool TrustedBrowserPublisher(string path, string subject, bool signatureTrusted)
        {
            if (!signatureTrusted || string.IsNullOrEmpty(path) || string.IsNullOrEmpty(subject)) return false;
            string file = Path.GetFileName(path);
            if (file.Equals("chrome.exe", StringComparison.OrdinalIgnoreCase))
                return PublisherIs(subject, "Google LLC") || PublisherIs(subject, "Google Inc");
            if (file.Equals("msedge.exe", StringComparison.OrdinalIgnoreCase))
                return PublisherIs(subject, "Microsoft Corporation");
            return false;
        }

        public static bool PasswordLabelAllowed(string automationId, string name, string help, string aria)
        {
            if (aria != null && aria.Length > 4000) return false;
            string[] blocked = new string[] {
                "newpassword", "confirmpassword", "repeatpassword", "onetimecode", "verificationcode", "passcode"
            };
            string[] values = new string[] { automationId, name, help, aria };
            foreach (string value in values)
            {
                string token = FieldToken(value);
                if (token.Length == 0) continue;
                if (token == "pin" || token == "otp") return false;
                foreach (string word in blocked)
                {
                    if (token.Contains(word)) return false;
                }
            }
            return true;
        }

        public static bool AccountFieldMatch(string automationId, string name, string help)
        {
            string[] identifiers = new string[] {
                "username", "useremail", "email", "emailaddress", "login", "loginfmt",
                "loginusername", "loginemail", "identifierid", "account", "accountname"
            };
            string id = FieldToken(automationId);
            foreach (string item in identifiers)
            {
                if (id == item) return true;
            }
            string[] labels = new string[] {
                "username", "email", "emailaddress", "emailorusername", "usernameoremail",
                "accountname", "yourusername", "youremail", "youremailaddress"
            };
            string nameToken = FieldToken(name);
            string helpToken = FieldToken(help);
            foreach (string item in labels)
            {
                if (nameToken == item || helpToken == item) return true;
            }
            return false;
        }

        public static bool AuthenticodeTrusted(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            WinTrustFileInfo info = new WinTrustFileInfo(path);
            IntPtr infoPtr = IntPtr.Zero;
            try
            {
                infoPtr = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                Marshal.StructureToPtr(info, infoPtr, false);
                WinTrustData data = new WinTrustData(infoPtr);
                int result = WinVerifyTrust(IntPtr.Zero, WintrustVerify, data);
                data.StateAction = 2;
                WinVerifyTrust(IntPtr.Zero, WintrustVerify, data);
                return result == 0;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (infoPtr != IntPtr.Zero)
                {
                    Marshal.DestroyStructure(infoPtr, typeof(WinTrustFileInfo));
                    Marshal.FreeCoTaskMem(infoPtr);
                }
                info.Free();
            }
        }

        static string PropString(AutomationElement element, int id)
        {
            try
            {
                object value = element.GetCurrentPropertyValue(AutomationProperty.LookupById(id));
                if (value == null || object.Equals(value, AutomationElement.NotSupported)) return null;
                string text = value as string;
                if (text == null) return null;
                text = text.Trim();
                return text.Length == 0 ? null : text;
            }
            catch { return null; }
        }

        static int PropInt(AutomationElement element, int id)
        {
            try
            {
                object value = element.GetCurrentPropertyValue(AutomationProperty.LookupById(id));
                if (value == null || object.Equals(value, AutomationElement.NotSupported)) return 0;
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch { return 0; }
        }

        static string DocumentOrigin(AutomationElement element)
        {
            string origin = WebOrigin(PropString(element, LegacyValuePropertyId));
            if (origin != null) return origin;
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern != null)
            {
                try
                {
                    origin = WebOrigin(((ValuePattern)pattern).Current.Value);
                    if (origin != null) return origin;
                }
                catch { }
            }
            return WebOrigin(PropString(element, ValuePropertyId));
        }

        static bool IsPasswordEdit(AutomationElement element)
        {
            try { return element != null && element.Current.ControlType == ControlType.Edit && element.Current.IsPassword; }
            catch { return false; }
        }

        static IntPtr NativePasswordHwnd(AutomationElement element)
        {
            try
            {
                int raw = element.Current.NativeWindowHandle;
                if (raw == 0) return IntPtr.Zero;
                IntPtr hwnd = new IntPtr(raw);
                StringBuilder cls = new StringBuilder(64);
                if (Win32.GetClassName(hwnd, cls, cls.Capacity) <= 0 || cls.ToString() != "Edit") return IntPtr.Zero;
                if ((Win32.GetWindowLong(hwnd, -16) & 0x20) == 0) return IntPtr.Zero;
                return hwnd;
            }
            catch { return IntPtr.Zero; }
        }

        static bool HasPasswordText(AutomationElement element)
        {
            try
            {
                IntPtr hwnd = NativePasswordHwnd(element);
                if (hwnd != IntPtr.Zero)
                {
                    IntPtr result;
                    IntPtr sent = Win32.SendMessageTimeout(hwnd, 0x000E, IntPtr.Zero, IntPtr.Zero, 2, 200, out result);
                    if (sent != IntPtr.Zero) return result.ToInt64() > 0;
                }
                object pattern;
                if (!element.TryGetCurrentPattern(TextPattern.Pattern, out pattern) || pattern == null) return false;
                TextPattern text = (TextPattern)pattern;
                TextPatternRange range = text.DocumentRange;
                if (range == null) return false;
                if (range.CompareEndpoints(TextPatternRangeEndpoint.Start, range, TextPatternRangeEndpoint.End) != 0) return true;
                TextPatternRange[] selection = text.GetSelection();
                if (selection == null) return false;
                foreach (TextPatternRange item in selection)
                {
                    if (item == null) continue;
                    if (item.CompareEndpoints(TextPatternRangeEndpoint.Start, item, TextPatternRangeEndpoint.End) != 0) return true;
                    if (range.CompareEndpoints(TextPatternRangeEndpoint.Start, item, TextPatternRangeEndpoint.Start) != 0) return true;
                }
            }
            catch { }
            return false;
        }

        static bool CanFill(AutomationElement element)
        {
            try { if (!element.Current.IsEnabled) return false; }
            catch { return false; }
            if (NativePasswordHwnd(element) != IntPtr.Zero) return true;
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern != null)
            {
                try { return !((ValuePattern)pattern).Current.IsReadOnly; }
                catch { return false; }
            }
            return false;
        }

        static bool SetElementText(AutomationElement element, string value)
        {
            IntPtr hwnd = NativePasswordHwnd(element);
            if (hwnd != IntPtr.Zero)
            {
                try
                {
                    IntPtr result;
                    if (Win32.SendMessageTimeoutW(hwnd, 0x000C, IntPtr.Zero, value, 2, 1000, out result) != IntPtr.Zero) return true;
                }
                catch { }
            }
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern != null)
            {
                try
                {
                    ValuePattern valuePattern = (ValuePattern)pattern;
                    if (valuePattern.Current.IsReadOnly) return false;
                    valuePattern.SetValue(value);
                    return true;
                }
                catch { return false; }
            }
            return false;
        }

        static string ReadValue(AutomationElement element)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || pattern == null) return null;
            try { return ((ValuePattern)pattern).Current.Value; }
            catch { return null; }
        }

        static PasswordContext PasswordContextOf(AutomationElement field)
        {
            if (!IsPasswordEdit(field)) return null;
            string origin = null;
            AutomationElement scope = null;
            AutomationElement form = null;
            bool sameOrigin = true;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            AutomationElement node;
            try { node = walker.GetParent(field); }
            catch { return null; }
            for (int i = 0; i < 64 && node != null && node != AutomationElement.RootElement; i++)
            {
                ControlType type;
                try { type = node.Current.ControlType; }
                catch { return null; }
                if (type == ControlType.Window)
                {
                    PasswordContext context = new PasswordContext();
                    context.Window = node;
                    context.Origin = origin;
                    context.LoginScope = sameOrigin ? scope : null;
                    return context;
                }
                if (origin == null && form == null && PropInt(node, LandmarkTypePropertyId) == FormLandmarkTypeId) form = node;
                if (type == ControlType.Document)
                {
                    string verified = DocumentOrigin(node);
                    if (verified == null) return null;
                    if (origin != null) sameOrigin = sameOrigin && origin == verified;
                    else
                    {
                        origin = verified;
                        if (verified.StartsWith("https://", StringComparison.Ordinal)) scope = form ?? node;
                    }
                }
                try { node = walker.GetParent(node); }
                catch { return null; }
            }
            return null;
        }

        static void CollectChildren(AutomationElement parent, Queue<AutomationElement> nodes)
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            AutomationElement child;
            try { child = walker.GetFirstChild(parent); }
            catch { return; }
            while (child != null)
            {
                nodes.Enqueue(child);
                try { child = walker.GetNextSibling(child); }
                catch { return; }
            }
        }

        static WebLogin WebLoginOf(AutomationElement password, PasswordContext context)
        {
            if (context == null || context.LoginScope == null || context.Origin == null) return null;
            if (!PasswordLabelAllowed(
                PropString(password, AutomationElement.AutomationIdProperty.Id),
                NameOf(password),
                PropString(password, AutomationElement.HelpTextProperty.Id),
                PropString(password, AriaPropertiesPropertyId))) return null;
            Queue<AutomationElement> nodes = new Queue<AutomationElement>();
            CollectChildren(context.LoginScope, nodes);
            List<AutomationElement> accounts = new List<AutomationElement>();
            bool found = false;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(600);
            for (int seen = 0; seen < 240 && nodes.Count > 0; seen++)
            {
                if (DateTime.UtcNow > deadline) return null;
                AutomationElement node = nodes.Dequeue();
                ControlType type;
                try { type = node.Current.ControlType; }
                catch { return null; }
                if (type == ControlType.Document) continue;
                if (type == ControlType.Edit)
                {
                    if (IsPasswordEdit(node))
                    {
                        if (found || !Automation.Compare(node, password)) return null;
                        found = true;
                    }
                    else if (!found && AccountFieldMatch(
                        PropString(node, AutomationElement.AutomationIdProperty.Id),
                        NameOf(node),
                        PropString(node, AutomationElement.HelpTextProperty.Id)))
                    {
                        accounts.Add(node);
                    }
                }
                CollectChildren(node, nodes);
            }
            if (!found) return null;
            WebLogin login = new WebLogin();
            login.Origin = context.Origin;
            if (accounts.Count == 1)
            {
                string value = ReadValue(accounts[0]);
                if (value != null)
                {
                    login.AccountField = accounts[0];
                    login.Account = value;
                }
            }
            return login;
        }

        static bool TrustedBrowserProcess(int pid)
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    string path = process.MainModule.FileName;
                    return TrustedBrowserPublisher(path, X509Certificate.CreateFromSignedFile(path).Subject, AuthenticodeTrusted(path));
                }
            }
            catch { return false; }
        }

        static long StartTicks(int pid)
        {
            using (Process process = Process.GetProcessById(pid))
            {
                return process.StartTime.ToUniversalTime().Ticks;
            }
        }

        static string AppDisplayName(int pid)
        {
            using (Process process = Process.GetProcessById(pid))
            {
                try
                {
                    string description = process.MainModule.FileVersionInfo.FileDescription;
                    if (!string.IsNullOrWhiteSpace(description)) return description.Trim();
                }
                catch { }
                return process.ProcessName;
            }
        }

        static PasswordBinding RemovePassword(string token)
        {
            lock (PasswordLock)
            {
                PasswordBinding binding;
                if (!PasswordFields.TryGetValue(token, out binding)) return null;
                PasswordFields.Remove(token);
                return binding;
            }
        }

        static void AddPasswordCandidates(List<AutomationElement> list, AutomationElement element, int pid)
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            AutomationElement node = element;
            for (int i = 0; i < 3 && node != null && node != AutomationElement.RootElement; i++)
            {
                try { if (node.Current.ProcessId == pid) list.Add(node); }
                catch { return; }
                try { node = walker.GetParent(node); }
                catch { return; }
            }
        }

        static bool FrameContains(AutomationElement element, bool hasPoint, double x, double y)
        {
            if (!hasPoint) return true;
            try
            {
                System.Windows.Rect rect = element.Current.BoundingRectangle;
                if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) return false;
                return rect.Contains(new System.Windows.Point(x, y));
            }
            catch { return false; }
        }

        static Dictionary<string, object> BindPassword(AutomationElement field, int pid, PasswordContext context)
        {
            System.Windows.Rect rect = field.Current.BoundingRectangle;
            string token = Guid.NewGuid().ToString();
            DateTime now = DateTime.UtcNow;
            WebLogin login = TrustedBrowserProcess(pid) ? WebLoginOf(field, context) : null;
            string appName = AppDisplayName(pid);
            PasswordBinding binding = new PasswordBinding();
            binding.Element = field;
            binding.Window = context.Window;
            binding.Origin = context.Origin;
            binding.LoginOrigin = login == null ? null : login.Origin;
            binding.Pid = pid;
            binding.StartTicks = StartTicks(pid);
            binding.Expires = now.AddSeconds(305);
            lock (PasswordLock)
            {
                List<string> stale = new List<string>();
                foreach (KeyValuePair<string, PasswordBinding> entry in PasswordFields)
                {
                    if (entry.Value.Expires <= now) stale.Add(entry.Key);
                }
                foreach (string key in stale) PasswordFields.Remove(key);
                while (PasswordFields.Count >= PasswordFieldLimit)
                {
                    string oldest = null;
                    DateTime expiry = DateTime.MaxValue;
                    foreach (KeyValuePair<string, PasswordBinding> entry in PasswordFields)
                    {
                        if (entry.Value.Expires < expiry)
                        {
                            expiry = entry.Value.Expires;
                            oldest = entry.Key;
                        }
                    }
                    if (oldest == null) break;
                    PasswordFields.Remove(oldest);
                }
                PasswordFields[token] = binding;
            }
            Dictionary<string, object> destination = new Dictionary<string, object>();
            destination["app"] = appName;
            if (context.Origin != null) destination["origin"] = context.Origin;
            Dictionary<string, object> output = new Dictionary<string, object>();
            output["token"] = token;
            output["frame"] = Rect(rect.X, rect.Y, rect.Width, rect.Height);
            output["destination"] = destination;
            if (login != null)
            {
                Dictionary<string, object> metadata = new Dictionary<string, object>();
                metadata["origin"] = login.Origin;
                if (login.Account != null) metadata["account"] = login.Account;
                output["login"] = metadata;
            }
            return output;
        }

        static Dictionary<string, object> PreparePassword(Dictionary<string, object> args)
        {
            int pid = Int(args, "pid", 0);
            if (pid == Process.GetCurrentProcess().Id)
            {
                throw new WorkerException("self_target", "Refusing to read this worker's own UI for ui.prepare_password. Target the other app instead.");
            }
            try
            {
                bool hasPoint = false;
                double x = 0, y = 0;
                if (args != null && args.ContainsKey("x") && args.ContainsKey("y"))
                {
                    x = Num(args, "x", double.NaN);
                    y = Num(args, "y", double.NaN);
                    hasPoint = !double.IsNaN(x) && !double.IsInfinity(x) && !double.IsNaN(y) && !double.IsInfinity(y);
                }
                bool signInFailed = Bool(args, "sign_in_failed", false);
                List<AutomationElement> candidates = new List<AutomationElement>();
                try
                {
                    AutomationElement focused = AutomationElement.FocusedElement;
                    if (focused != null) AddPasswordCandidates(candidates, focused, pid);
                }
                catch { }
                if (hasPoint)
                {
                    AutomationElement hit = ElementAt(x, y);
                    if (hit != null) AddPasswordCandidates(candidates, hit, pid);
                }
                foreach (AutomationElement field in candidates)
                {
                    try
                    {
                        if (field.Current.ProcessId != pid) continue;
                        PasswordContext context = PasswordContextOf(field);
                        if (context == null || context.Window == null) continue;
                        System.Windows.Rect rect = field.Current.BoundingRectangle;
                        if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) continue;
                        if (!FrameContains(field, hasPoint, x, y)) continue;
                        if (!signInFailed && context.Origin != null && HasPasswordText(field))
                        {
                            Dictionary<string, object> present = new Dictionary<string, object>();
                            present["password_present"] = true;
                            return present;
                        }
                        if (!CanFill(field)) continue;
                        return BindPassword(field, pid, context);
                    }
                    catch { }
                }
            }
            catch (WorkerException) { throw; }
            catch { }
            return new Dictionary<string, object>();
        }

        static Dictionary<string, object> Filled(bool ok)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["filled"] = ok;
            return d;
        }

        static Dictionary<string, object> FillPassword(Dictionary<string, object> args)
        {
            try
            {
                string token = Str(args, "token");
                string password = args != null && args.ContainsKey("password") ? args["password"] as string : null;
                if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(password) || password.Length > 4096) return Filled(false);
                PasswordBinding binding = RemovePassword(token);
                if (binding == null || binding.Expires <= DateTime.UtcNow) return Filled(false);
                long ticks;
                try { ticks = StartTicks(binding.Pid); }
                catch { return Filled(false); }
                if (ticks != binding.StartTicks) return Filled(false);
                PasswordContext context = PasswordContextOf(binding.Element);
                if (context == null || context.Origin != binding.Origin || !Automation.Compare(context.Window, binding.Window)) return Filled(false);
                if (!CanFill(binding.Element)) return Filled(false);
                bool requireAccount = Bool(args, "require_account_field", false);
                if (requireAccount && HasPasswordText(binding.Element)) return Filled(false);
                string account = Str(args, "account");
                if (account != null)
                {
                    if (account.Length == 0 || account.Length > 512 || binding.LoginOrigin == null) return Filled(false);
                    WebLogin login = WebLoginOf(binding.Element, context);
                    if (login == null || login.Origin != binding.LoginOrigin) return Filled(false);
                    if (login.AccountField != null && login.Account != null)
                    {
                        if (login.Account.Length == 0)
                        {
                            if (!SetElementText(login.AccountField, account)) return Filled(false);
                            PasswordContext updated = PasswordContextOf(binding.Element);
                            if (updated == null || updated.Origin != binding.Origin || !Automation.Compare(updated.Window, binding.Window)) return Filled(false);
                            WebLogin updatedLogin = WebLoginOf(binding.Element, updated);
                            if (updatedLogin == null || updatedLogin.Origin != binding.LoginOrigin || updatedLogin.Account != account) return Filled(false);
                            if (updatedLogin.AccountField == null || !Automation.Compare(updatedLogin.AccountField, login.AccountField)) return Filled(false);
                        }
                        else if (login.Account != account) return Filled(false);
                    }
                    else if (requireAccount) return Filled(false);
                }
                return Filled(SetElementText(binding.Element, password));
            }
            catch { return Filled(false); }
        }

        static Dictionary<string, object> DiscardPassword(Dictionary<string, object> args)
        {
            string token = Str(args, "token");
            if (!string.IsNullOrEmpty(token)) RemovePassword(token);
            return new Dictionary<string, object>();
        }

        // ---------------------------------------------------------------- screen

        private static Dictionary<string, object> Capture(object[] region, string path)
        {
            if (string.IsNullOrEmpty(path)) throw new WorkerException("invalid_arguments", "path is required");
            int x, y, w, h;
            if (region != null && region.Length == 4)
            {
                x = (int)Math.Round(Convert.ToDouble(region[0], CultureInfo.InvariantCulture));
                y = (int)Math.Round(Convert.ToDouble(region[1], CultureInfo.InvariantCulture));
                w = (int)Math.Round(Convert.ToDouble(region[2], CultureInfo.InvariantCulture));
                h = (int)Math.Round(Convert.ToDouble(region[3], CultureInfo.InvariantCulture));
            }
            else
            {
                x = Win32.GetSystemMetrics(76);
                y = Win32.GetSystemMetrics(77);
                w = Win32.GetSystemMetrics(78);
                h = Win32.GetSystemMetrics(79);
            }
            if (w <= 0 || h <= 0) throw new WorkerException("invalid_arguments", "Capture region must have a positive size.");
            using (Bitmap bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                }
                bitmap.Save(path, ImageFormat.Png);
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["path"] = path;
            d["width"] = w;
            d["height"] = h;
            d["rect"] = Rect(x, y, w, h);
            return d;
        }

        public static Dictionary<string, object> PrepareOcrImage(string path, int maxDimension)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new WorkerException("not_found", "Image not found: " + path);
            Dictionary<string, object> d = new Dictionary<string, object>();
            using (Image image = Image.FromFile(path))
            {
                int w = image.Width, h = image.Height;
                d["width"] = w;
                d["height"] = h;
                int longest = Math.Max(w, h);
                if (maxDimension <= 0 || longest <= maxDimension)
                {
                    d["path"] = path;
                    d["factor"] = 1.0;
                    d["temp"] = false;
                    return d;
                }
                double factor = (double)maxDimension / longest;
                int sw = Math.Max(1, (int)Math.Floor(w * factor)), sh = Math.Max(1, (int)Math.Floor(h * factor));
                string scaled = Path.Combine(Path.GetTempPath(), "jellybot-ocr-" + Guid.NewGuid().ToString("N") + ".png");
                using (Bitmap bitmap = new Bitmap(sw, sh, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(bitmap))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(image, 0, 0, sw, sh);
                    }
                    bitmap.Save(scaled, ImageFormat.Png);
                }
                d["path"] = scaled;
                d["factor"] = (double)sw / w;
                d["temp"] = true;
                return d;
            }
        }
    }
}
'@

$references = @('System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Web.Extensions')

function Import-WorkerTypes {
    $cacheRoot = $env:JELLYBOT_COMPUTER_USE_CACHE
    if (-not $cacheRoot) { $cacheRoot = Join-Path ([IO.Path]::GetTempPath()) 'jellybot-computer-use' }
    $sha = [Security.Cryptography.SHA256]::Create()
    $seed = $source + '|' + [Environment]::Version + '|' + [IntPtr]::Size
    $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($seed)) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
    $dll = Join-Path $cacheRoot "JellyBotComputerUse-$hash.dll"
    if (Test-Path -LiteralPath $dll) {
        try { Add-Type -Path $dll; return } catch { }
    }
    try {
        New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
        Add-Type -TypeDefinition $source -ReferencedAssemblies $references -OutputAssembly $dll -OutputType Library
        Add-Type -Path $dll
    } catch {
        Add-Type -TypeDefinition $source -ReferencedAssemblies $references
    }
}

$script:ocrReady = $false
$script:asTaskGeneric = $null

function Initialize-Ocr {
    if ($script:ocrReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
    $script:asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
        Select-Object -First 1
    $script:ocrReady = $true
}

function Wait-WinRt($operation, [Type]$resultType) {
    $task = $script:asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    return $task.Result
}

function Invoke-Ocr($arguments, $builder) {
    Initialize-Ocr
    $maxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $prepared = [JellyBotComputerUse.Worker]::PrepareOcrImage([string]$arguments['path'], $maxDimension)
    try {
        $engine = $null
        $used = ''
        foreach ($tag in @($arguments['languages'])) {
            if (-not $tag) { continue }
            try {
                $language = New-Object Windows.Globalization.Language ([string]$tag)
                if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) {
                    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
                    if ($engine) { $used = $language.LanguageTag; break }
                }
            } catch { }
        }
        if (-not $engine) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
            if ($engine) { $used = $engine.RecognizerLanguage.LanguageTag }
        }
        if (-not $engine) {
            throw 'No Windows OCR language is installed. Add one under Settings > Time & language > Language & region (with the Optical character recognition feature).'
        }
        $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$prepared['path'])) ([Windows.Storage.StorageFile])
        $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        } finally {
            $stream.Dispose()
        }
        $builder.Begin([double]$prepared['factor'], [int]$prepared['width'], [int]$prepared['height'], [string]$used)
        foreach ($line in $result.Lines) {
            $builder.BeginLine([string]$line.Text)
            foreach ($word in $line.Words) {
                $rect = $word.BoundingRect
                $builder.AddWord([string]$word.Text, [double]$rect.X, [double]$rect.Y, [double]$rect.Width, [double]$rect.Height)
            }
        }
        $builder.End()
    } finally {
        if ($prepared['temp']) { Remove-Item -LiteralPath ([string]$prepared['path']) -Force -ErrorAction SilentlyContinue }
    }
}

Import-WorkerTypes
[JellyBotComputerUse.Worker]::Init()
[JellyBotComputerUse.Worker]::InitTimers()
[JellyBotComputerUse.Worker]::StartPointerHook()

$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$writer = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$writer.AutoFlush = $true
$writer.WriteLine([JellyBotComputerUse.Worker]::ReadyLine())

while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $response = [JellyBotComputerUse.Worker]::HandleLine($line)
    if ($response -eq '') {
        $id = [JellyBotComputerUse.Worker]::PendingId
        try {
            $builder = New-Object JellyBotComputerUse.OcrBuilder
            Invoke-Ocr ([JellyBotComputerUse.Worker]::PendingArgs) $builder
            $response = [JellyBotComputerUse.Worker]::Ok($id, $builder.Result)
        } catch {
            $response = [JellyBotComputerUse.Worker]::Fail($id, $_.Exception)
        }
    }
    $writer.WriteLine($response)
}
