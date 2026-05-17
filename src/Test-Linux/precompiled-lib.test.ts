import { execFileSync } from "child_process";
import { ok, strictEqual } from "assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { disposeLoadedPrecompiledLibraries, loadPrecompiledLibraryArchives } from "../PrecompiledLib";
import { execBuildJsonCliSync, spawnBuildJsonCliSync } from "./BuildJsonCliHarness";

const TEST_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "..", "..");
const cliPath = join(repoRoot, "build", "main.js");
const fixtureRoot = join(repoRoot, "src", "Test-Linux", "Fixtures", "precompiled-lib");
const libDir = join(fixtureRoot, "lib");
const appDir = join(fixtureRoot, "app");
const missingDir = join(fixtureRoot, "missing");
const entryUnitId = "test~precompiled~app@main";

function normalizeLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

const tempDir = mkdtempSync(join(tmpdir(), "ironwall-precompiled-lib-test-"));
const archivePath = join(tempDir, "test-precompiled-lib.tgz");
const cacheDir = `${archivePath}.cache`;

try {
    const packOutput = execBuildJsonCliSync(cliPath, [
        "pack-lib",
        libDir,
        "--out",
        archivePath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "no-optimized-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    ok(packOutput.includes(`Packed lib: ${archivePath}`), `pack-lib output mismatch\n${packOutput}`);
    ok(statSync(archivePath).isFile(), "pack-lib should create a tgz archive");
    ok(statSync(cacheDir).isDirectory(), "pack-lib should emit a per-unit cache directory next to the archive output");
    const cacheEntries = readdirSync(cacheDir).sort();
    ok(cacheEntries.some((entry) => entry.endsWith(".json")), `pack-lib cache should include per-unit manifests\n${cacheEntries.join("\n")}`);
    ok(cacheEntries.some((entry) => entry.endsWith(".s")), `pack-lib cache should include per-unit assembly artifacts\n${cacheEntries.join("\n")}`);
    ok(cacheEntries.some((entry) => entry.endsWith(".c")), `pack-lib cache should include per-unit support artifacts\n${cacheEntries.join("\n")}`);
    const archiveEntriesOutput: string = execFileSync("tar", ["-tzf", archivePath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    const archiveEntries: string[] = normalizeLines(archiveEntriesOutput).map((entry: string) => (
        entry.startsWith("./")
            ? entry.slice(2)
            : entry
    ));
    ok(archiveEntries.includes("manifest.json"), `source-less lib archive should include manifest.json\n${archiveEntriesOutput}`);
    ok(archiveEntries.some((entry: string) => entry.startsWith("asm/")), `source-less lib archive should include per-unit asm artifacts\n${archiveEntriesOutput}`);
    ok(archiveEntries.some((entry: string) => entry.startsWith("support/")), `source-less lib archive should include per-unit support artifacts\n${archiveEntriesOutput}`);
    ok(!archiveEntries.some((entry: string) => entry.startsWith("sources/")), `source-less lib archive should not include source bundles\n${archiveEntriesOutput}`);
    ok(!archiveEntries.includes("library.s"), `source-less lib archive should not flatten units into a single library.s\n${archiveEntriesOutput}`);

    const loadedLibraries = loadPrecompiledLibraryArchives([archivePath]);
    try {
        strictEqual(loadedLibraries.length, 1, "expected exactly one loaded precompiled library");
        const loadedLibrary = loadedLibraries[0];
        const manifest = loadedLibrary.manifest;

        strictEqual(manifest.format, "iw-precompiled-lib");
        strictEqual(manifest.version, 2);
        strictEqual(loadedLibrary.compiledUnits.length, 2, "source-less lib should carry exactly two compiled units");
        ok(
            loadedLibrary.compiledUnits.every((unit) => statSync(unit.assemblyPath).isFile() && statSync(unit.supportPath).isFile()),
            "packed library should include per-unit asm and support artifacts"
        );
        ok(
            loadedLibrary.compiledUnits.every((unit) => {
                const assemblyText = readFileSync(unit.assemblyPath, "utf8");
                return assemblyText.endsWith("\n") && assemblyText.includes('.section .note.GNU-stack,"",@progbits');
            }),
            "packed library assembly artifacts should end with a trailing newline and declare GNU-stack"
        );
        ok(
            manifest.compiledUnits.every((unit) => (
                unit.assemblyPath.startsWith("asm/")
                && unit.supportPath.startsWith("support/")
                && unit.metadataTableExportSymbol.length > 0
                && unit.globalTableExportSymbol.length > 0
                && unit.runtimeInitExportSymbol.length > 0
                && unit.buildInfo !== undefined
                && unit.buildInfo.sourceFiles.length > 0
                && unit.buildInfo.outputFiles.length === 2
            )),
            "manifest should describe per-unit asm/support paths, exported GC/runtime symbols, and build provenance"
        );
        ok(manifest.functionSignatures.some((signature) => signature.canonicalName === "test~precompiled~lib@prime_triple_i5"), "manifest should include fully qualified function signatures");
        ok(manifest.globalSignatures.some((signature) => signature.canonicalName === "test~precompiled~lib@seed_value"), "manifest should include fully qualified global signatures");
        ok(manifest.genericClassSignatures.some((signature) => signature.fullName === "test~precompiled~lib@Box"), "manifest should include fully qualified generic class signatures");
        ok(manifest.genericFunctionSignatures.some((signature) => signature.fullName === "test~precompiled~lib@make_box"), "manifest should include fully qualified generic function signatures");
        ok(
            manifest.functionSignatures.some((signature) => signature.canonicalName === "test~precompiled~lib@prime_triple_i5" && signature.concreteSymbol === "test~precompiled~lib@prime_triple_i5"),
            "manifest should preserve fully qualified concrete function symbols"
        );

        const makeBoxMonomorphs = manifest.monomorphizedFunctions.filter((record) => record.sourceGenericName === "test~precompiled~lib@make_box");
        ok(makeBoxMonomorphs.some((record) => record.typeArgs.length === 1 && record.typeArgs[0].kind === "primitive" && record.typeArgs[0].name === "i5"), "manifest should include primitive make_box monomorph entries");
        ok(
            makeBoxMonomorphs.some((record) => record.concreteName.includes("test~precompiled~lib@make_box")),
            "manifest should preserve fully qualified pkg names inside monomorphized function symbols"
        );
        ok(
            makeBoxMonomorphs.some(
                (record) => record.typeArgs.length === 1
                    && record.typeArgs[0].kind === "class"
                    && record.typeArgs[0].className.startsWith("__iw_mono_class_test~precompiled~lib@Box_")
            ),
            "manifest should retain fully qualified nested generic endtype class names"
        );
        ok(
            manifest.monomorphizedClasses.some((record) => (
                record.sourceGenericName === "test~precompiled~lib@Box"
                && record.concreteName.includes("test~precompiled~lib@Box")
                && record.typeArgs.length === 1
                && record.typeArgs[0].kind === "class"
            )),
            "manifest should include Box monomorph entries keyed by normalized endtype class names"
        );
    } finally {
        disposeLoadedPrecompiledLibraries(loadedLibraries);
    }

    execBuildJsonCliSync(cliPath, ["check", appDir, "--lib", archivePath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });

    const x64RunResult = spawnBuildJsonCliSync(cliPath, [
        "run",
        appDir,
        "--entry",
        entryUnitId,
        "--lib",
        archivePath,
        "--frontend-profile",
        "no-optimized",
        "--backend-profile",
        "no-optimized-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    strictEqual(x64RunResult.signal, null, `x64 source-less precompiled lib signal mismatch\nstdout:\n${x64RunResult.stdout}\nstderr:\n${x64RunResult.stderr}`);
    strictEqual(x64RunResult.status, 15, `x64 source-less precompiled lib exit code mismatch\nstdout:\n${x64RunResult.stdout}\nstderr:\n${x64RunResult.stderr}`);
    strictEqual(x64RunResult.stdout, "", `x64 source-less precompiled lib should not print main return value\n${x64RunResult.stdout}`);
    strictEqual(x64RunResult.stderr, "", `x64 source-less precompiled lib stderr mismatch\n${x64RunResult.stderr}`);

    const cBackendResult = spawnBuildJsonCliSync(cliPath, [
        "run",
        appDir,
        "--entry",
        entryUnitId,
        "--lib",
        archivePath,
        "--backend-profile",
        "c-backend"
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    strictEqual(cBackendResult.status, 1, `c-backend with source-less lib should fail\nstdout:\n${cBackendResult.stdout}\nstderr:\n${cBackendResult.stderr}`);
    ok(
        cBackendResult.stderr.includes("source-less precompiled libs currently require x64 backends"),
        `c-backend rejection should explain the x64-only boundary\nstdout:\n${cBackendResult.stdout}\nstderr:\n${cBackendResult.stderr}`
    );

    const missingResult = spawnBuildJsonCliSync(cliPath, ["check", missingDir, "--lib", archivePath], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: TEST_TIMEOUT_MS
    });
    strictEqual(missingResult.status, 1, `missing-monomorph compile should fail\nstdout:\n${missingResult.stdout}\nstderr:\n${missingResult.stderr}`);
    ok(
        missingResult.stderr.includes("precompiled lib is missing monomorphized"),
        `missing-monomorph compile should explain the missing precompiled mapping\nstdout:\n${missingResult.stdout}\nstderr:\n${missingResult.stderr}`
    );

    process.stdout.write("precompiled-lib manifest and nested monomorph lookup ok\n");
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
