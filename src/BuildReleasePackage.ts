import { execFileSync } from "child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { loadIronwallVersionJson } from "./VersionJson";

const repoRoot = resolve(__dirname, "..");
const artifactsRoot = join(repoRoot, "artifacts");
const iwSpecSourceRoot = join(repoRoot, "src", "iw-spec");
const versionJsonPath = join(repoRoot, "src", "version.json");
const fftExampleSourceRoot = join(repoRoot, "src", "Test", "Fixtures", "fft-bigint");
const simpleRaytracerExampleSourceRoot = join(repoRoot, "src", "examples", "raytracer-simple");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const npxCommand = process.platform === "win32" ? "cmd.exe" : "npx";
interface ReleasePackageDefinition {
    readonly name: "release-pkg-linux" | "release-pkg-windows";
    readonly target: "linux-x64" | "windows-x64";
    readonly platformStdSourceRoot: string;
    readonly assetRoot: string;
    readonly validationScriptName: "validate-examples.sh" | "validate-examples.ps1";
    readonly executableName: "ironwall" | "ironwall.exe";
    readonly compilerManualFileName: "iw-compiler-manual-linux-x64.md" | "iw-compiler-manual-windows-x64.md";
    readonly compilerEntryBuildPath: "build/main-release-linux.js" | "build/main-release-windows.js";
}

const generatedExampleArtifactSuffixes = [".out", ".exe", ".o", ".obj", ".a", ".lib", ".tgz"];
const preservedExampleArtifactRelativePaths = new Set<string>();
const releasePackages: readonly ReleasePackageDefinition[] = [
    {
        name: "release-pkg-linux",
        target: "linux-x64",
        platformStdSourceRoot: join(repoRoot, "src", "std-linux"),
        assetRoot: join(repoRoot, "release-package-linux"),
        validationScriptName: "validate-examples.sh",
        executableName: "ironwall",
        compilerManualFileName: "iw-compiler-manual-linux-x64.md",
        compilerEntryBuildPath: "build/main-release-linux.js"
    },
    {
        name: "release-pkg-windows",
        target: "windows-x64",
        platformStdSourceRoot: join(repoRoot, "src", "std-windows"),
        assetRoot: join(repoRoot, "release-package-windows"),
        validationScriptName: "validate-examples.ps1",
        executableName: "ironwall.exe",
        compilerManualFileName: "iw-compiler-manual-windows-x64.md",
        compilerEntryBuildPath: "build/main-release-windows.js"
    }
] as const;

function padTimestampPart(value: number): string {
    return value.toString().padStart(2, "0");
}

function makeReleasePackageTimestamp(date: Date): string {
    return [
        date.getFullYear().toString(),
        padTimestampPart(date.getMonth() + 1),
        padTimestampPart(date.getDate()),
        "-",
        padTimestampPart(date.getHours()),
        padTimestampPart(date.getMinutes()),
        padTimestampPart(date.getSeconds())
    ].join("");
}

function resolveRequestedReleasePackages(argv: readonly string[]): readonly ReleasePackageDefinition[] {
    if (argv.length === 0) {
        return releasePackages;
    }

    const aliases = new Map<string, ReleasePackageDefinition>([
        ["linux", releasePackages[0]],
        ["linux-x64", releasePackages[0]],
        ["release-pkg-linux", releasePackages[0]],
        ["windows", releasePackages[1]],
        ["windows-x64", releasePackages[1]],
        ["release-pkg-windows", releasePackages[1]]
    ]);
    const selected: ReleasePackageDefinition[] = [];
    for (const rawArg of argv) {
        const key = rawArg.trim().toLowerCase();
        const packageDef = aliases.get(key);
        if (packageDef === undefined) {
            throw new Error(`Unknown release package target '${rawArg}'. Expected linux|windows|linux-x64|windows-x64|release-pkg-linux|release-pkg-windows.`);
        }
        if (!selected.includes(packageDef)) {
            selected.push(packageDef);
        }
    }
    return selected;
}

function extractExecErrorText(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const stderr = "stderr" in error
        ? (error as Error & { stderr?: string | Buffer }).stderr
        : undefined;
    if (Buffer.isBuffer(stderr)) {
        const text = stderr.toString("utf8").trim();
        if (text.length > 0) {
            return text;
        }
    }
    if (typeof stderr === "string") {
        const text = stderr.trim();
        if (text.length > 0) {
            return text;
        }
    }
    return error.message;
}

function execOrThrow(command: string, args: readonly string[], label: string): void {
    try {
        execFileSync(command, [...args], {
            cwd: repoRoot,
            stdio: "pipe"
        });
    } catch (error) {
        throw new Error(`${label} failed:\n${extractExecErrorText(error)}`);
    }
}

function buildNpxArgs(args: readonly string[]): readonly string[] {
    return process.platform === "win32"
        ? ["/d", "/s", "/c", "npx", ...args]
        : args;
}

function buildReleaseCompiler(outputPath: string, version: string, compilerEntryBuildPath: ReleasePackageDefinition["compilerEntryBuildPath"]): void {
    const bootstrapExecutablePath = process.env.IRONWALL_RELEASE_BOOTSTRAP_EXE;
    if (bootstrapExecutablePath !== undefined && bootstrapExecutablePath.trim().length > 0) {
        copyFileSync(resolve(bootstrapExecutablePath), outputPath);
        chmodSync(outputPath, 0o755);
        return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "ironwall-release-sea-"));
    try {
        const bundlePath = join(tempDir, "ironwall.bundle.cjs");
        const blobPath = join(tempDir, "ironwall.blob");
        const seaConfigPath = join(tempDir, "sea-config.json");

        execOrThrow(npxCommand, buildNpxArgs([
            "--yes",
            "esbuild",
            compilerEntryBuildPath,
            "--bundle",
            "--platform=node",
            "--format=cjs",
            `--define:process.env.IRONWALL_RELEASE_VERSION=${JSON.stringify(version)}`,
            `--outfile=${bundlePath}`,
        ]), "release esbuild bundle");

        writeFileSync(seaConfigPath, `${JSON.stringify({
            main: bundlePath,
            disableExperimentalSEAWarning: true,
            output: blobPath,
        }, null, 2)}\n`, "utf8");

        execOrThrow(process.execPath, ["--experimental-sea-config", seaConfigPath], "release SEA blob generation");

        copyFileSync(process.execPath, outputPath);
        chmodSync(outputPath, 0o755);

        execOrThrow(npxCommand, buildNpxArgs([
            "--yes",
            "postject",
            outputPath,
            "NODE_SEA_BLOB",
            blobPath,
            "--sentinel-fuse",
            seaFuse,
        ]), "release postject injection");

        chmodSync(outputPath, 0o755);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function copyEnglishSpecDirectory(outputSpecRoot: string): void {
    cpSync(join(iwSpecSourceRoot, "en"), join(outputSpecRoot, "en"), { recursive: true });
}

function removeGeneratedExampleArtifacts(rootPath: string, relativePath = ""): void {
    if (!existsSync(rootPath)) {
        return;
    }

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = join(rootPath, entry.name);
        const entryRelativePath = relativePath.length === 0 ? entry.name : join(relativePath, entry.name);
        if (entry.isDirectory()) {
            removeGeneratedExampleArtifacts(entryPath, entryRelativePath);
            continue;
        }
        if (preservedExampleArtifactRelativePaths.has(entryRelativePath)) {
            continue;
        }
        if (generatedExampleArtifactSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
            rmSync(entryPath, { force: true });
        }
    }
}

function writeBuildConfig(path: string, target: ReleasePackageDefinition["target"], main: string, output: string): void {
    writeFileSync(path, `${JSON.stringify({
        mode: "build",
        target,
        directories: [{ path: "src" }],
        main,
        output,
        precompiledLibs: [],
        ffiLibs: []
    }, null, 2)}\n`, "utf8");
}

function rewriteExampleBuildConfigs(examplesRoot: string, packageDef: ReleasePackageDefinition): void {
    const executableSuffix = packageDef.target === "windows-x64" ? ".exe" : ".out";
    const ffiLibName = packageDef.target === "windows-x64" ? "libffi_example.lib" : "libffi_example.a";

    writeFileSync(join(examplesRoot, "hello-argv", "build-iw.json"), `${JSON.stringify({
        mode: "build",
        target: packageDef.target,
        directories: [{ path: "src" }],
        main: "example~hello~argv@main",
        output: `../build/hello-argv${executableSuffix}`,
        precompiledLibs: [],
        ffiLibs: []
    }, null, 2)}\n`, "utf8");

    writeFileSync(join(examplesRoot, "module-global-state", "build-iw.json"), `${JSON.stringify({
        mode: "build",
        target: packageDef.target,
        directories: [{ path: "src" }],
        main: "example~module~global~state~app@main",
        output: `../build/module-global-state${executableSuffix}`,
        precompiledLibs: [],
        ffiLibs: []
    }, null, 2)}\n`, "utf8");

    writeFileSync(join(examplesRoot, "ffi-static-lib", "build-iw.json"), `${JSON.stringify({
        mode: "build",
        target: packageDef.target,
        directories: [{ path: "src" }],
        main: "example~ffi~static@main",
        output: `../build/ffi-static-lib${executableSuffix}`,
        precompiledLibs: [],
        ffiLibs: [`../build/native/${ffiLibName}`]
    }, null, 2)}\n`, "utf8");

    writeFileSync(join(examplesRoot, "precompiled-lib", "lib", "build-iw.json"), `${JSON.stringify({
        mode: "pack-lib",
        target: packageDef.target,
        directories: [{ path: "src" }],
        output: "../../build/example-precompiled-lib.tgz",
        precompiledLibs: [],
        ffiLibs: []
    }, null, 2)}\n`, "utf8");

    writeFileSync(join(examplesRoot, "precompiled-lib", "app", "build-iw.json"), `${JSON.stringify({
        mode: "build",
        target: packageDef.target,
        directories: [{ path: "src" }],
        main: "test~precompiled~app@main",
        output: `../../build/precompiled-app${executableSuffix}`,
        precompiledLibs: ["../../build/example-precompiled-lib.tgz"],
        ffiLibs: []
    }, null, 2)}\n`, "utf8");
}

function copyAdditionalReleaseExamples(examplesRoot: string, packageDef: ReleasePackageDefinition): void {
    const executableSuffix = packageDef.target === "windows-x64" ? ".exe" : ".out";
    const fftTargetRoot = join(examplesRoot, "fft-bigint");
    cpSync(fftExampleSourceRoot, join(fftTargetRoot, "src"), { recursive: true });
    writeBuildConfig(join(fftTargetRoot, "build-iw.json"), packageDef.target, "test~fft~bigint@main", `../build/fft-bigint${executableSuffix}`);

    const raytracerTargetRoot = join(examplesRoot, "raytracer-simple");
    rmSync(join(examplesRoot, "raytracer"), { recursive: true, force: true });
    rmSync(raytracerTargetRoot, { recursive: true, force: true });
    cpSync(simpleRaytracerExampleSourceRoot, raytracerTargetRoot, { recursive: true });
    if (existsSync(join(raytracerTargetRoot, "build-iw.json"))) {
        writeBuildConfig(join(raytracerTargetRoot, "build-iw.json"), packageDef.target, "ray~tracer~simple@main", `../build/raytracer-simple${executableSuffix}`);
    }
    if (packageDef.target === "windows-x64") {
        const raytracerEntryPath = join(raytracerTargetRoot, "src", "ray~tracer~simple@main.iw");
        writeFileSync(
            raytracerEntryPath,
            readFileSync(raytracerEntryPath, "utf8").replace("(import std~linux~sys)", "(import std~windows~sys)"),
            "utf8"
        );
    }
}

function makeExamplesReadme(packageDef: ReleasePackageDefinition): string {
    const isWindows = packageDef.target === "windows-x64";
    const validationCommand = isWindows
        ? "powershell -ExecutionPolicy Bypass -File .\\validate-examples.ps1"
        : "bash ./validate-examples.sh";
    const cleanCommand = isWindows
        ? "powershell -ExecutionPolicy Bypass -File .\\validate-examples.ps1 -Clean"
        : "bash ./validate-examples.sh clean";
    const cliCommand = isWindows ? ".\\ironwall.exe" : "./ironwall";
    const shellLanguage = isWindows ? "powershell" : "bash";
    const helloRun = isWindows ? ".\\examples\\build\\hello-argv.exe a bb ccc" : "./examples/build/hello-argv.out a bb ccc";
    const moduleRun = isWindows ? ".\\examples\\build\\module-global-state.exe" : "./examples/build/module-global-state.out";
    const ffiBuildNative = isWindows
        ? "powershell -ExecutionPolicy Bypass -File .\\examples\\ffi-static-lib\\native\\build-native.ps1"
        : "bash examples/ffi-static-lib/native/build-native.sh";
    const ffiRun = isWindows ? ".\\examples\\build\\ffi-static-lib.exe" : "./examples/build/ffi-static-lib.out";
    const precompiledRun = isWindows ? ".\\examples\\build\\precompiled-app.exe" : "./examples/build/precompiled-app.out";
    const fftRun = isWindows ? ".\\examples\\build\\fft-bigint.exe" : "./examples/build/fft-bigint.out";
    const raytracerRun = isWindows
        ? ".\\examples\\build\\raytracer-simple.exe .\\examples\\build\\raytracer-simple.ppm 24 18"
        : "./examples/build/raytracer-simple.out ./examples/build/raytracer-simple.ppm 24 18";

    return `# Release Examples\n\nRun the package self-check first:\n\n\`\`\`${shellLanguage}\n${validationCommand}\n\`\`\`\n\nClean the generated artifacts under \`examples/build/\`:\n\n\`\`\`${shellLanguage}\n${cleanCommand}\n\`\`\`\n\nAll commands below are intended to run from the release package root. Build outputs are written to \`examples/build/\`.\n\n## hello-argv\n\n\`\`\`${shellLanguage}\n${cliCommand} ${isWindows ? "examples\\hello-argv\\build-iw.json" : "examples/hello-argv/build-iw.json"}\n${helloRun}\n\`\`\`\n\nExpected result: \`123\`\n\n## module-global-state\n\n\`\`\`${shellLanguage}\n${cliCommand} ${isWindows ? "examples\\module-global-state\\build-iw.json" : "examples/module-global-state/build-iw.json"}\n${moduleRun}\n\`\`\`\n\nExpected result: \`100\`\n\n## ffi-static-lib\n\n\`\`\`${shellLanguage}\n${ffiBuildNative}\n${cliCommand} ${isWindows ? "examples\\ffi-static-lib\\build-iw.json" : "examples/ffi-static-lib/build-iw.json"}\n${ffiRun}\n\`\`\`\n\nExpected result: \`-31\`\n\n## precompiled-lib\n\n\`\`\`${shellLanguage}\n${cliCommand} ${isWindows ? "examples\\precompiled-lib\\lib\\build-iw.json" : "examples/precompiled-lib/lib/build-iw.json"}\n${cliCommand} ${isWindows ? "examples\\precompiled-lib\\app\\build-iw.json" : "examples/precompiled-lib/app/build-iw.json"}\n${precompiledRun}\n\`\`\`\n\nExpected result: \`15\`\n\n## fft-bigint\n\n\`\`\`${shellLanguage}\n${cliCommand} ${isWindows ? "examples\\fft-bigint\\build-iw.json" : "examples/fft-bigint/build-iw.json"}\n${fftRun}\n\`\`\`\n\nExpected output is six lines: \`fft_0008_ok\`, \`fft_0016_ok\`, \`fft_0032_ok\`, \`fft_0064_ok\`, \`fft_f6_0064_ok\`, and \`fft_f7_0065_ok\`.\n\n## raytracer-simple\n\n\`\`\`${shellLanguage}\n${cliCommand} ${isWindows ? "examples\\raytracer-simple\\build-iw.json" : "examples/raytracer-simple/build-iw.json"}\n${raytracerRun}\n\`\`\`\n\nExpected result: \`examples/build/raytracer-simple.ppm\` is created and its first line is \`P3\`.\n`;
}

function writeExamplesReadme(examplesRoot: string, packageDef: ReleasePackageDefinition): void {
    writeFileSync(join(examplesRoot, "README.md"), `${makeExamplesReadme(packageDef)}\n`, "utf8");
}

function removeOppositePlatformAssets(outputRoot: string, packageDef: ReleasePackageDefinition): void {
    const ffiNativeRoot = join(outputRoot, "examples", "ffi-static-lib", "native");
    if (packageDef.target === "windows-x64") {
        rmSync(join(ffiNativeRoot, "build-native.sh"), { force: true });
    } else {
        rmSync(join(ffiNativeRoot, "build-native.ps1"), { force: true });
    }
    rmSync(join(outputRoot, "examples", "ffi-sqlite-linux"), { recursive: true, force: true });
    rmSync(join(outputRoot, "examples", "ffi-sqlite-windows"), { recursive: true, force: true });
    rmSync(join(outputRoot, "examples", "ffi-sqlite"), { recursive: true, force: true });
}

function buildReleasePackage(packageDef: ReleasePackageDefinition, version: string, timestamp: string): string {
    const outputRoot = join(artifactsRoot, `${packageDef.name}-${timestamp}`);
    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(outputRoot, { recursive: true });

    buildReleaseCompiler(join(outputRoot, packageDef.executableName), version, packageDef.compilerEntryBuildPath);
    const outputStdRoot = join(outputRoot, "std");
    cpSync(join(repoRoot, "src", "std"), outputStdRoot, { recursive: true });
    cpSync(packageDef.platformStdSourceRoot, outputStdRoot, { recursive: true });
    cpSync(join(packageDef.assetRoot, "runtime"), join(outputRoot, "runtime"), { recursive: true });
    copyFileSync(versionJsonPath, join(outputRoot, "version.json"));
    copyFileSync(join(packageDef.assetRoot, packageDef.compilerManualFileName), join(outputRoot, packageDef.compilerManualFileName));
    cpSync(join(packageDef.assetRoot, "examples"), join(outputRoot, "examples"), { recursive: true });
    rewriteExampleBuildConfigs(join(outputRoot, "examples"), packageDef);
    copyAdditionalReleaseExamples(join(outputRoot, "examples"), packageDef);
    writeExamplesReadme(join(outputRoot, "examples"), packageDef);
    cpSync(join(packageDef.assetRoot, "cheader"), join(outputRoot, "cheader"), { recursive: true });
    copyFileSync(join(packageDef.assetRoot, packageDef.validationScriptName), join(outputRoot, packageDef.validationScriptName));
    removeOppositePlatformAssets(outputRoot, packageDef);

    removeGeneratedExampleArtifacts(join(outputRoot, "examples"));

    const outputSpecRoot = join(outputRoot, "iw-spec");
    mkdirSync(outputSpecRoot, { recursive: true });
    copyEnglishSpecDirectory(outputSpecRoot);

    if (existsSync(join(outputRoot, "examples", "ffi-static-lib", "native", "build-native.sh"))) {
        chmodSync(join(outputRoot, "examples", "ffi-static-lib", "native", "build-native.sh"), 0o755);
    }
    if (packageDef.validationScriptName === "validate-examples.sh") {
        chmodSync(join(outputRoot, packageDef.validationScriptName), 0o755);
    }
    return outputRoot;
}

function main(): void {
    const versionJson = loadIronwallVersionJson(versionJsonPath);
    const requestedPackages = resolveRequestedReleasePackages(process.argv.slice(2));
    const timestamp = makeReleasePackageTimestamp(new Date());
    const builtRoots = requestedPackages.map((packageDef) => buildReleasePackage(packageDef, versionJson.version, timestamp));
    for (const builtRoot of builtRoots) {
        process.stdout.write(`Built release package: ${builtRoot}\n`);
    }
}

main();
