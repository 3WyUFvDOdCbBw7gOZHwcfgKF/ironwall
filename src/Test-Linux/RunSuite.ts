import { join } from "path";
import { runBuiltTestSuite } from "../Test/RunSuiteSupport";

runBuiltTestSuite({
    suiteName: "linux-suite",
    buildTestDirs: [
        join(__dirname, "..", "Test"),
        __dirname
    ],
    env: {
        IW_TEST_TARGET: "linux-x64"
    }
});
