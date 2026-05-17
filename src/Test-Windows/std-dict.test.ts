import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

interface SuccessCase {
    readonly name: string;
    readonly fileName: string;
    readonly entry: string;
    readonly expectedLines: readonly string[];
}

interface AbortCase {
    readonly name: string;
    readonly fileName: string;
    readonly entry: string;
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "std-dict");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const successCases: readonly SuccessCase[] = [
    {
        name: "core",
        fileName: "test~std~dict@main.iw",
        entry: "test~std~dict@main",
        expectedLines: ["817"]
    },
    {
        name: "resize",
        fileName: "test~std~dict~resize@main.iw",
        entry: "test~std~dict~resize@main",
        expectedLines: ["770"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "pop-missing",
        fileName: "test~std~dict~abort_pop@main.iw",
        entry: "test~std~dict~abort_pop@main"
    },
    {
        name: "popitem-empty",
        fileName: "test~std~dict~abort_popitem@main.iw",
        entry: "test~std~dict~abort_popitem@main"
    }
];

const runs: readonly BackendRun[] = [
    {
        label: "c-backend",
        runArgs: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        runArgs: [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

execBuildJsonCliSync(cliPath, ["check", fixtureDir], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
});

for (const successCase of successCases) {
    const inputPath = join(fixtureDir, successCase.fileName);
    for (const run of runs) {
        const result = spawnBuildJsonCliSync(cliPath, ["run", inputPath, "--entry", successCase.entry, ...run.runArgs], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        assertRunResult(result, [], Number(successCase.expectedLines[0]) & 0xff, `${run.label} ${successCase.name}`);
        process.stdout.write(`std-dict ${successCase.name} ${run.label} ok\n`);
    }
}

for (const abortCase of abortCases) {
    const inputPath = join(fixtureDir, abortCase.fileName);
    for (const run of runs) {
        try {
            execBuildJsonCliSync(cliPath, ["run", inputPath, "--entry", abortCase.entry, ...run.runArgs], {
                cwd: repoRoot,
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024
            });
            throw new Error(`${run.label} ${abortCase.name} unexpectedly completed successfully`);
        } catch (error) {
            if (error instanceof Error && error.message.includes("unexpectedly completed successfully")) {
                throw error;
            }
            const execError = error as Error & { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
            ok(
                execError.signal !== null || (typeof execError.status === "number" && execError.status !== 0),
                `${run.label} ${abortCase.name} should fail with a non-zero exit, got status=${String(execError.status)} signal=${String(execError.signal)} stdout=${execError.stdout ?? ""} stderr=${execError.stderr ?? ""}`
            );
            ok(
                (execError.stderr ?? "").includes("Ironwall unreachable: exhaustive match failed at runtime"),
                `${run.label} ${abortCase.name} should report the runtime abort message, got stderr=${execError.stderr ?? ""}`
            );
            process.stdout.write(`std-dict-abort ${abortCase.name} ${run.label} ok\n`);
        }
    }
}
