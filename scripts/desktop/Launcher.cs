// Windows-only GUI shell. .NET Framework and Chromium are already used by the
// computer/browser tools; this launcher adds no npm, NuGet or WebView runtime.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SakuraCode.Desktop
{
    internal sealed class Options
    {
        public string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SakuraCode", "Desktop");
        public string Workspace;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--data-dir" || args[i] == "--workspace")
                {
                    string flag = args[i];
                    if (++i == args.Length || !Path.IsPathRooted(args[i])) throw new ArgumentException(flag + " requires an absolute directory path.");
                    if (flag == "--data-dir") options.DataDir = Path.GetFullPath(args[i]);
                    else options.Workspace = Path.GetFullPath(args[i]);
                }
                else throw new ArgumentException("Unknown desktop option: " + args[i]);
            }
            return options;
        }
    }

    internal sealed class DesktopSettings
    {
        public string Workspace { get; set; }
        public string[] RecentWorkspaces { get; set; }
        public string BaseUrl { get; set; }
        public string Model { get; set; }
        public string ProtectedApiKey { get; set; }
        public bool RememberKey { get; set; }
        /// Default parent directory for newly created workspaces ("" = unset).
        public string NewWorkspaceDir { get; set; }
        /// Per-workspace prefs keyed by workspace path: { "sessionDir": …, "agents": […] }.
        public Dictionary<string, Dictionary<string, object>> WorkspacePrefs { get; set; }
        /// Non-secret display preferences, shared across workspaces and random ports.
        public Dictionary<string, object> Appearance { get; set; }
        public Dictionary<string, object> Retry { get; set; }
        public Dictionary<string, object> Updates { get; set; }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            AppContext.SetSwitch("Switch.UseLegacyAccessibilityFeatures", false);
            AppContext.SetSwitch("Switch.UseLegacyAccessibilityFeatures.2", false);
            AppContext.SetSwitch("Switch.UseLegacyAccessibilityFeatures.3", false);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Options options = Options.Parse(args);
                Directory.CreateDirectory(options.DataDir);
                Native.SetCurrentProcessExplicitAppUserModelID("SakuraCode.Desktop");
                string instanceId = Hash(Encoding.UTF8.GetBytes(Path.GetFullPath(options.DataDir).ToUpperInvariant())).Substring(0, 24);
                uint showMessage = Native.RegisterWindowMessage("SakuraCode.Desktop.Show." + instanceId);
                // The launcher never embeds a browser engine: it opens the local
                // workspace in a dedicated app window owned by this process.
                using (var mutex = new Mutex(false, "Local\\SakuraCode.Desktop." + instanceId))
                {
                    bool owned;
                    try { owned = mutex.WaitOne(0); }
                    catch (AbandonedMutexException) { owned = true; }
                    if (!owned)
                    {
                        Native.PostMessage(new IntPtr(0xffff), showMessage, IntPtr.Zero, IntPtr.Zero);
                        return 0;
                    }
                    try { using (var window = new DesktopWindow(options, showMessage)) Application.Run(window); }
                    finally { mutex.ReleaseMutex(); }
                }
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "SakuraCode Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        public static string Hash(byte[] value)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
        }

        public static string FileHash(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        public static string Quote(string value)
        {
            // CommandLineToArgvW-compatible, including paths ending in a backslash.
            return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
        }

        public static void WriteJson(string file, object value)
        {
            string temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
                if (File.Exists(file)) File.Replace(temp, file, null);
                else File.Move(temp, file);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        public static string FindBrowser()
        {
            var paths = new List<string>();
            string explicitPath = Environment.GetEnvironmentVariable("SAKURA_CHROME");
            if (!String.IsNullOrWhiteSpace(explicitPath)) paths.Add(explicitPath.Trim());
            foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            {
                paths.Add(Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe"));
                paths.Add(Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe"));
            }
            foreach (string candidate in paths) if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("未找到 Chrome 或 Microsoft Edge。请先安装其中一种浏览器，再启动 SakuraCode Desktop。");
        }

        public static string ExtractEngine(string dataDir)
        {
            var assembly = Assembly.GetExecutingAssembly();
            Dictionary<string, object> metadata;
            using (var reader = new StreamReader(assembly.GetManifestResourceStream("desktop-build.json"), Encoding.UTF8))
                metadata = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            string expected = (string)metadata["engineSha256"];
            string directory = Path.Combine(dataDir, "runtime", expected);
            Directory.CreateDirectory(directory);
            string exe = Path.Combine(directory, "SakuraCode.Engine.exe");
            if (File.Exists(exe) && FileHash(exe) == expected) return exe;
            string temp = exe + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var resource = assembly.GetManifestResourceStream("SakuraCode.Engine.exe"))
                using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) resource.CopyTo(output);
                if (FileHash(temp) != expected) throw new IOException("内置运行引擎校验失败，请重新获取桌面程序。");
                if (File.Exists(exe)) File.Replace(temp, exe, null);
                else File.Move(temp, exe);
                return exe;
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    internal sealed class DesktopWindow : Form
    {
        private readonly Options options;
        private readonly uint showMessage;
        private readonly System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer { Interval = 500 };
        private readonly System.Windows.Forms.Timer startupAnimation = new System.Windows.Forms.Timer { Interval = 40 };
        private readonly System.Windows.Forms.Timer browserReflow = new System.Windows.Forms.Timer { Interval = 80 };
        private readonly Stopwatch startupClock = Stopwatch.StartNew();
        private readonly TaskCompletionSource<bool> surfaceReady = new TaskCompletionSource<bool>();
        private readonly NotifyIcon tray = new NotifyIcon();
        private readonly Icon appIcon;
        private readonly object logLock = new object();
        private readonly object settingsLock = new object();
        // Launch settings now come from the saved settings file (--workspace
        // overrides it); the setup UI lives in the main page, not here.
        private string workspaceInput = "";
        private string baseUrlInput = "";
        private string modelInput = "";
        private string apiKeyInput = "";
        private bool rememberKeyInput;
        private Process engine;
        private Process browser;
        private StreamWriter engineInput;
        private ProcessJob job;
        private IntPtr browserWindow;
        private uint browserOwnerId;
        private string appTitle = "SakuraCode";
        private CancellationTokenSource launchCancellation;
        private Task launchTask;
        private Task stopTask;
        private bool exiting;
        private bool allowClose;
        private bool busy;
        private bool trayHidden;
        private bool layingOutBrowser;
        private bool browserAttached;
        private bool showingStartup = true;
        private bool startupMotion;
        private string startupStage = "正在准备工作区…";
        private int viewportWidth, viewportHeight, viewportDpi, viewportVersion;
        private FormWindowState trayRestoreState = FormWindowState.Normal;
        private string activeSecret = "";
        private string[] accountSecrets = new string[0];
        private string engineError = "";
        private DesktopSettings settings;

        public DesktopWindow(Options options, uint showMessage)
        {
            this.options = options;
            this.showMessage = showMessage;
            appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Icon = appIcon;
            Text = appTitle;
            Name = "SakuraCodeDesktopHost";
            // Paint the startup animation immediately, before extracting or
            // starting the engine. Chromium remains hidden until its loading
            // page acknowledges readiness on the existing private bridge.
            ShowInTaskbar = true;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(26, 28, 34);
            DoubleBuffered = true;
            StartPosition = FormStartPosition.Manual;
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            MinimumSize = new Size(480, 400);
            ClientSize = new Size(Math.Min(1440, Math.Max(480, work.Width - 64)), Math.Min(960, Math.Max(400, work.Height - 64)));
            Location = new Point(work.Left + (work.Width - Width) / 2, work.Top + (work.Height - Height) / 2);
            LoadSettings();
            BuildTray();
            FormClosing += async delegate(object sender, FormClosingEventArgs e)
            {
                if (!allowClose && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; await ExitAsync(); }
            };
            monitor.Tick += async delegate
            {
                if (busy || exiting || browser == null) return;
                if (Exited(engine))
                {
                    monitor.Stop();
                    MessageBox.Show("本机运行引擎意外退出。\n\n" + engineError + "\n\n请重新启动 SakuraCode Desktop。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    await ExitAsync();
                }
                else if (browserWindow == IntPtr.Zero || !Native.IsWindow(browserWindow) || !Native.IsProcessAlive(browserOwnerId)) await ExitAsync();
                else LayoutBrowser();
            };
            startupMotion = Native.ClientAnimationsEnabled();
            startupAnimation.Tick += delegate { if (showingStartup && startupMotion) Invalidate(); };
            browserReflow.Tick += delegate { browserReflow.Stop(); LayoutBrowser(true); };
            // Async continuations stay on the WinForms thread. No artificial
            // minimum splash duration delays a genuinely ready workspace.
            Shown += async delegate { if (startupMotion) startupAnimation.Start(); await BeginLaunch(); };
        }

        private void StartupStage(string message)
        {
            startupStage = message;
            if (showingStartup) Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (!showingStartup) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var saved = g.Save();
            float scale = DeviceDpi / 96f;
            g.TranslateTransform(ClientSize.Width / 2f, ClientSize.Height / 2f - 26 * scale);
            g.ScaleTransform(scale, scale);
            double phase = startupMotion ? startupClock.Elapsed.TotalSeconds : 0;
            using (var soft = new SolidBrush(Color.FromArgb(42, 35, 43)))
            using (var accent = new SolidBrush(Color.FromArgb(240, 173, 192)))
            using (var border = new Pen(Color.FromArgb(86, 64, 74)))
            using (var title = new SolidBrush(Color.FromArgb(244, 244, 248)))
            using (var muted = new SolidBrush(Color.FromArgb(154, 158, 174)))
            // Graphics already scales the whole surface for DPI. Pixel fonts
            // avoid scaling point-size fonts a second time on HiDPI monitors.
            using (var titleFont = new Font("Microsoft YaHei", 24, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var captionFont = new Font("Segoe UI", 10, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var statusFont = new Font("Microsoft YaHei", 12, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var centered = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var box = new System.Drawing.Drawing2D.GraphicsPath())
            {
                box.AddArc(-40, -80, 48, 48, 180, 90); box.AddArc(-8, -80, 48, 48, 270, 90);
                box.AddArc(-8, -48, 48, 48, 0, 90); box.AddArc(-40, -48, 48, 48, 90, 90); box.CloseFigure();
                g.FillPath(soft, box); g.DrawPath(border, box);
                using (var pulse = new Pen(Color.FromArgb((int)(40 + 36 * (Math.Sin(phase * Math.PI * 1.25) + 1)), 240, 173, 192)))
                    g.DrawEllipse(pulse, -48, -88, 96, 96);
                // Match the Web loading brand: slow orbiting petals and a small
                // flower breath. A zero phase is a fully painted static frame.
                var orbit = g.Save();
                g.TranslateTransform(0, -40);
                g.RotateTransform((float)(phase * 360 / 14));
                for (int i = 0; i < 4; i++)
                {
                    using (var floatingPetal = new SolidBrush(Color.FromArgb(166 - i * 30, 240, 173, 192)))
                        g.FillEllipse(floatingPetal, -3.5f, -64, 7, 11);
                    g.RotateTransform(90);
                }
                g.Restore(orbit);
                var flower = g.Save();
                g.TranslateTransform(0, -40);
                g.RotateTransform((float)(-5 * Math.Cos(phase * Math.PI * 2 / 2.8)));
                float breath = .63f * (1 + (float)(.035 * (1 - Math.Cos(phase * Math.PI * 2 / 2.8)) / 2));
                g.ScaleTransform(breath, breath);
                using (var petal = new System.Drawing.Drawing2D.GraphicsPath())
                {
                    petal.AddBezier(0, -2, -10, -11, -10, -25, 0, -33);
                    petal.AddBezier(0, -33, 10, -25, 10, -11, 0, -2); petal.CloseFigure();
                    for (int i = 0; i < 5; i++) { g.FillPath(accent, petal); g.RotateTransform(72); }
                    g.FillEllipse(accent, -3, -3, 6, 6);
                }
                g.Restore(flower);
                g.DrawString("SakuraCode", titleFont, title, new RectangleF(-220, 18, 440, 38), centered);
                g.DrawString("AGENT WORKSPACE", captionFont, muted, new RectangleF(-220, 56, 440, 22), centered);
                g.FillRectangle(soft, -60, 91, 120, 3);
                g.FillRectangle(accent, -60 + (float)((1 - Math.Cos(phase * Math.PI / 1.2)) * 38), 91, 44, 3);
                g.DrawString(startupStage, statusFont, muted, new RectangleF(-220, 106, 440, 48), centered);
            }
            g.Restore(saved);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Every host handle uses the same border policy. Startup/attach
            // never toggles ShowInTaskbar or recreates an embedded child.
            Native.HideWindowBorder(Handle);
        }

        /// <summary>The launcher only reads settings; editing happens in the main page.</summary>
        private void LoadSettings()
        {
            settings = new DesktopSettings();
            string file = Path.Combine(options.DataDir, "settings.json");
            try { if (File.Exists(file)) settings = new JavaScriptSerializer().Deserialize<DesktopSettings>(File.ReadAllText(file, Encoding.UTF8)) ?? settings; }
            catch { Log("Settings file unreadable; starting from defaults."); }
            if (settings.Appearance != null && (settings.Appearance.Count != 1 || !ValidQuotaDisplay(AsString(settings.Appearance, "quotaDisplay")))) settings.Appearance = null;
            if (settings.Retry != null && !ValidRetryPolicy(settings.Retry)) settings.Retry = null;
            if (settings.Updates != null && !ValidUpdateSettings(settings.Updates)) settings.Updates = null;
            workspaceInput = options.Workspace ?? settings.Workspace ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            // Keep legacy configuration on disk, but the dedicated product must
            // never decrypt/import a user-supplied upstream or model API Key.
            baseUrlInput = "https://api.sakuraapi.top/v1";
            modelInput = "";
            rememberKeyInput = false;
            apiKeyInput = "";
        }

        private void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开工作区", null, delegate { FocusWorkspace(); });
            menu.Items.Add("收起到托盘", null, delegate { MinimizeToTray(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 SakuraCode", null, async delegate { await ExitAsync(); });
            tray.Icon = appIcon;
            tray.Text = "SakuraCode Desktop · 本机工作区";
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { FocusWorkspace(); };
        }

        private void FocusWorkspace()
        {
            if (Native.IsWindow(browserWindow))
            {
                if (trayHidden || WindowState == FormWindowState.Minimized) WindowState = trayRestoreState;
                trayHidden = false;
                Show();
                Native.SetForegroundWindow(Handle);
                LayoutBrowser();
                QueueBrowserReflow();
                FocusBrowser();
            }
            else if (showingStartup && !exiting) { Show(); Native.SetForegroundWindow(Handle); }
        }

        private void MinimizeToTray()
        {
            if (exiting || !Native.IsWindow(browserWindow)) return;
            if (WindowState != FormWindowState.Minimized) trayRestoreState = WindowState;
            trayHidden = true;
            // Do not toggle ShowInTaskbar: it recreates the HWND and can destroy
            // the embedded Chromium child. Hiding removes the taskbar button.
            Hide();
        }

        private void FocusBrowser()
        {
            if (browserAttached && !showingStartup && !exiting && !trayHidden && Visible && IsHandleCreated && WindowState != FormWindowState.Minimized && Native.IsWindow(browserWindow))
                Native.FocusEmbeddedBrowser(Handle, browserWindow);
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            // The external consent browser can take focus while Chromium is
            // still processing kiosk/fullscreen bounds. Restore the embedded
            // surface on return, even when the host itself was never resized.
            LayoutBrowser();
            QueueBrowserReflow();
            // Activation focuses the empty WinForms host, not its cross-process
            // Chromium child. Restore native keyboard/IME focus, without moving
            // the page's caret or taking focus from another foreground app.
            FocusBrowser();
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == showMessage) { FocusWorkspace(); return; }
            if (message.Msg == 0x0112 && (message.WParam.ToInt64() & 0xfff0) == 0xf020) // SC_MINIMIZE, including taskbar/keyboard
            {
                MinimizeToTray();
                message.Result = IntPtr.Zero;
                return;
            }
            // Keep the standard resizable/snap-capable window style, but make
            // its entire client area ours — Windows never paints a titlebar.
            if (message.Msg == 0x0083) { message.Result = IntPtr.Zero; return; } // WM_NCCALCSIZE
            if (message.Msg == 0x0085 && WindowState != FormWindowState.Minimized)
            {
                // WM_NCPAINT: the host owns the whole frame. DefWindowProc
                // would otherwise draw a light resize border over our client.
                message.Result = IntPtr.Zero;
                return;
            }
            if (message.Msg == 0x0086 && WindowState != FormWindowState.Minimized)
            {
                // WM_NCACTIVATE: keep the normal activation bookkeeping, but
                // lParam=-1 prevents the default active/inactive frame repaint.
                // Minimized windows still need the default icon processing.
                message.LParam = new IntPtr(-1);
                base.WndProc(ref message);
                return;
            }
            if (message.Msg == 0x0024)
            {
                base.WndProc(ref message);
                Native.LimitMaximizedBounds(Handle, message.LParam);
                return;
            }
            if (message.Msg == 0x0084 && WindowState != FormWindowState.Maximized)
            {
                int hit = Native.ResizeHit(Handle, message.LParam, FrameInset);
                if (hit != 0) { message.Result = new IntPtr(hit); return; }
            }
            base.WndProc(ref message);
            if (message.Msg == 0x001a && showingStartup) // WM_SETTINGCHANGE: respect reduced motion without restarting startup.
            {
                startupMotion = Native.ClientAnimationsEnabled();
                if (startupMotion) startupAnimation.Start(); else startupAnimation.Stop();
                Invalidate();
            }
            if (message.Msg == 0x0005 || message.Msg == 0x0047 || message.Msg == 0x02e0) { LayoutBrowser(); QueueBrowserReflow(); } // size, position, DPI: read native client, not cached WinForms geometry
            if (message.Msg == 0x0007) FocusBrowser(); // WM_SETFOCUS, including keyboard navigation back to the host
            if (message.Msg == 0x031a || message.Msg == 0x031e) // theme / DWM composition changed
                Native.HideWindowBorder(Handle);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams result = base.CreateParams;
                result.Style |= 0x00040000 | 0x00020000 | 0x00010000 | 0x00080000;
                result.Style &= ~0x00c00000; // no WS_CAPTION
                return result;
            }
        }

        private int FrameInset
        {
            get { return IsHandleCreated && Native.IsZoomed(Handle) ? 0 : Math.Max(5, (int)Math.Ceiling(DeviceDpi / 96.0 * 5)); }
        }

        private void QueueBrowserReflow()
        {
            if (exiting || !browserAttached) return;
            browserReflow.Stop(); browserReflow.Start();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            LayoutBrowser();
        }

        private void LayoutBrowser(bool force = false)
        {
            if (layingOutBrowser || !browserAttached || browserWindow == IntPtr.Zero || !IsHandleCreated || !Native.IsWindow(browserWindow) || WindowState == FormWindowState.Minimized) return;
            Native.NativeRect client, actual, browserClient;
            if (!Native.GetClientRect(Handle, out client) || client.Right <= client.Left || client.Bottom <= client.Top || Native.GetParent(browserWindow) != Handle) return;
            int inset = FrameInset;
            int width = Math.Max(1, client.Right - client.Left - inset * 2), height = Math.Max(1, client.Bottom - client.Top - inset * 2);
            var expected = new Native.NativePoint { X = client.Left + inset, Y = client.Top + inset };
            if (!Native.ClientToScreen(Handle, ref expected)) return;
            PublishViewport(width, height);
            // Compare BOTH outer and client rectangles. A Chromium fullscreen
            // state change can leave its outer HWND correct but reserve stale
            // nonclient space. Do not remount the renderer or steal focus.
            if (!force && Native.GetWindowRect(browserWindow, out actual) && actual.Left == expected.X && actual.Top == expected.Y &&
                actual.Right - actual.Left == width && actual.Bottom - actual.Top == height &&
                Native.GetClientRect(browserWindow, out browserClient) && browserClient.Right - browserClient.Left == width && browserClient.Bottom - browserClient.Top == height) return;
            layingOutBrowser = true;
            try
            {
                if (!Native.SetWindowPos(browserWindow, IntPtr.Zero, client.Left + inset, client.Top + inset, width, height, 0x0034)) return;
                // Notify the existing renderer on the browser's own queue. This
                // bounded repair also covers activation without a host resize.
                Native.PostMessage(browserWindow, 0x0005, IntPtr.Zero, new IntPtr(((height & 0xffff) << 16) | (width & 0xffff)));
            }
            finally { layingOutBrowser = false; }
        }

        private void PublishViewport(int width, int height)
        {
            int dpi = DeviceDpi;
            if (viewportWidth == width && viewportHeight == height && viewportDpi == dpi) return;
            try
            {
                lock (settingsLock)
                {
                    if (engineInput == null) return;
                    engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/viewport",
                        viewport = new { width = width, height = height, dpi = dpi, version = viewportVersion + 1 } }));
                    viewportWidth = width; viewportHeight = height; viewportDpi = dpi; viewportVersion++;
                }
            }
            catch { /* Next native layout retries; no user data or renderer state is changed. */ }
        }

        private void AttachBrowser()
        {
            // Do not reset the host bounds or recreate its HWND here: a user
            // may already have resized/maximized the visible startup window.
            Native.ShowWindow(browserWindow, 0);
            long style = Native.GetWindowLongPtr(browserWindow, -16).ToInt64();
            Native.SetWindowLongPtr(browserWindow, -16, new IntPtr((style & ~0x80cf0000L) | 0x40000000L));
            Native.ClearLastError(0);
            Native.SetParent(browserWindow, Handle);
            int error = Marshal.GetLastWin32Error();
            if (error != 0) throw new Win32Exception(error, "无法创建无标题栏工作区窗口。");
            browserAttached = true;
            LayoutBrowser(true);
        }

        private void RevealBrowser()
        {
            startupAnimation.Stop(); showingStartup = false;
            Native.ShowWindow(browserWindow, 5);
            if (!trayHidden) Show();
            QueueBrowserReflow();
            FocusBrowser();
        }

        private void WindowAction(string action)
        {
            if (exiting || IsDisposed || !IsHandleCreated) return;
            BeginInvoke(new Action(async delegate
            {
                if (exiting) return;
                if (action == "ready") { surfaceReady.TrySetResult(true); return; }
                if (!Native.IsWindow(browserWindow)) return;
                if (action == "minimize") MinimizeToTray();
                else if (action == "reflow") LayoutBrowser(true);
                else if (action == "maximize") { WindowState = Native.IsZoomed(Handle) ? FormWindowState.Normal : FormWindowState.Maximized; LayoutBrowser(true); QueueBrowserReflow(); }
                else if (action == "close") await ExitAsync();
                else if (action == "drag")
                {
                    Native.SendMessage(browserWindow, 0x001f, IntPtr.Zero, IntPtr.Zero); // cancel browser capture
                    Native.ReleaseCapture();
                    Native.PostMessage(Handle, 0x0112, new IntPtr(0xf012), IntPtr.Zero); // SC_MOVE | HTCAPTION
                }
            }));
        }

        private Task BeginLaunch()
        {
            launchTask = LaunchAsync();
            return launchTask;
        }

        private async Task LaunchAsync()
        {
            busy = true;
            if (launchCancellation != null) launchCancellation.Dispose();
            launchCancellation = new CancellationTokenSource();
            CancellationToken cancellation = launchCancellation.Token;
            bool started = false;
            Exception failure = null;
            try
            {
                Log("Launching workspace: " + workspaceInput);
                string cwd = Path.GetFullPath(workspaceInput.Trim());
                if (!Path.IsPathRooted(workspaceInput.Trim()) || !Directory.Exists(cwd)) throw new ArgumentException("请选择已存在的项目目录。可在主页面的「设置」中切换工作区。");
                string endpoint = baseUrlInput.Trim();
                if (endpoint.Length > 0)
                {
                    Uri uri;
                    if (!Uri.TryCreate(endpoint, UriKind.Absolute, out uri) || !(uri.Scheme == "https" || (uri.Scheme == "http" && uri.IsLoopback)) || !String.IsNullOrEmpty(uri.UserInfo) || !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment))
                        throw new ArgumentException("模型 API 地址须为 HTTPS；本机模型可用 HTTP。不要在地址中填写密钥、查询参数或片段。");
                }
                string modelName = modelInput.Trim();
                if (modelName.Length > 200 || Regex.IsMatch(modelName, @"[\s\x00-\x1f\x7f]")) throw new ArgumentException("模型名称不能包含空白或控制字符。");
                activeSecret = apiKeyInput.Trim();
                if (activeSecret.Length > 4096 || Regex.IsMatch(activeSecret, @"[\x00-\x20\x7f]")) throw new ArgumentException("API Key 包含无效空白或控制字符。");
                string browserPath = Program.FindBrowser();
                Log("Verifying the built-in runtime engine…");
                StartupStage("正在校验内置运行引擎…");
                string runtime = await Task.Run(() => Program.ExtractEngine(options.DataDir));
                cancellation.ThrowIfCancellationRequested();
                stopTask = null;
                job = new ProcessJob();
                Log("Starting the local workspace…");
                StartupStage("正在加载工作区与插件…");
                string url = await StartEngineAsync(runtime, cwd, endpoint, modelName, cancellation);
                cancellation.ThrowIfCancellationRequested();
                appTitle = workspaceName(cwd) + " — SakuraCode";
                Text = appTitle;
                string profile = Path.Combine(options.DataDir, "browser-profile");
                Directory.CreateDirectory(profile);
                {
                    Log("Opening the app window…");
                    StartupStage("正在准备界面…");
                    var browserArgs = new List<string> {
                        "--app=" + url, "--user-data-dir=" + profile,
                        "--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--disable-background-networking",
                        "--disable-sync", "--disable-extensions", "--disable-default-apps",
                        // --disable-extensions alone leaves Edge's built-in
                        // voice/media/feedback background pages running. This
                        // dedicated workspace needs none of those components;
                        // keep Chromium's renderer/network/GPU sandboxes intact.
                        "--disable-component-extensions-with-background-pages", "--window-size=1440,960",
                        "--window-position=-32000,-32000",
                        // Kiosk affects only the embedded browser surface: it removes
                        // Chromium's own caption and prevents F11 from bringing it
                        // back. The resizable native host is NOT a kiosk/fullscreen app.
                        "--kiosk", "--start-fullscreen"
                    };
                    if (Environment.GetEnvironmentVariable("SAKURA_DESKTOP_DEBUG") == "1")
                    {
                        string oldPort = Path.Combine(profile, "DevToolsActivePort");
                        if (File.Exists(oldPort)) File.Delete(oldPort);
                        browserArgs.Add("--remote-debugging-port=0");
                        // Opt-in smoke runs must keep processing viewport changes
                        // even while the user's interactive desktop is locked.
                        browserArgs.Add("--disable-backgrounding-occluded-windows");
                        browserArgs.Add("--disable-renderer-backgrounding");
                        browserArgs.Add("--disable-background-timer-throttling");
                    }
                    browser = new Process { StartInfo = new ProcessStartInfo(browserPath, String.Join(" ", browserArgs.ConvertAll(Program.Quote))) { UseShellExecute = false, WorkingDirectory = options.DataDir } };
                    browser.Start();
                    job.Add(browser);
                    DateTime deadline = DateTime.UtcNow.AddSeconds(25);
                    while (browserWindow == IntPtr.Zero)
                    {
                        cancellation.ThrowIfCancellationRequested();
                        // Edge/Chrome relaunch themselves through a compat layer:
                        // the root process exits immediately while the real app
                        // window is created by a child. Waiting only on the root
                        // misreads that handoff as a launch failure, so keep
                        // scanning the process tree until the deadline.
                        browserWindow = Native.FindAppWindowInTree(browser.Id);
                        if (DateTime.UtcNow > deadline) throw new TimeoutException("浏览器窗口启动超时。请检查 Chrome / Edge 是否能正常打开。");
                        if (browserWindow == IntPtr.Zero) await Task.Delay(100, cancellation);
                    }
                    // Remember which process actually owns the window so the
                    // monitor can keep watching it after the root is gone.
                    browserOwnerId = Native.WindowOwner(browserWindow);
                    AttachBrowser();
                    Task painted = await Task.WhenAny(surfaceReady.Task, Task.Delay(20000, cancellation));
                    cancellation.ThrowIfCancellationRequested();
                    if (painted != surfaceReady.Task) throw new TimeoutException("界面加载超时，请重新启动 SakuraCode。账号与会话数据未删除。");
                    // The page now has its own loading layer. Swapping within
                    // the same host leaves no browser default/initial frame.
                    await Task.Delay(32, cancellation);
                    RevealBrowser();
                }
                cancellation.ThrowIfCancellationRequested();
                // Merely starting a newer release must not rewrite existing
                // user settings. Explicit workspace edits still persist below.
                string settingsFile = Path.Combine(options.DataDir, "settings.json");
                if (!File.Exists(settingsFile))
                {
                    settings.Workspace = cwd;
                    Program.WriteJson(settingsFile, settings);
                }
                Program.WriteJson(Path.Combine(options.DataDir, "runtime.json"), new { launcherPid = Process.GetCurrentProcess().Id, enginePid = engine.Id, browserPid = browser != null ? browser.Id : 0, windowOwnerPid = browserOwnerId != 0 ? (int)browserOwnerId : (browser != null ? browser.Id : 0), windowHandle = Handle.ToInt64(), browserWindowHandle = browserWindow.ToInt64(), frameless = true, url = url, browserProfile = profile });
                Log("Workspace opened; engine and app window ready.");
                tray.Visible = true;
                monitor.Start();
                started = true;
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { failure = error; }
            // The in-box .NET compiler is C# 5: await belongs outside catch/finally.
            try
            {
                if (!started) await StopRuntimeAsync();
                if (failure != null)
                {
                    string message = Redact(failure.Message);
                    Log("Launch failed: " + message);
                    if (!exiting)
                    {
                        MessageBox.Show(message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        // ExitAsync waits for launchTask; do not await our own
                        // launch task here. Cleanup has already completed.
                        exiting = true;
                        tray.Visible = false;
                        allowClose = true;
                        Close();
                    }
                }
            }
            finally { busy = false; }
        }

        private static string workspaceName(string path)
        {
            string name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return String.IsNullOrEmpty(name) ? path : name;
        }

        private async Task<string> StartEngineAsync(string runtime, string cwd, string endpoint, string modelName, CancellationToken cancellation)
        {
            var ready = new TaskCompletionSource<string>();
            engineError = "";
            var child = new Process {
                StartInfo = new ProcessStartInfo(runtime, "--desktop-host") {
                    WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                }, EnableRaisingEvents = true
            };
            engine = child;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (String.IsNullOrEmpty(e.Data) || e.Data.Length > 65536) return;
                try
                {
                    var frame = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(e.Data);
                    object type;
                    if (frame == null || !frame.TryGetValue("type", out type)) return;
                    if ((string)type == "desktop/settings") { PersistWorkspaceSettingsFrame(frame); return; }
                    if ((string)type == "desktop/context-settings") { PersistContextSettingsFrame(frame); return; }
                    if ((string)type == "desktop/appearance") { PersistAppearanceFrame(frame); return; }
                    if ((string)type == "desktop/retry") { PersistRetryFrame(frame); return; }
                    if ((string)type == "desktop/updates") { PersistUpdatesFrame(frame); return; }
                    if ((string)type == "desktop/weixin") { PersistWeixinFrame(frame); return; }
                    if ((string)type == "desktop/sakuraapi") { PersistAccountFrame(frame); return; }
                    if ((string)type == "desktop/window") { WindowAction(AsString(frame, "action")); return; }
                    if ((string)type != "desktop/ready") return;
                    Uri uri;
                    string url = (string)frame["url"];
                    if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port <= 0 || uri.AbsolutePath != "/" || uri.Query != "" || uri.Fragment != "" || uri.UserInfo != "" || Convert.ToInt32(frame["pid"]) != child.Id)
                        ready.TrySetException(new IOException("本机运行引擎返回了无效地址。"));
                    else ready.TrySetResult(url);
                }
                catch { /* Plugin stdout is not the launch protocol and is not logged. */ }
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (String.IsNullOrEmpty(e.Data)) return;
                string line = Redact(e.Data);
                engineError = line.Length > 1200 ? line.Substring(0, 1200) : line;
                Log("Engine: " + engineError);
            };
            child.Exited += delegate { ready.TrySetException(new IOException("本机运行引擎启动失败。" + engineError)); };
            child.Start();
            job.Add(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            engineInput = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
                engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { cwd = cwd, baseURL = endpoint, model = modelName, apiKey = activeSecret, approvalMode = "default", recentWorkspaces = settings.RecentWorkspaces ?? new string[0], rememberKey = rememberKeyInput, newWorkspaceDir = settings.NewWorkspaceDir ?? "", workspacePrefs = settings.WorkspacePrefs ?? new Dictionary<string, Dictionary<string, object>>(), appearance = settings.Appearance, retry = settings.Retry, updates = settings.Updates, weixin = LoadWeixinSettings(), sakuraApi = LoadAccountSettings() }));
            Task winner = await Task.WhenAny(ready.Task, Task.Delay(45000, cancellation));
            cancellation.ThrowIfCancellationRequested();
            if (winner != ready.Task) throw new TimeoutException("本机服务启动超时，请检查项目插件 / MCP 配置。启动日志位于 " + Path.Combine(options.DataDir, "desktop.log"));
            return await ready.Task;
        }

        /// <summary>Persist explicit workspace edits without importing or
        /// rewriting the legacy model configuration. Authorization uses its
        /// separate DPAPI storage and acknowledged pipe.</summary>
        private void PersistSettingsFrame(Dictionary<string, object> frame)
        {
            object box;
            frame.TryGetValue("settings", out box);
            var updated = box as Dictionary<string, object>;
            if (updated == null) return;
            lock (settingsLock)
            {
                object list;
                string[] recent = settings != null ? settings.RecentWorkspaces : null;
                if (updated.TryGetValue("recentWorkspaces", out list))
                {
                    // Deserialize<Dictionary<string, object>> produces ArrayList
                    // for nested JSON arrays; legacy reflection callers use
                    // object[]. Both implement IList, neither may be dropped.
                    var rows = list as System.Collections.IList;
                    if (rows == null) throw new IOException();
                    var paths = new List<string>(rows.Count);
                    foreach (object row in rows)
                    {
                        if (!(row is string)) throw new IOException();
                        paths.Add((string)row);
                    }
                    recent = paths.ToArray();
                }
                object prefsBox;
                updated.TryGetValue("workspacePrefs", out prefsBox);
                var prefs = prefsBox as Dictionary<string, object>;
                var previousPrefs = settings != null ? settings.WorkspacePrefs : null;
                Dictionary<string, Dictionary<string, object>> workspacePrefs = null;
                if (prefs != null)
                {
                    // The server sends the whole pref map per persist frame, but an
                    // older page may omit it — keep the previous map then.
                    workspacePrefs = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
                    foreach (var entry in prefs)
                    {
                        var value = entry.Value as Dictionary<string, object>;
                        if (value == null) continue;
                        workspacePrefs[entry.Key] = value;
                    }
                }
                else if (previousPrefs != null)
                {
                    workspacePrefs = previousPrefs;
                }
                // The C# 5 compiler has no pattern matching: read the field by hand.
                string newWorkspaceDir = null;
                object dirBox;
                if (updated.TryGetValue("newWorkspaceDir", out dirBox) && dirBox is string) newWorkspaceDir = (string)dirBox;
                else if (settings != null) newWorkspaceDir = settings.NewWorkspaceDir;
                var merged = new DesktopSettings {
                    Workspace = AsString(updated, "workspace"),
                    RecentWorkspaces = recent,
                    // Workspace changes must not destroy obsolete model
                    // settings: the host ignores them rather than migrating them.
                    BaseUrl = settings != null ? settings.BaseUrl : null,
                    Model = settings != null ? settings.Model : null,
                    ProtectedApiKey = settings != null ? settings.ProtectedApiKey : null,
                    RememberKey = settings != null && settings.RememberKey,
                    NewWorkspaceDir = newWorkspaceDir,
                    WorkspacePrefs = workspacePrefs,
                    // Full workspace/context frames can predate a display save.
                    // Only the dedicated appearance transaction may change it.
                    Appearance = settings != null ? settings.Appearance : null,
                    Retry = settings != null ? settings.Retry : null,
                    Updates = settings != null ? settings.Updates : null,
                };
                Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), merged);
                settings = merged;
                Log("Settings saved from the main page; workspace=" + merged.Workspace);
            }
        }

        private void PersistWorkspaceSettingsFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (id != null && id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value) || !(value is Dictionary<string, object>)) throw new IOException();
                PersistSettingsFrame(frame);
                ok = true;
            }
            catch { Log("Workspace settings storage failed; previous workspace preferences remain active."); }
            // No-id frames from older pages keep their legacy merge behavior.
            if (String.IsNullOrEmpty(id)) return;
            try
            {
                lock (settingsLock)
                {
                    if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/settings/saved", id = id, ok = ok }));
                }
            }
            catch { /* Parent disconnection rejects the pending workspace save. */ }
        }

        /// <summary>The context viewer must not claim persistence before the
        /// actual settings file has reached disk. Keep the legacy frame intact.</summary>
        private void PersistContextSettingsFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value) || !(value is Dictionary<string, object>)) throw new IOException();
                PersistSettingsFrame(frame);
                ok = true;
            }
            catch { Log("Context settings storage failed; previous thresholds remain active."); }
            try
            {
                lock (settingsLock)
                {
                    if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/context-settings/saved", id = id, ok = ok }));
                }
            }
            catch { /* A disconnected parent pipe rejects the pending settings write. */ }
        }

        private static bool ValidQuotaDisplay(string value)
        {
            return value == "always" || value == "hover" || value == "settings";
        }

        private void PersistAppearanceFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value)) throw new IOException();
                var updated = value as Dictionary<string, object>;
                if (updated == null || updated.Count != 1) throw new IOException();
                string mode = AsString(updated, "quotaDisplay");
                if (!ValidQuotaDisplay(mode)) throw new IOException();
                lock (settingsLock)
                {
                    var current = settings ?? new DesktopSettings();
                    var merged = new DesktopSettings {
                        Workspace = current.Workspace, RecentWorkspaces = current.RecentWorkspaces,
                        BaseUrl = current.BaseUrl, Model = current.Model,
                        ProtectedApiKey = current.ProtectedApiKey, RememberKey = current.RememberKey,
                        NewWorkspaceDir = current.NewWorkspaceDir, WorkspacePrefs = current.WorkspacePrefs,
                        Appearance = new Dictionary<string, object> { { "quotaDisplay", mode } },
                        Retry = current.Retry,
                        Updates = current.Updates,
                    };
                    Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), merged);
                    settings = merged;
                    ok = true;
                }
            }
            catch { Log("Appearance storage failed; previous display preferences remain active."); }
            try
            {
                lock (settingsLock)
                {
                    if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/appearance/saved", id = id, ok = ok }));
                }
            }
            catch { /* A disconnected launcher rejects the pending display save. */ }
        }

        private static bool RetryInteger(Dictionary<string, object> row, string key, int min, int max, out int number)
        {
            object value;
            number = 0;
            if (!row.TryGetValue(key, out value) || !(value is int || value is long)) return false;
            long parsed = Convert.ToInt64(value);
            if (parsed < min || parsed > max) return false;
            number = (int)parsed;
            return true;
        }

        private static bool ValidRetryPolicy(Dictionary<string, object> row)
        {
            object enabled;
            int window, retries, delay;
            return row != null && row.Count == 4 && row.TryGetValue("enabled", out enabled) && enabled is bool &&
                RetryInteger(row, "windowMs", 1000, 3600000, out window) && RetryInteger(row, "maxRetries", 0, 20, out retries) &&
                RetryInteger(row, "delayMs", 0, 60000, out delay) && delay < window;
        }

        private void PersistRetryFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value)) throw new IOException();
                var updated = value as Dictionary<string, object>;
                if (!ValidRetryPolicy(updated)) throw new IOException();
                lock (settingsLock)
                {
                    var current = settings ?? new DesktopSettings();
                    var merged = new DesktopSettings {
                        Workspace = current.Workspace, RecentWorkspaces = current.RecentWorkspaces,
                        BaseUrl = current.BaseUrl, Model = current.Model, ProtectedApiKey = current.ProtectedApiKey,
                        RememberKey = current.RememberKey, NewWorkspaceDir = current.NewWorkspaceDir,
                        WorkspacePrefs = current.WorkspacePrefs, Appearance = current.Appearance,
                        Retry = new Dictionary<string, object>(updated),
                        Updates = current.Updates,
                    };
                    Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), merged);
                    settings = merged;
                    ok = true;
                }
            }
            catch { Log("Retry policy storage failed; previous preferences remain active."); }
            try
            {
                lock (settingsLock) { if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/retry/saved", id = id, ok = ok })); }
            }
            catch { /* Parent disconnection rejects the pending write. */ }
        }

        private static bool ValidUpdateSettings(Dictionary<string, object> row)
        {
            object feed, auto;
            if (row == null || row.Count != 2 || !row.TryGetValue("feedUrl", out feed) || !(feed is string) ||
                !row.TryGetValue("autoCheck", out auto) || !(auto is bool)) return false;
            string text = (string)feed;
            if (text.Length > 2048 || text.IndexOf('\\') >= 0) return false;
            foreach (char character in text) if (Char.IsControl(character)) return false;
            if (text.Length == 0) return true;
            Uri url;
            if (!Uri.TryCreate(text, UriKind.Absolute, out url) || !String.IsNullOrEmpty(url.UserInfo) ||
                !String.IsNullOrEmpty(url.Query) || !String.IsNullOrEmpty(url.Fragment)) return false;
            return url.Scheme == Uri.UriSchemeHttps || url.Scheme == Uri.UriSchemeHttp && url.IsLoopback;
        }

        private void PersistUpdatesFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value)) throw new IOException();
                var updated = value as Dictionary<string, object>;
                if (!ValidUpdateSettings(updated)) throw new IOException();
                lock (settingsLock)
                {
                    var current = settings ?? new DesktopSettings();
                    var merged = new DesktopSettings {
                        Workspace = current.Workspace, RecentWorkspaces = current.RecentWorkspaces,
                        BaseUrl = current.BaseUrl, Model = current.Model, ProtectedApiKey = current.ProtectedApiKey,
                        RememberKey = current.RememberKey, NewWorkspaceDir = current.NewWorkspaceDir,
                        WorkspacePrefs = current.WorkspacePrefs, Appearance = current.Appearance, Retry = current.Retry,
                        Updates = new Dictionary<string, object>(updated),
                    };
                    Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), merged);
                    settings = merged;
                    ok = true;
                }
            }
            catch { Log("Update preferences storage failed; previous source remains active."); }
            try
            {
                lock (settingsLock) { if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/updates/saved", id = id, ok = ok })); }
            }
            catch { /* Parent disconnection rejects the pending update settings write. */ }
        }

        private object LoadWeixinSettings()
        {
            string file = Path.Combine(options.DataDir, "weixin.json");
            if (!File.Exists(file)) return null;
            try
            {
                var envelope = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                string encrypted = AsString(envelope, "protectedSettings");
                if (String.IsNullOrEmpty(encrypted)) return null;
                byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(encrypted), null, DataProtectionScope.CurrentUser);
                return new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(plain));
            }
            catch { Log("Saved Weixin binding could not be decrypted; scan again to connect."); return null; }
        }

        private void PersistWeixinFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value) || !(value is Dictionary<string, object>)) throw new IOException();
                var data = (Dictionary<string, object>)value;
                lock (settingsLock)
                {
                    string file = Path.Combine(options.DataDir, "weixin.json");
                    object credentials;
                    if (!data.TryGetValue("credentials", out credentials) || credentials == null)
                    {
                        if (File.Exists(file)) File.Delete(file);
                    }
                    else
                    {
                        byte[] plain = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(data));
                        string encrypted = Convert.ToBase64String(ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser));
                        Program.WriteJson(file, new { protectedSettings = encrypted });
                    }
                }
                ok = true;
            }
            catch { Log("Weixin secure storage failed; binding was not acknowledged."); }
            try
            {
                lock (settingsLock)
                {
                    if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/weixin/saved", id = id, ok = ok }));
                }
            }
            catch { /* The engine closes its pending write when the parent pipe disconnects. */ }
        }

        private object LoadAccountSettings()
        {
            string file = Path.Combine(options.DataDir, "sakuraapi.json");
            if (!File.Exists(file)) return null;
            try
            {
                var envelope = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                string encrypted = AsString(envelope, "protectedSettings");
                if (String.IsNullOrEmpty(encrypted)) return null;
                byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(encrypted), null, DataProtectionScope.CurrentUser);
                try
                {
                    if (plain.Length > 65536) throw new IOException();
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(plain));
                    RememberAccountSecrets(data);
                    return data;
                }
                finally { Array.Clear(plain, 0, plain.Length); }
            }
            catch { Log("Saved SakuraAPI account could not be decrypted; sign in again."); return null; }
        }

        private void PersistAccountFrame(Dictionary<string, object> frame)
        {
            string id = AsString(frame, "id");
            if (String.IsNullOrEmpty(id) || id.Length > 100) return;
            bool ok = false;
            try
            {
                object value;
                if (!frame.TryGetValue("settings", out value)) throw new IOException();
                lock (settingsLock)
                {
                    string file = Path.Combine(options.DataDir, "sakuraapi.json");
                    if (value == null) { if (File.Exists(file)) File.Delete(file); accountSecrets = new string[0]; }
                    else
                    {
                        if (!(value is Dictionary<string, object>)) throw new IOException();
                        RememberAccountSecrets((Dictionary<string, object>)value);
                        byte[] plain = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));
                        try
                        {
                            if (plain.Length > 65536) throw new IOException();
                            string encrypted = Convert.ToBase64String(ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser));
                            Program.WriteJson(file, new { protectedSettings = encrypted });
                        }
                        finally { Array.Clear(plain, 0, plain.Length); }
                    }
                }
                ok = true;
            }
            catch { Log("SakuraAPI secure storage failed; login was not acknowledged."); }
            try
            {
                lock (settingsLock)
                {
                    if (engineInput != null) engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { type = "desktop/sakuraapi/saved", id = id, ok = ok }));
                }
            }
            catch { /* Parent-pipe shutdown rejects the pending write on the engine side. */ }
        }

        // Record both account tokens and the separately selected inference Key.
        // A failed save must still redact the received rotation from logs.
        private void RememberAccountSecrets(Dictionary<string, object> data)
        {
            var secrets = new List<string>();
            if (accountSecrets != null) secrets.AddRange(accountSecrets);
            foreach (string name in new[] { "apiKey", "accessToken", "refreshToken" })
            {
                string secret = AsString(data, name);
                if (!String.IsNullOrEmpty(secret)) secrets.Add(secret);
            }
            object value;
            if (data.TryGetValue("client", out value) && value is Dictionary<string, object>)
            {
                var client = (Dictionary<string, object>)value;
                foreach (string name in new[] { "accessToken", "refreshToken" })
                {
                    string secret = AsString(client, name);
                    if (!String.IsNullOrEmpty(secret)) secrets.Add(secret);
                }
            }
            if (secrets.Count > 48) secrets.RemoveRange(0, secrets.Count - 48);
            accountSecrets = secrets.ToArray();
        }

        private static string AsString(IDictionary<string, object> row, string key)
        {
            object value;
            return row.TryGetValue(key, out value) && value is string ? (string)value : null;
        }

        private static bool AsBool(IDictionary<string, object> row, string key)
        {
            object value;
            return row.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        private async Task ExitAsync()
        {
            if (exiting) return;
            exiting = true;
            startupAnimation.Stop(); browserReflow.Stop();
            Hide();
            if (launchCancellation != null) launchCancellation.Cancel();
            if (launchTask != null) await launchTask;
            await StopRuntimeAsync();
            tray.Visible = false;
            allowClose = true;
            Close();
        }

        private Task StopRuntimeAsync()
        {
            if (stopTask == null) stopTask = StopCoreAsync();
            return stopTask;
        }

        private async Task StopCoreAsync()
        {
            monitor.Stop();
            try
            {
                if (engineInput != null && !Exited(engine)) { try { engineInput.WriteLine("shutdown"); } catch { } }
                // Close the visible window first; when it belongs to a child
                // process (Edge compat handoff) the root is already gone and
                // CloseMainWindow on it would be a no-op.
                if (browserWindow != IntPtr.Zero) { try { Native.PostMessage(browserWindow, 0x0010, IntPtr.Zero, IntPtr.Zero); } catch { } }
                else if (!Exited(browser)) { try { browser.CloseMainWindow(); } catch { } }
                DateTime deadline = DateTime.UtcNow.AddSeconds(6);
                while ((!Exited(engine) || (browserOwnerId != 0 && Native.IsProcessAlive(browserOwnerId)) || (!Exited(browser) && browserOwnerId == 0)) && DateTime.UtcNow < deadline) await Task.Delay(80);
            }
            finally
            {
                // The Job Object also terminates tools/MCP/browser descendants after a crash.
                if (job != null) { job.Dispose(); job = null; }
                if (!Exited(engine)) { try { engine.Kill(); } catch { } }
                if (!Exited(browser)) { try { browser.Kill(); } catch { } }
                if (browserOwnerId != 0) { try { Native.TerminateProcessTree(browserOwnerId); } catch { } }
                if (engineInput != null) { try { engineInput.Dispose(); } catch { } engineInput = null; }
                if (engine != null) { engine.Dispose(); engine = null; }
                if (browser != null) { browser.Dispose(); browser = null; }
                browserWindow = IntPtr.Zero;
                browserOwnerId = 0;
                string stateFile = Path.Combine(options.DataDir, "runtime.json");
                try { if (File.Exists(stateFile)) File.Delete(stateFile); } catch { }
                Log("Workspace stopped.");
            }
        }

        private static bool Exited(Process process)
        {
            if (process == null) return true;
            try { return process.HasExited; } catch { return true; }
        }

        private string Redact(string value)
        {
            foreach (string secret in new[] { activeSecret, Environment.GetEnvironmentVariable("SAKURA_API_KEY") })
                if (!String.IsNullOrEmpty(secret)) value = value.Replace(secret, "[redacted]");
            foreach (string secret in accountSecrets ?? new string[0])
                if (!String.IsNullOrEmpty(secret)) value = value.Replace(secret, "[redacted]");
            return Regex.Replace(value, @"(?i)(Bearer\s+)[^\s]+", "$1[redacted]");
        }

        private void Log(string message)
        {
            try
            {
                lock (logLock)
                {
                    string file = Path.Combine(options.DataDir, "desktop.log");
                    if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024) File.Delete(file);
                    File.AppendAllText(file, DateTime.Now.ToString("s") + " " + Redact(message) + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { /* Logging must not prevent cleanup. */ }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (job != null) job.Dispose();
                if (launchCancellation != null) launchCancellation.Dispose();
                monitor.Dispose();
                startupAnimation.Dispose(); browserReflow.Dispose();
                tray.Visible = false;
                if (tray.ContextMenuStrip != null) tray.ContextMenuStrip.Dispose();
                tray.Dispose();
                appIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class ProcessJob : IDisposable
    {
        private IntPtr handle;
        public ProcessJob()
        {
            handle = Native.CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new Native.JobExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(limits);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!Native.SetInformationJobObject(handle, 9, buffer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        public void Add(Process process)
        {
            if (!Native.AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法为桌面进程建立退出保护。");
        }
        public void Dispose() { if (handle != IntPtr.Zero) { Native.CloseHandle(handle); handle = IntPtr.Zero; } }
    }

    internal static class Native
    {
        internal static bool ClientAnimationsEnabled()
        {
            int enabled;
            return SystemInformation.UIEffectsEnabled && (!SystemParametersInfo(0x1042, 0, out enabled, 0) || enabled != 0); // SPI_GETCLIENTAREAANIMATION; read-only.
        }

        [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
        private static extern bool SystemParametersInfo(uint action, uint parameter, out int value, uint flags);

        internal static void HideWindowBorder(IntPtr window)
        {
            try
            {
                // Windows 11: suppress just the DWM outline, retaining shadow,
                // resize/snap styles and the existing native hit testing.
                uint borderColor = 0xfffffffe; // DWMWA_COLOR_NONE
                if (DwmSetWindowAttribute(window, 34, ref borderColor, 4) >= 0) return; // DWMWA_BORDER_COLOR
                // Windows 10 has no border-color attribute. Disable its native
                // frame rendering without removing WS_THICKFRAME or WS_SYSMENU.
                uint policy = 1; // DWMNCRP_DISABLED
                DwmSetWindowAttribute(window, 2, ref policy, 4); // DWMWA_NCRENDERING_POLICY
            }
            catch (DllNotFoundException) { /* No compositor: custom WM_NCPAINT still owns the frame. */ }
            catch (EntryPointNotFoundException) { /* Same fallback for older runtimes. */ }
        }

        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int size);
        [StructLayout(LayoutKind.Sequential)] internal struct NativePoint { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] internal struct NativeRect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] internal struct MinMaxInfo
        {
            public NativePoint Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo
        {
            public int Size;
            public NativeRect Monitor, Work;
            public uint Flags;
        }

        internal static void LimitMaximizedBounds(IntPtr window, IntPtr pointer)
        {
            var monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) return;
            var limits = (MinMaxInfo)Marshal.PtrToStructure(pointer, typeof(MinMaxInfo));
            limits.MaxPosition.X = monitor.Work.Left - monitor.Monitor.Left;
            limits.MaxPosition.Y = monitor.Work.Top - monitor.Monitor.Top;
            limits.MaxSize.X = monitor.Work.Right - monitor.Work.Left;
            limits.MaxSize.Y = monitor.Work.Bottom - monitor.Work.Top;
            Marshal.StructureToPtr(limits, pointer, false);
        }

        internal static int ResizeHit(IntPtr window, IntPtr parameter, int inset)
        {
            NativeRect rect;
            if (!GetWindowRect(window, out rect)) return 0;
            long packed = parameter.ToInt64();
            int x = (short)(packed & 0xffff), y = (short)((packed >> 16) & 0xffff);
            bool left = x >= rect.Left && x < rect.Left + inset;
            bool right = x < rect.Right && x >= rect.Right - inset;
            bool top = y >= rect.Top && y < rect.Top + inset;
            bool bottom = y < rect.Bottom && y >= rect.Bottom - inset;
            if (top && left) return 13;
            if (top && right) return 14;
            if (bottom && left) return 16;
            if (bottom && right) return 17;
            if (left) return 10;
            if (right) return 11;
            if (top) return 12;
            if (bottom) return 15;
            return 0;
        }

        [DllImport("kernel32.dll", EntryPoint = "SetLastError")] internal static extern void ClearLastError(uint error);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetParent(IntPtr window, IntPtr parent);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] internal static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] internal static extern bool ReleaseCapture();
        [DllImport("user32.dll")] internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] internal struct JobBasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JobExtendedLimits
        {
            public JobBasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr LoadLibrary(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string lParam);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo
        {
            public uint Size, Flags;
            public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
            public NativeRect CaretRect;
        }
        [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);

        internal static void FocusEmbeddedBrowser(IntPtr host, IntPtr child)
        {
            // Never change another application's focus. Existing renderer/IME
            // child focus is already correct and must not be reset.
            if (!IsWindow(host) || !IsWindow(child) || GetParent(child) != host ||
                GetAncestor(GetForegroundWindow(), 2) != host) return;
            uint owner;
            uint browserThread = GetWindowThreadProcessId(child, out owner);
            uint currentThread = GetCurrentThreadId();
            if (browserThread == 0) return;
            var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
            // A background browser thread can retain a stale focus HWND.
            // Inspect the foreground input queue, not the child's old queue.
            if (GetGUIThreadInfo(0, ref info) &&
                (info.Focus == child || IsChild(child, info.Focus))) return;
            bool attached = browserThread != currentThread;
            if (attached && !AttachThreadInput(currentThread, browserThread, true)) return;
            try
            {
                if (GetAncestor(GetForegroundWindow(), 2) == host && GetParent(child) == host) SetFocus(child);
            }
            finally { if (attached) AttachThreadInput(currentThread, browserThread, false); }
        }
        private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
        internal static IntPtr FindWindowForProcess(int pid)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner == pid && IsWindowVisible(window))
                {
                    var className = new StringBuilder(128);
                    GetClassName(window, className, className.Capacity);
                    if (className.ToString() == "Chrome_WidgetWin_1") { found = window; return false; }
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        /// <summary>Chromium browsers relaunch through a compat layer: the root
        /// process exits immediately and a child creates the real app window.
        /// Scan the whole descendant tree, not just the root pid.</summary>
        internal static IntPtr FindAppWindowInTree(int rootPid)
        {
            foreach (int pid in DescendantPids(rootPid))
            {
                IntPtr window = FindWindowForProcess(pid);
                if (window != IntPtr.Zero) return window;
            }
            return IntPtr.Zero;
        }

        internal static uint WindowOwner(IntPtr window)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            return owner;
        }

        internal static bool IsProcessAlive(uint pid)
        {
            if (pid == 0) return false;
            try
            {
                using (var process = Process.GetProcessById((int)pid)) return !process.HasExited;
            }
            catch { return false; }
        }

        internal static void TerminateProcessTree(uint rootPid)
        {
            if (rootPid == 0) return;
            try
            {
                foreach (int pid in DescendantPids((int)rootPid))
                {
                    try { using (var process = Process.GetProcessById(pid)) process.Kill(); } catch { }
                }
            }
            catch { }
        }

        /// <summary>Collects the pid and every descendant through a bounded
        /// breadth-first walk of the toolhelp process snapshot.</summary>
        private static System.Collections.Generic.List<int> DescendantPids(int rootPid)
        {
            var result = new System.Collections.Generic.List<int> { rootPid };
            var seen = new HashSet<int> { rootPid };
            var queue = new System.Collections.Generic.Queue<int>();
            queue.Enqueue(rootPid);
            var children = new Dictionary<int, List<int>>();
            foreach (var entry in TakeSnapshot())
            {
                List<int> ids;
                if (!children.TryGetValue(entry.ParentPid, out ids)) children[entry.ParentPid] = ids = new List<int>();
                ids.Add(entry.Pid);
            }
            try
            {
                while (queue.Count > 0 && result.Count < 512)
                {
                    int current = queue.Dequeue();
                    List<int> ids;
                    if (!children.TryGetValue(current, out ids)) continue;
                    foreach (int pid in ids)
                    {
                        if (seen.Add(pid))
                        {
                            result.Add(pid);
                            queue.Enqueue(pid);
                            if (result.Count >= 512) break;
                        }
                    }
                }
            }
            catch { }
            return result;
        }

        private struct ProcessEntry { public int Pid; public int ParentPid; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessSnapshotEntry
        {
            public uint Size, Usage, ProcessId;
            public UIntPtr DefaultHeapId;
            public uint ModuleId, Threads, ParentProcessId;
            public int PriorityClassBase;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExecutableFile;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref ProcessSnapshotEntry entry);
        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessSnapshotEntry entry);

        private static ProcessEntry[] TakeSnapshot()
        {
            var entries = new System.Collections.Generic.List<ProcessEntry>(128);
            // This scan runs repeatedly while Chromium starts. WMI loads a
            // management provider and queries every process on each 100ms poll;
            // the native Toolhelp snapshot supplies just the two IDs we need.
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
            if (snapshot == new IntPtr(-1)) return entries.ToArray();
            try
            {
                var row = new ProcessSnapshotEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessSnapshotEntry)) };
                if (Process32First(snapshot, ref row)) do
                {
                    entries.Add(new ProcessEntry { Pid = (int)row.ProcessId, ParentPid = (int)row.ParentProcessId });
                } while (Process32Next(snapshot, ref row));
            }
            catch { }
            finally { CloseHandle(snapshot); }
            return entries.ToArray();
        }
    }
}