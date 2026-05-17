import { ok, strictEqual } from "assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "x64-support-c");
const entryUnitId = "test~x64~support_c@main";

interface BuildInfoRecord {
    readonly filePath: string;
    readonly sha256: string;
}

interface OutputBuildInfo {
    readonly format: "iw-output-cache";
    readonly version: 1;
    readonly command: "emit-backend-ir";
    readonly sourceFiles: readonly BuildInfoRecord[];
    readonly dependencyFiles: readonly BuildInfoRecord[];
    readonly outputFiles: readonly BuildInfoRecord[];
}

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-output-cache-test-"));
const outputPath = join(tempDir, "program.backend.ir");
const buildInfoPath = `${outputPath}.buildinfo.json`;

try {
    execBuildJsonCliSync(cliPath, [
        "emit-backend-ir",
        fixtureDir,
        "--entry",
        entryUnitId,
        "--out",
        outputPath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "c-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    ok(statSync(outputPath).isFile(), "emit-backend-ir should write the requested output file");
    ok(statSync(buildInfoPath).isFile(), "emit-backend-ir should write a sibling buildinfo manifest");

    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as OutputBuildInfo;
    strictEqual(buildInfo.format, "iw-output-cache");
    strictEqual(buildInfo.version, 1);
    strictEqual(buildInfo.command, "emit-backend-ir");
    ok(buildInfo.sourceFiles.some((record) => record.filePath.endsWith("test~x64~support_c@main.iw")), "buildinfo should record the root source file");
    ok(buildInfo.dependencyFiles.some((record) => record.filePath.endsWith("std~math@v1.iw")), "buildinfo should include the actually imported std~math dependency");
    ok(!buildInfo.dependencyFiles.some((record) => record.filePath.endsWith("std~dict@v1.iw")), "buildinfo should exclude unrelated std packages from dependency closure");
    strictEqual(buildInfo.outputFiles.length, 1, "buildinfo should record exactly one emitted output file");
    strictEqual(resolve(buildInfo.outputFiles[0].filePath), resolve(outputPath), "buildinfo should point at the emitted output path");

    const firstOutputMtime = statSync(outputPath).mtimeMs;
    const firstBuildInfoMtime = statSync(buildInfoPath).mtimeMs;

    execBuildJsonCliSync(cliPath, [
        "emit-backend-ir",
        fixtureDir,
        "--entry",
        entryUnitId,
        "--out",
        outputPath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "c-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    strictEqual(statSync(outputPath).mtimeMs, firstOutputMtime, "cache hit should reuse the existing backend-ir output without rewriting it");
    strictEqual(statSync(buildInfoPath).mtimeMs, firstBuildInfoMtime, "cache hit should reuse the existing buildinfo manifest without rewriting it");

    process.stdout.write("normal output cache dependency analysis ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}