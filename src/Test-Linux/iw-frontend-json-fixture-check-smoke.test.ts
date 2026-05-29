import { execBuildJsonCliSync } from "../Test/BuildJsonCliHarness";
import { join, resolve } from "path";
import { ensureCurrentNodeProcessHasMemoryLimit } from "../Test/NodeMemoryLimit";

ensureCurrentNodeProcessHasMemoryLimit();

class FixtureCheckCase {
    public readonly label: string;
    public readonly inputPath: string;
    public readonly includePaths: readonly string[];

    public constructor(label0: string, inputPath0: string, includePaths0: readonly string[] = []) {
        this.label = label0;
        this.inputPath = inputPath0;
        this.includePaths = includePaths0;
    }
}

const TEST_TIMEOUT_MS: number = 240000;
const MAX_BUFFER_BYTES: number = 32 * 1024 * 1024;
const repoRoot: string = resolve(__dirname, "..", "..");
const cliPath: string = join(repoRoot, "build", "main.js");
const commandPath: string = join(repoRoot, "src", "examples", "json-lib", "run-iw-frontend-json.js");
const fixtureCases: readonly FixtureCheckCase[] = [
    new FixtureCheckCase(
        "language-rules app",
        join(repoRoot, "src", "Test", "Fixtures", "language-rules", "test~language~rules~app@main.iw"),
        [join(repoRoot, "src", "Test", "Fixtures", "language-rules", "test~language~rules~lib@defs.iw")]
    )
];

const previousCommand: string | undefined = process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = commandPath;

try {
    for (const fixtureCase of fixtureCases) {
        const cliArgs: string[] = ["check", fixtureCase.inputPath];
        for (const includePath of fixtureCase.includePaths) {
            cliArgs.push("--include", includePath);
        }
        execBuildJsonCliSync(cliPath, cliArgs, {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: TEST_TIMEOUT_MS
        });
        process.stdout.write(`iw-frontend-json-fixture-check-smoke ${fixtureCase.label} ok\n`);
    }
} finally {
    if (previousCommand === undefined) {
        delete process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND;
    } else {
        process.env.IW_EXTERNAL_FRONTEND_JSON_COMMAND = previousCommand;
    }
}
