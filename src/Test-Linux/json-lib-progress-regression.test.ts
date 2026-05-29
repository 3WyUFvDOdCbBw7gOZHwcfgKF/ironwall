import { ok, strictEqual } from "assert";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

interface InvalidCase {
    readonly fileName: string;
    readonly content: string;
}

interface RunResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
}

const TEST_TIMEOUT_MS: number = 15000;
const MAX_BUFFER_BYTES: number = 16 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const validatorScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "run-json-validator.js");
const transformerScriptPath: string = join(repoRoot, "src", "examples", "json-lib", "run-json-transformer.js");
const invalidCases: readonly InvalidCase[] = [
    {
        fileName: "unterminated-nested-arrays.json",
        content: `${"[".repeat(800)}0${"]".repeat(200)}`
    },
    {
        fileName: "truncated-flat-array.json",
        content: `[${new Array<string>(20000).fill("0").join(",")}`
    },
    {
        fileName: "missing-colon-object.json",
        content: `{"items" ${new Array<string>(8000).fill("0").join(",")}}`
    },
    {
        fileName: "double-comma-array.json",
        content: `[${new Array<string>(12000).fill("1").join(",")},,2]`
    },
    {
        fileName: "unterminated-string-object.json",
        content: `{"text":"${"x".repeat(200000)}`
    }
];

function runJsonScript(scriptPath: string, inputPath: string): RunResult {
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [scriptPath, inputPath, repoRoot], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    return {
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
    };
}

function assertRejectedQuickly(label: string, result: RunResult): void {
    strictEqual(result.signal, null, `${label} should not hang or be killed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    ok(result.status !== 0, `${label} should reject malformed JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    ok(result.stderr.length > 0 || result.stdout.length === 0, `${label} should report a parse failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    ok(!result.stderr.includes("parse_progress_stalled"), `${label} should not hit the new progress guard in normal malformed handling\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const tempDir: string = mkdtempSync(join(tmpdir(), "ironwall-json-lib-progress-"));
try {
    const fixtureDir: string = join(tempDir, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });

    for (const invalidCase of invalidCases) {
        const inputPath: string = join(fixtureDir, invalidCase.fileName);
        writeFileSync(inputPath, invalidCase.content, "utf8");

        const validatorResult: RunResult = runJsonScript(validatorScriptPath, inputPath);
        assertRejectedQuickly(`validator ${invalidCase.fileName}`, validatorResult);

        const transformerResult: RunResult = runJsonScript(transformerScriptPath, inputPath);
        assertRejectedQuickly(`transformer ${invalidCase.fileName}`, transformerResult);
    }

    process.stdout.write(`json-lib-progress-regression cases=${String(invalidCases.length)} ok\n`);
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}