import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function registerStaticWeb(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const indexPath = resolve(root, "index.html");

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      return reply.code(404).send("Not found");
    }
    if (pathname.startsWith("/api/") || pathname === "/api") return reply.code(404).send("Not found");

    const requested = pathname === "/" ? indexPath : resolve(root, `.${pathname}`);
    const insideRoot = requested === root || requested.startsWith(`${root}${sep}`);
    if (!insideRoot) return reply.code(404).send("Not found");

    let selected = requested;
    if (!(await regularFile(selected))) {
      if (extname(pathname)) return reply.code(404).send("Not found");
      selected = indexPath;
    }
    if (!(await regularFile(selected))) return reply.code(404).send("Not found");

    reply.header("Cache-Control", selected === indexPath ? "no-cache" : "public, max-age=31536000, immutable");
    reply.type(CONTENT_TYPES[extname(selected).toLowerCase()] ?? "application/octet-stream");
    return reply.send(await readFile(selected));
  };

  app.get("/", handler);
  app.get("/*", handler);
}
