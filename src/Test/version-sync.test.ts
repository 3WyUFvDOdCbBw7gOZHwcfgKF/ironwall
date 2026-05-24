import { execFileSync } from "child_process";
import { strictEqual } from "assert";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { formatIronwallVersionLine, IRONWALL_VERSION } from "../IronwallVersion";
import { computeIronwallVersionChecksum, validateIronwallVersionJson } from "../VersionJson";

const repoRoot = resolve(__dirname, "..", "..");
const devCliPath = join(repoRoot, "build", "main.js");
const releaseCliPath = join(repoRoot, "build", "main-release.js");
const versionJsonPath = join(repoRoot, "src", "version.json");

const versionJson = validateIronwallVersionJson(JSON.parse(readFileSync(versionJsonPath, "utf8")));
strictEqual(versionJson.checksum, computeIronwallVersionChecksum(versionJson.version, versionJson.uuid), "version.json checksum must be sha256(version+uuid)");
strictEqual(IRONWALL_VERSION, versionJson.version, "IronwallVersion.ts must stay in sync with version.json version");

const expectedVersionLine = formatIronwallVersionLine();
const devVersionOutput = execFileSync(process.execPath, [devCliPath, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
}).trim();
strictEqual(devVersionOutput, expectedVersionLine, `unexpected dev CLI version output\n${devVersionOutput}`);

const releaseVersionOutput = execFileSync(process.execPath, [releaseCliPath, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000
}).trim();
strictEqual(releaseVersionOutput, expectedVersionLine, `unexpected release CLI version output\n${releaseVersionOutput}`);

process.stdout.write("version-sync ok\n");
