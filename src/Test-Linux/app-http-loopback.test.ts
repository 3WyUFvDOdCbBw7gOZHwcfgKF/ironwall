/* App-level loopback HTTP regression covering JSON and static-file responses. */

import { ChildProcessWithoutNullStreams } from "child_process";
import { deepStrictEqual, ok, strictEqual } from "assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { IncomingHttpHeaders, request as httpRequest } from "http";
import { join, resolve } from "path";
import { execBuildJsonCliSync, spawnBuildJsonCli } from "../Test/BuildJsonCliHarness";

class BackendRun {
    public readonly label: string;
    public readonly runArgs: readonly string[];

    public constructor(label: string, runArgs: readonly string[]) {
        this.label = label;
        this.runArgs = runArgs;
    }
}

class HttpResponseData {
    public readonly statusCode: number;
    public readonly headers: IncomingHttpHeaders;
    public readonly body: string;

    public constructor(statusCode: number, headers: IncomingHttpHeaders, body: string) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.body = body;
    }
}

class RunningServer {
    public readonly child: ChildProcessWithoutNullStreams;
    public stdout: string;
    public stderr: string;

    public constructor(child: ChildProcessWithoutNullStreams) {
        this.child = child;
        this.stdout = "";
        this.stderr = "";
    }
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const appDir: string = join(repoRoot, "src", "examples", "http-loopback");
const artifactDir: string = join(repoRoot, "src", "examples", "http-loopback", "runtime");
const readyPath: string = join(artifactDir, "ready.txt");
const portPath: string = join(artifactDir, "port.txt");
const summaryPath: string = join(artifactDir, "summary.txt");
const staticPath: string = join(artifactDir, "static-hello.txt");
const staticBody: string = "hello from static file\n";
const jsonBody: string = "{\"ok\":true}\n";
const missingBody: string = "not found\n";
const staticBytes: number = Buffer.byteLength(staticBody, "utf8");
const x64FrontendArgs: readonly string[] = ["--frontend-profile", "no-optimized"];

const runs: readonly BackendRun[] = [
    new BackendRun("c-backend", ["--backend-profile", "c-backend"]),
    new BackendRun("optimized-x64-backend", [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]),
    new BackendRun("no-optimized-backend", [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"])
];

function normalizeLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line: string): string => line.trim())
        .filter((line: string): boolean => line.length > 0);
}

function prepareArtifacts(): void {
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(staticPath, staticBody, "utf8");
}

function delay(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve): void => {
        setTimeout(resolve, milliseconds);
    });
}

async function waitForFile(filePath: string, timeoutMs: number, running: RunningServer): Promise<void> {
    const startedAt: number = Date.now();
    while (!existsSync(filePath)) {
        if (running.child.exitCode !== null || running.child.signalCode !== null) {
            throw new Error(`server exited before writing ${filePath}\nstdout=${running.stdout}\nstderr=${running.stderr}`);
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`timed out waiting for ${filePath}\nstdout=${running.stdout}\nstderr=${running.stderr}`);
        }
        await delay(20);
    }
}

function getSingleHeaderValue(headers: IncomingHttpHeaders, name: string): string {
    const rawValue: string | string[] | undefined = headers[name];
    if (typeof rawValue === "string") {
        return rawValue;
    }
    if (Array.isArray(rawValue)) {
        strictEqual(rawValue.length, 1, `expected a single ${name} header, got ${rawValue.join(",")}`);
        return rawValue[0];
    }
    throw new Error(`missing header ${name}`);
}

async function waitForListeningPort(running: RunningServer, timeoutMs: number): Promise<number> {
    await waitForFile(portPath, timeoutMs, running);
    const portText: string = readFileSync(portPath, "utf8").trim();
    const port: number = Number.parseInt(portText, 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`invalid listening port ${portText}\nstdout=${running.stdout}\nstderr=${running.stderr}`);
    }
    return port;
}

function spawnServer(run: BackendRun): RunningServer {
    const child: ChildProcessWithoutNullStreams = spawnBuildJsonCli(cliPath, [
        "run",
        appDir,
        "--entry",
        "app~http~loopback@main",
        ...run.runArgs
    ], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"]
    });
    const running: RunningServer = new RunningServer(child);
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer): void => {
        running.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer): void => {
        running.stderr += chunk.toString("utf8");
    });
    return running;
}

async function requestText(port: number, pathName: string): Promise<HttpResponseData> {
    const startedAt: number = Date.now();
    while (true) {
        try {
            return await new Promise<HttpResponseData>((resolve, reject): void => {
                const request = httpRequest({
                    host: "127.0.0.1",
                    port,
                    path: pathName,
                    method: "GET",
                    agent: false,
                    headers: {
                        Connection: "close"
                    }
                }, (response): void => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer): void => {
                        chunks.push(chunk);
                    });
                    response.on("end", (): void => {
                        resolve(new HttpResponseData(response.statusCode ?? 0, response.headers, Buffer.concat(chunks).toString("utf8")));
                    });
                });

                request.on("error", (error: NodeJS.ErrnoException): void => {
                    reject(error);
                });

                request.end();
            });
        } catch (error) {
            const errnoError: NodeJS.ErrnoException = error as NodeJS.ErrnoException;
            if ((errnoError.code === "ECONNREFUSED" || errnoError.code === "ECONNRESET") && Date.now() - startedAt <= TEST_TIMEOUT_MS) {
                await delay(20);
                continue;
            }
            throw error;
        }
    }
}

function waitForExit(running: RunningServer, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
        let settled: boolean = false;
        const timer: NodeJS.Timeout = setTimeout((): void => {
            if (!settled) {
                settled = true;
                running.child.kill("SIGKILL");
                reject(new Error(`server exit timeout\nstdout=${running.stdout}\nstderr=${running.stderr}`));
            }
        }, timeoutMs);

        running.child.once("error", (error: Error): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });

        running.child.once("exit", (code: number | null, signal: NodeJS.Signals | null): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                if (signal !== null) {
                    reject(new Error(`server exited with signal ${signal}\nstdout=${running.stdout}\nstderr=${running.stderr}`));
                    return;
                }
                if (code !== 0) {
                    reject(new Error(`server exited with code ${String(code)}\nstdout=${running.stdout}\nstderr=${running.stderr}`));
                    return;
                }
                resolve();
            }
        });
    });
}

async function runCase(run: BackendRun): Promise<void> {
    prepareArtifacts();
    const running: RunningServer = spawnServer(run);
    try {
        await waitForFile(readyPath, TEST_TIMEOUT_MS, running);
        const port: number = await waitForListeningPort(running, TEST_TIMEOUT_MS);

        const jsonResponse: HttpResponseData = await requestText(port, "/json");
        strictEqual(jsonResponse.statusCode, 200, `${run.label} json status mismatch`);
        strictEqual(getSingleHeaderValue(jsonResponse.headers, "content-type"), "application/json", `${run.label} json content-type mismatch`);
        strictEqual(getSingleHeaderValue(jsonResponse.headers, "content-length"), String(Buffer.byteLength(jsonBody, "utf8")), `${run.label} json content-length mismatch`);
        strictEqual(jsonResponse.body, jsonBody, `${run.label} json body mismatch`);

        const staticResponse: HttpResponseData = await requestText(port, "/static/hello.txt");
        strictEqual(staticResponse.statusCode, 200, `${run.label} static status mismatch`);
        strictEqual(getSingleHeaderValue(staticResponse.headers, "content-type"), "text/plain", `${run.label} static content-type mismatch`);
        strictEqual(getSingleHeaderValue(staticResponse.headers, "content-length"), String(staticBytes), `${run.label} static content-length mismatch`);
        strictEqual(staticResponse.body, staticBody, `${run.label} static body mismatch`);

        const missingResponse: HttpResponseData = await requestText(port, "/missing");
        strictEqual(missingResponse.statusCode, 404, `${run.label} missing status mismatch`);
        strictEqual(getSingleHeaderValue(missingResponse.headers, "content-type"), "text/plain", `${run.label} missing content-type mismatch`);
        strictEqual(getSingleHeaderValue(missingResponse.headers, "content-length"), String(Buffer.byteLength(missingBody, "utf8")), `${run.label} missing content-length mismatch`);
        strictEqual(missingResponse.body, missingBody, `${run.label} missing body mismatch`);

        await waitForExit(running, TEST_TIMEOUT_MS);

        strictEqual(running.stderr, "", `${run.label} unexpected stderr\n${running.stderr}`);
        deepStrictEqual(normalizeLines(running.stdout), [
            "http-loopback ok",
            "accepted=3 handled=3",
            `sendfile-bytes=${staticBytes}`
        ], `${run.label} stdout mismatch\n${running.stdout}`);

        ok(existsSync(summaryPath), `${run.label} missing summary file`);
        deepStrictEqual(normalizeLines(readFileSync(summaryPath, "utf8")), [
            "port-configured=yes",
            "accepted=3",
            "handled=3",
            "json=1",
            "static=1",
            "missing=1",
            "sendmsg=3",
            "sendfile=1",
            `sendfile-bytes=${staticBytes}`,
            "socket-errors-zero=yes"
        ], `${run.label} summary mismatch`);

        process.stdout.write(`app-http-loopback ${run.label} ok\n`);
    } finally {
        if (running.child.exitCode === null && running.child.signalCode === null) {
            running.child.kill("SIGKILL");
        }
    }
}

async function main(): Promise<void> {
    execBuildJsonCliSync(cliPath, ["check", appDir], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    for (const run of runs) {
        await runCase(run);
    }
}

void main().then((): void => {
    process.exitCode = 0;
}, (error: Error): void => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
});
