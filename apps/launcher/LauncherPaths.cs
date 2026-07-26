namespace TmallReviewLauncher;

internal sealed record LauncherPaths(
    string Root,
    string Node,
    string Tsx,
    string ServerEntry,
    string WebDist,
    string Database,
    string BrowserProfile)
{
    internal static LauncherPaths FromRoot(string root)
    {
        var absoluteRoot = Path.GetFullPath(root);
        var data = Path.Combine(absoluteRoot, "data");
        return new LauncherPaths(
            absoluteRoot,
            Path.Combine(absoluteRoot, "runtime", "node.exe"),
            Path.Combine(absoluteRoot, "node_modules", "tsx", "dist", "cli.mjs"),
            Path.Combine(absoluteRoot, "apps", "server", "src", "index.ts"),
            Path.Combine(absoluteRoot, "apps", "web", "dist"),
            Path.Combine(data, "tmall-review-console.sqlite"),
            Path.Combine(data, "browser-profile"));
    }

    internal IReadOnlyList<string> MissingRequiredFiles()
    {
        var required = new[] { Node, Tsx, ServerEntry, Path.Combine(WebDist, "index.html") };
        return required.Where(path => !File.Exists(path)).ToArray();
    }
}
