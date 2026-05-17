import { ok } from "assert";
import { join, resolve } from "path";
import { assertRunResult, execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface BackendRun {
    readonly label: string;
    readonly runArgs: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "std-list");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

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

const successCases: readonly SuccessCase[] = [
    {
        name: "core",
        fileName: "test~std~list@main.iw",
        entry: "test~std~list@main",
        expectedLines: ["152"]
    },
    {
        name: "mutation",
        fileName: "test~std~list~mutation@main.iw",
        entry: "test~std~list~mutation@main",
        expectedLines: ["162"]
    },
    {
        name: "repeat",
        fileName: "test~std~list~repeat@main.iw",
        entry: "test~std~list~repeat@main",
        expectedLines: ["125"]
    },
    {
        name: "order-helpers",
        fileName: "test~std~list~ord@main.iw",
        entry: "test~std~list~ord@main",
        expectedLines: ["155"]
    }
];

const abortCases: readonly AbortCase[] = [
    {
        name: "pop-empty",
        fileName: "test~std~list~abort@main.iw",
        entry: "test~std~list~abort@main"
    },
    {
        name: "get-oob",
        fileName: "test~std~list~abort_get_oob@main.iw",
        entry: "test~std~list~abort_get_oob@main"
    },
    {
        name: "set-oob",
        fileName: "test~std~list~abort_set_oob@main.iw",
        entry: "test~std~list~abort_set_oob@main"
    },
    {
        name: "insert-oob",
        fileName: "test~std~list~abort_insert_oob@main.iw",
        entry: "test~std~list~abort_insert_oob@main"
    },
    {
        name: "index-missing",
        fileName: "test~std~list~abort_index_missing@main.iw",
        entry: "test~std~list~abort_index_missing@main"
    },
    {
        name: "max-empty",
        fileName: "test~std~list~ord~abort_empty@main.iw",
        entry: "test~std~list~ord~abort_empty@main"
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
        process.stdout.write(`std-list ${successCase.name} ${run.label} ok\n`);
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
            process.stdout.write(`std-list-abort ${abortCase.name} ${run.label} ok\n`);
        }
    }
}
