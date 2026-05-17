const fs = require("fs");
const http = require("http");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const runtimeDir = path.join(__dirname, "runtime");
const readyPath = path.join(runtimeDir, "ready.txt");
const portPath = path.join(runtimeDir, "port.txt");
const summaryPath = path.join(runtimeDir, "summary.txt");
const staticPath = path.join(runtimeDir, "static-hello.txt");

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs) {
    const startedAt = Date.now();
    while (!fs.existsSync(filePath)) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`timed out waiting for ${filePath}`);
        }
        await delay(20);
    }
}

function request(port, requestPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1",
            port,
            path: requestPath,
            method: "GET"
        }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function main() {
    await waitForFile(readyPath, 10000);
    await waitForFile(portPath, 10000);
    const port = Number(fs.readFileSync(portPath, "utf8").trim());
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`invalid port: ${String(port)}`);
    }

    const json = await request(port, "/json");
    const staticFile = await request(port, "/static/hello.txt");
    const missing = await request(port, "/missing");

    if (json.status !== 200 || json.body !== "{\"ok\":true}\n") {
        throw new Error(`json response mismatch: ${JSON.stringify(json)}`);
    }
    if (staticFile.status !== 200 || staticFile.body !== fs.readFileSync(staticPath, "utf8")) {
        throw new Error(`static response mismatch: ${JSON.stringify(staticFile)}`);
    }
    if (missing.status !== 404 || missing.body !== "not found\n") {
        throw new Error(`missing response mismatch: ${JSON.stringify(missing)}`);
    }

    await waitForFile(summaryPath, 10000);
    process.stdout.write(`${fs.readFileSync(summaryPath, "utf8").trim()}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || String(error)}\n`);
    process.exit(1);
});