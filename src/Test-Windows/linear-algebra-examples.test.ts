import { join, resolve } from "path";
import { assertRunResult, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

interface ExampleRun {
    readonly label: string;
    readonly entry: string;
    readonly expectedLines: readonly string[];
}

interface BackendRun {
    readonly label: string;
    readonly args: readonly string[];
}

const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const exampleDir = join(repoRoot, "src", "examples", "linear-algebra");
const x64FrontendArgs = ["--frontend-profile", "no-optimized"] as const;

const backends: readonly BackendRun[] = [
    {
        label: "c-backend",
        args: ["--backend-profile", "c-backend"]
    },
    {
        label: "optimized-x64-backend",
        args: [...x64FrontendArgs, "--backend-profile", "optimized-x64-backend"]
    },
    {
        label: "no-optimized-backend",
        args: [...x64FrontendArgs, "--backend-profile", "no-optimized-backend"]
    }
];

const examples: readonly ExampleRun[] = [
    {
        label: "lu",
        entry: "app~linear~algebra~lu@main",
        expectedLines: [
            "lu ok",
            "l-subdiag-sum-x1000=49500",
            "u-diag-sum-x1000=5350000",
            "u-last-diag-x1000=103000",
            "reconstruction-error-x1000000=0"
        ]
    },
    {
        label: "qr",
        entry: "app~linear~algebra~qr@main",
        expectedLines: [
            "qr ok",
            "q-trace-x1000=100000",
            "r-diag-sum-x1000=5050000",
            "r-last-diag-x1000=100000",
            "reconstruction-error-x1000000=0",
            "orthogonality-error-x1000000=0"
        ]
    },
    {
        label: "qr-eigen",
        entry: "app~linear~algebra~qr~eigen@main",
        expectedLines: [
            "eigen-qr ok",
            "lambda-max-x1000=201000",
            "lambda-min-x1000=102000",
            "trace-x1000=15150000",
            "offdiag-sum-x1000=0"
        ]
    },
    {
        label: "conjugate-gradient",
        entry: "app~linear~algebra~conjugate~gradient@main",
        expectedLines: [
            "cg ok",
            "iterations=2",
            "x-sum-x1000=100000",
            "x0-x1000=1000",
            "x-last-x1000=1000",
            "residual-x1000000=0"
        ]
    }
];

for (const backend of backends) {
    for (const example of examples) {
        const result = spawnBuildJsonCliSync(cliPath, [
            "run",
            exampleDir,
            "--entry",
            example.entry,
            ...backend.args
        ], {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: 120000
        });

        assertRunResult(result, example.expectedLines, 0, `${example.label} ${backend.label}`);
        process.stdout.write(`linear-algebra ${example.label} ${backend.label} ok\n`);
    }
}