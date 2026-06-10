import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("dist");
const port = Number.parseInt(process.env.PORT || "4443", 10);
const keyPath = process.env.SSL_KEY;
const certPath = process.env.SSL_CERT;

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

function lanUrls() {
  const urls = [`https://127.0.0.1:${port}/`];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`https://${item.address}:${port}/`);
      }
    }
  }
  return urls;
}

function resolveFile(url) {
  const pathname = decodeURIComponent(new URL(url, "https://localhost").pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(root, `.${sep}${normalized}`);
  if (!candidate.startsWith(root)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(root, "index.html");
}

async function assertReady() {
  if (!existsSync(root)) {
    throw new Error("dist/ 不存在。请先运行 npm run build。");
  }
  await readdir(root);
  if (!keyPath || !certPath) {
    throw new Error("请设置 SSL_KEY 和 SSL_CERT 指向内网 HTTPS 证书文件。");
  }
}

await assertReady();

createServer(
  {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  },
  (request, response) => {
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
  },
).listen(port, "0.0.0.0", () => {
  console.log("MouseX HTTPS LAN server");
  console.log("证书需要被客户端浏览器信任，WebHID 才能在内网地址下可用。");
  for (const url of lanUrls()) console.log(`  ${url}`);
});
