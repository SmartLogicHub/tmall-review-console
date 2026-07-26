using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace TmallReviewLauncher;

internal static class Program
{
    private static readonly object LogSync = new();

    [STAThread]
    private static int Main(string[] args)
    {
        var bootstrapRoot = AppContext.BaseDirectory;
        WriteBootstrapLog(bootstrapRoot, "启动器入口已执行。");
        ApplicationConfiguration.Initialize();
        var paths = LauncherPaths.FromRoot(AppContext.BaseDirectory);
        WriteLauncherLog(paths, "启动器环境已初始化。");
        if (args.Contains("--check-layout", StringComparer.OrdinalIgnoreCase))
            return paths.MissingRequiredFiles().Count == 0 ? 0 : 2;

        return RunAsync(paths).GetAwaiter().GetResult();
    }

    private static async Task<int> RunAsync(LauncherPaths paths)
    {
        var missing = paths.MissingRequiredFiles();
        WriteLauncherLog(paths, $"发布目录检查完成，缺少文件数：{missing.Count}。");
        if (missing.Count > 0)
        {
            MessageBox.Show("程序文件不完整，请重新解压完整发布目录。", "评论助手无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(paths.Database)!);
        var port = ReserveLoopbackPort();
        WriteLauncherLog(paths, $"本次启动分配本地端口：{port}。");

        Process server;
        try
        {
            server = StartServer(paths, port);
        }
        catch (Exception error)
        {
            WriteLauncherLog(paths, $"无法创建后端进程：{error.GetType().Name}: {error.Message}");
            MessageBox.Show("本地服务未能正常启动，请确认发布目录完整后重试。", "评论助手无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        using (server)
        {
            server.EnableRaisingEvents = true;
            server.Exited += (_, _) => WriteLauncherLog(paths, $"后端进程已退出，退出码：{server.ExitCode}。");

            if (!await WaitForHealthAsync(HealthUrl(port), TimeSpan.FromSeconds(60), server).ConfigureAwait(false))
            {
                WriteLauncherLog(paths, "后端未在 60 秒内通过本次实例的健康检查。");
                await StopServerAsync(server).ConfigureAwait(false);
                MessageBox.Show("本地服务未能正常启动，请确认发布目录完整后重试。", "评论助手无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            OpenConsole(port);
            WriteLauncherLog(paths, "已打开本次启动的浏览器控制台，等待服务随前台会话结束而退出。");
            await server.WaitForExitAsync().ConfigureAwait(false);
            return server.ExitCode == 0 ? 0 : 1;
        }
    }

    private static int ReserveLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static Process StartServer(LauncherPaths paths, int port)
    {
        var start = new ProcessStartInfo(paths.Node)
        {
            WorkingDirectory = paths.Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(paths.Tsx);
        start.ArgumentList.Add(paths.ServerEntry);
        start.Environment["TMALL_CONSOLE_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["TMALL_CONSOLE_ORIGIN"] = ConsoleUrl(port).TrimEnd('/');
        start.Environment["TMALL_CONSOLE_WEB_DIST_PATH"] = paths.WebDist;
        start.Environment["TMALL_CONSOLE_DATABASE_PATH"] = paths.Database;
        start.Environment["TMALL_CONSOLE_BROWSER_PROFILE_PATH"] = paths.BrowserProfile;
        start.Environment["TMALL_CONSOLE_LAUNCHER_OWNS_STDIN"] = "1";
        var process = Process.Start(start) ?? throw new InvalidOperationException("无法启动本地服务");
        process.OutputDataReceived += (_, eventArgs) =>
        {
            if (!string.IsNullOrWhiteSpace(eventArgs.Data)) WriteLauncherLog(paths, $"后端输出：{eventArgs.Data}");
        };
        process.ErrorDataReceived += (_, eventArgs) =>
        {
            if (!string.IsNullOrWhiteSpace(eventArgs.Data)) WriteLauncherLog(paths, $"后端错误：{eventArgs.Data}");
        };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static async Task StopServerAsync(Process server)
    {
        if (server.HasExited) return;
        try
        {
            server.StandardInput.Close();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await server.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch
        {
            if (!server.HasExited) server.Kill(entireProcessTree: true);
        }
    }

    private static void WriteLauncherLog(LauncherPaths paths, string message)
    {
        try
        {
            var dataDirectory = Path.Combine(paths.Root, "data");
            Directory.CreateDirectory(dataDirectory);
            var safeMessage = message.Replace(paths.Root, "{应用目录}", StringComparison.OrdinalIgnoreCase);
            lock (LogSync)
            {
                File.AppendAllText(Path.Combine(dataDirectory, "launcher.log"), $"{DateTimeOffset.Now:O} {safeMessage}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never prevent the local product from starting.
        }
    }

    private static void WriteBootstrapLog(string root, string message)
    {
        try
        {
            var dataDirectory = Path.Combine(root, "data");
            Directory.CreateDirectory(dataDirectory);
            lock (LogSync)
            {
                File.AppendAllText(Path.Combine(dataDirectory, "launcher.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // The normal launcher flow will present a user-facing error.
        }
    }

    private static async Task<bool> WaitForHealthAsync(string healthUrl, TimeSpan timeout, Process server)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (server.HasExited) return false;
            if (await IsHealthyAsync(healthUrl).ConfigureAwait(false)) return true;
            await Task.Delay(250).ConfigureAwait(false);
        }
        return false;
    }

    private static async Task<bool> IsHealthyAsync(string healthUrl)
    {
        try
        {
            using var handler = new HttpClientHandler { UseProxy = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync(healthUrl).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK) return false;
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            return body.RootElement.TryGetProperty("csrfToken", out var token) && token.ValueKind == JsonValueKind.String;
        }
        catch
        {
            return false;
        }
    }

    private static string ConsoleUrl(int port) => $"http://127.0.0.1:{port}/";

    private static string HealthUrl(int port) => $"http://127.0.0.1:{port}/api/bootstrap";

    private static void OpenConsole(int port)
    {
        var url = ConsoleUrl(port);
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { MessageBox.Show($"请在浏览器中打开 {url}", "评论助手", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }
}
