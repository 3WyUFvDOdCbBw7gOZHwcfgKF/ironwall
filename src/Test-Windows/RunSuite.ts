import { execFileSync } from "child_process";
import { basename, join, resolve } from "path";
import { readdirSync, statSync } from "fs";

const TEST_TIMEOUT_MS: number = 15 * 60 * 1000;
const MAX_BUFFER_BYTES: number = 128 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const buildTestDir: string = __dirname;

function collectBuiltTestFiles(): string[] {
    const testFiles: string[] = [];
    for (const entryName of readdirSync(buildTestDir).sort()) {
        if (!entryName.endsWith(".test.js")) {
            continue;
        }
        const entryPath: string = join(buildTestDir, entryName);
        if (!statSync(entryPath).isFile()) {
            continue;
        }
        testFiles.push(entryPath);
    }
    if (testFiles.length === 0) {
        throw new Error(`No built test files found under '${buildTestDir}'. Run 'npm run build' first.`);
    }
    return testFiles;
}

function formatExecOutput(output: string | Buffer | undefined): string {
    if (output === undefined) {
        return "";
    }
    return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function runBuiltTest(testFilePath: string): void {
    process.stdout.write(`windows-suite running ${basename(testFilePath)}\n`);
    try {
        const output: string = execFileSync(process.execPath, [testFilePath], {
            cwd: repoRoot,
            encoding: "utf8",
            env: process.env,
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        if (output.length > 0) {
            process.stdout.write(output);
        }
    } catch (error) {
        const execError = error as Error & {
            readonly stdout?: string | Buffer;
            readonly stderr?: string | Buffer;
            readonly status?: number | null;
            readonly signal?: NodeJS.Signals | null;
        };
        const stdout: string = formatExecOutput(execError.stdout);
        const stderr: string = formatExecOutput(execError.stderr);
        throw new Error(
            [
                `windows-suite failed in ${basename(testFilePath)}`,
                `status=${String(execError.status)} signal=${String(execError.signal)}`,
                stdout.length === 0 ? "stdout:<empty>" : `stdout:\n${stdout}`,
                stderr.length === 0 ? "stderr:<empty>" : `stderr:\n${stderr}`
            ].join("\n")
        );
    }
}

const orderedTestFiles: string[] = collectBuiltTestFiles();
for (const testFilePath of orderedTestFiles) {
    runBuiltTest(testFilePath);
}

process.stdout.write(`windows-suite ok ${orderedTestFiles.length} tests\n`);