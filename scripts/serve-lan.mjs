import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("dist");
const port = Number.parseInt(process.env.PORT || "4173", 10);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

function lanUrls(protocol) {
  const urls = [`${protocol}://127.0.0.1:${port}/`];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`${protocol}://${item.address}:${port}/`);
      }
    }
  }
  return urls;
}

function resolveFile(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(root, `.${sep}${normalized}`);
  if (!candidate.startsWith(root)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(root, "index.html");
}

async function assertBuildExists() {
  if (!existsSync(root)) {
    throw new Error("dist/ 不存在。请先运行 npm run build。");
  }
  await readdir(root);
}

await assertBuildExists();

createServer((request, response) => {
  const file = resolveFile(request.url || "/");
  if (!file) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  response.setHeader("Content-Type", mime.get(extname(file)) || "application/octet-stream");
  createReadStream(file)
    .on("error", () => {
      response.writeHead(404);
      response.end("Not found");
    })
    .pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log("MouseX LAN server");
  console.log("WebHID 只在 HTTPS 或 localhost 下可用；HTTP 内网地址仅支持网页 UI 和指针事件备用采样。");
  for (const url of lanUrls("http")) console.log(`  ${url}`);
});
