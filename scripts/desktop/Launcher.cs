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
        private string activeSecret = "";
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
            // The launcher shell stays invisible: the product surface is the
            // dedicated browser app window (no tab bar, no address bar), just
            // like a native client such as dsh.
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            ClientSize = new Size(0, 0);
            LoadSettings();
            BuildTray();
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!allowClose && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
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
            };
            // Start on the UI message loop, after the hidden native handle
            // exists. Async continuations must stay on the WinForms thread.
            Shown += async delegate { Hide(); await BeginLaunch(); };
        }

        /// <summary>The launcher only reads settings; editing happens in the main page.</summary>
        private void LoadSettings()
        {
            settings = new DesktopSettings();
            string file = Path.Combine(options.DataDir, "settings.json");
            try { if (File.Exists(file)) settings = new JavaScriptSerializer().Deserialize<DesktopSettings>(File.ReadAllText(file, Encoding.UTF8)) ?? settings; }
            catch { Log("Settings file unreadable; starting from defaults."); }
            workspaceInput = options.Workspace ?? settings.Workspace ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            baseUrlInput = settings.BaseUrl ?? "";
            modelInput = settings.Model ?? "";
            rememberKeyInput = settings.RememberKey;
            if (settings.RememberKey && !String.IsNullOrEmpty(settings.ProtectedApiKey))
            {
                try { apiKeyInput = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(settings.ProtectedApiKey), null, DataProtectionScope.CurrentUser)); }
                catch { Log("Saved API key could not be decrypted; dropping it."); apiKeyInput = ""; rememberKeyInput = false; }
            }
        }

        private void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开工作区", null, delegate { FocusWorkspace(); });
            // Settings moved into the main page; the tray only focuses or exits.
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
                Native.ShowWindow(browserWindow, 9);
                Native.SetForegroundWindow(browserWindow);
            }
            // No settings window exists anymore; with no app window there is
            // nothing to surface (the monitor exits once the browser is gone).
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == showMessage) { FocusWorkspace(); return; }
            base.WndProc(ref message);
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
                string runtime = await Task.Run(() => Program.ExtractEngine(options.DataDir));
                cancellation.ThrowIfCancellationRequested();
                stopTask = null;
                job = new ProcessJob();
                Log("Starting the local workspace…");
                string url = await StartEngineAsync(runtime, cwd, endpoint, modelName, cancellation);
                cancellation.ThrowIfCancellationRequested();
                appTitle = workspaceName(cwd) + " — SakuraCode";
                Text = appTitle;
                string profile = Path.Combine(options.DataDir, "browser-profile");
                Directory.CreateDirectory(profile);
                {
                    Log("Opening the app window…");
                    var browserArgs = new List<string> {
                        "--app=" + url, "--user-data-dir=" + profile,
                        "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
                        "--disable-sync", "--disable-extensions", "--window-size=1440,960"
                    };
                    if (Environment.GetEnvironmentVariable("SAKURA_DESKTOP_DEBUG") == "1")
                    {
                        string oldPort = Path.Combine(profile, "DevToolsActivePort");
                        if (File.Exists(oldPort)) File.Delete(oldPort);
                        browserArgs.Add("--remote-debugging-port=0");
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
                }
                cancellation.ThrowIfCancellationRequested();
                settings = new DesktopSettings {
                    Workspace = cwd, BaseUrl = endpoint, Model = modelName, RememberKey = rememberKeyInput,
                    RecentWorkspaces = settings.RecentWorkspaces,
                    ProtectedApiKey = rememberKeyInput && activeSecret.Length > 0 ? Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(activeSecret), null, DataProtectionScope.CurrentUser)) : null
                };
                Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), settings);
                Program.WriteJson(Path.Combine(options.DataDir, "runtime.json"), new { launcherPid = Process.GetCurrentProcess().Id, enginePid = engine.Id, browserPid = browser != null ? browser.Id : 0, windowOwnerPid = browserOwnerId != 0 ? (int)browserOwnerId : (browser != null ? browser.Id : 0), url = url, browserProfile = profile });
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
                    if ((string)type == "desktop/settings") { PersistSettingsFrame(frame); return; }
                    if ((string)type == "desktop/weixin") { PersistWeixinFrame(frame); return; }
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
                engineInput.WriteLine(new JavaScriptSerializer().Serialize(new { cwd = cwd, baseURL = endpoint, model = modelName, apiKey = activeSecret, approvalMode = "default", recentWorkspaces = settings.RecentWorkspaces ?? new string[0], rememberKey = rememberKeyInput, newWorkspaceDir = settings.NewWorkspaceDir ?? "", workspacePrefs = settings.WorkspacePrefs ?? new Dictionary<string, Dictionary<string, object>>(), weixin = LoadWeixinSettings() }));
            Task winner = await Task.WhenAny(ready.Task, Task.Delay(45000, cancellation));
            cancellation.ThrowIfCancellationRequested();
            if (winner != ready.Task) throw new TimeoutException("本机服务启动超时，请检查项目插件 / MCP 配置。启动日志位于 " + Path.Combine(options.DataDir, "desktop.log"));
            return await ready.Task;
        }

        /// <summary>Persists settings edits coming from the main page: the
        /// workspace / model fields are public, the key is re-encrypted with
        /// DPAPI only while the "save key" option is on.</summary>
        private void PersistSettingsFrame(Dictionary<string, object> frame)
        {
            object box;
            frame.TryGetValue("settings", out box);
            var updated = box as Dictionary<string, object>;
            if (updated == null) return;
            lock (settingsLock)
            {
                string apiKey = AsString(updated, "apiKey");
                string protectedKey = null;
                if (AsBool(updated, "rememberKey") && !String.IsNullOrEmpty(apiKey))
                    protectedKey = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(apiKey), null, DataProtectionScope.CurrentUser));
                object list;
                updated.TryGetValue("recentWorkspaces", out list);
                string[] recent = null;
                if (list is object[])
                {
                    var rows = (object[])list;
                    var paths = new List<string>(rows.Length);
                    foreach (object row in rows) if (row != null) paths.Add(row.ToString());
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
                    BaseUrl = AsString(updated, "baseURL"),
                    Model = AsString(updated, "model"),
                    ProtectedApiKey = protectedKey,
                    RememberKey = AsBool(updated, "rememberKey"),
                    NewWorkspaceDir = newWorkspaceDir,
                    WorkspacePrefs = workspacePrefs,
                };
                Program.WriteJson(Path.Combine(options.DataDir, "settings.json"), merged);
                settings = merged;
                Log("Settings saved from the main page; workspace=" + merged.Workspace);
            }
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
            foreach (string secret in new[] { activeSecret, Environment.GetEnvironmentVariable("SAKURA_API_KEY"), Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY") })
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
                var process = Process.GetProcessById((int)pid);
                return process != null && !process.HasExited;
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
                    try { Process.GetProcessById(pid).Kill(); } catch { }
                }
            }
            catch { }
        }

        /// <summary>Collects the pid and every descendant through a bounded
        /// breadth-first walk of the toolhelp process snapshot.</summary>
        private static System.Collections.Generic.List<int> DescendantPids(int rootPid)
        {
            var result = new System.Collections.Generic.List<int> { rootPid };
            var queue = new System.Collections.Generic.Queue<int>();
            queue.Enqueue(rootPid);
            var snapshot = TakeSnapshot();
            try
            {
                while (queue.Count > 0 && result.Count < 512)
                {
                    int current = queue.Dequeue();
                    foreach (var entry in snapshot)
                    {
                        if (entry.ParentPid == current && !result.Contains(entry.Pid))
                        {
                            result.Add(entry.Pid);
                            queue.Enqueue(entry.Pid);
                        }
                    }
                }
            }
            catch { }
            return result;
        }

        private struct ProcessEntry { public int Pid; public int ParentPid; }

        private static ProcessEntry[] TakeSnapshot()
        {
            var entries = new System.Collections.Generic.List<ProcessEntry>(128);
            try
            {
                // .NET Framework's Process class does not expose the parent pid;
                // Win32_Process does, and it is cheap enough for a one-off scan.
                foreach (var row in new System.Management.ManagementObjectSearcher("SELECT ProcessId, ParentProcessId FROM Win32_Process").Get())
                {
                    try
                    {
                        entries.Add(new ProcessEntry
                        {
                            Pid = Convert.ToInt32(row["ProcessId"], System.Globalization.CultureInfo.InvariantCulture),
                            ParentPid = Convert.ToInt32(row["ParentProcessId"], System.Globalization.CultureInfo.InvariantCulture),
                        });
                    }
                    catch { }
                    finally { try { row.Dispose(); } catch { } }
                }
            }
            catch { }
            return entries.ToArray();
        }
    }
}