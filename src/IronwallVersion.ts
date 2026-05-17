import { existsSync } from "fs";
import { join, resolve } from "path";
import { loadIronwallVersionJson } from "./VersionJson";

function loadVersion(): string {
    if (process.env.IRONWALL_RELEASE_VERSION !== undefined) {
        return process.env.IRONWALL_RELEASE_VERSION;
    }

    const repoRoot = resolve(__dirname, "..");
    const versionJsonPath = join(repoRoot, "src", "version.json");
    if (!existsSync(versionJsonPath)) {
        throw new Error(`Missing version.json: ${versionJsonPath}`);
    }
    return loadIronwallVersionJson(versionJsonPath).version;
}

export const IRONWALL_VERSION = loadVersion();

export function formatIronwallVersionLine(): string {
    return `ironwall ${IRONWALL_VERSION}`;
}
