import { execFileSync } from "child_process";
import { type BuildTarget, isWindowsTarget } from "./Target";

export interface PlatformToolchain {
    readonly target: BuildTarget;
    readonly executableSuffix: string;
    readonly nativeAssemblySuffix: string;
    readonly objectFileSuffix: string;
    readonly staticLibrarySuffixes: readonly string[];
    readonly x64DriverSource: string;
    readonly cCompileCommand: string;
    readonly cCompileArgs: (sourcePath: string, ffiLibPaths: readonly string[], outputPath: string) => readonly string[];
    readonly compileCToObjectCommand: string;
    readonly compileCToObjectArgs: (sourcePath: string, outputPath: string) => readonly string[];
    readonly compileAssemblyToObjectCommand: string;
    readonly compileAssemblyToObjectArgs: (sourcePath: string, outputPath: string) => readonly string[];
    readonly x64LinkCommand: string;
    readonly x64LinkArgs: (linkInputs: readonly string[], outputPath: string) => readonly string[];
    readonly linkObjectsCommand: string;
    readonly linkObjectsArgs: (objectPaths: readonly string[], ffiLibPaths: readonly string[], outputPath: string) => readonly string[];
    readonly runBinaryInvocation: (binaryPath: string, programArgs: readonly string[]) => {
        readonly command: string;
        readonly args: readonly string[];
    };
}

function isWindowsHost(): boolean {
    return process.platform === "win32";
}

function toWslPath(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    if (normalizedPath.startsWith("/")) {
        return normalizedPath;
    }

    const drivePathMatch = /^([A-Za-z]):(\/.*)$/.exec(normalizedPath);
    if (drivePathMatch !== null) {
        const [, driveLetter, drivePath] = drivePathMatch;
        return `/mnt/${driveLetter.toLowerCase()}${drivePath}`;
    }

    throw new Error(`Cannot translate Windows path '${path}' to a WSL path.`);
}

function buildWslExecArgs(command: string, args: readonly string[]): readonly string[] {
    return ["--exec", command, ...args];
}

const linuxX64DriverSource = `#include <stdint.h>
#include <stdio.h>
#include <sys/resource.h>
typedef intptr_t iw_value_t;
extern void __iw_x64_init_runtime(void);
extern iw_value_t __iw_host_entry_main(int argc, char **argv);
static inline long long iw_as_i64(iw_value_t value) { return ((long long)value) >> 1; }
static void iw_raise_stack_limit(void) {
    struct rlimit limit;
    if (getrlimit(RLIMIT_STACK, &limit) != 0) {
        return;
    }
    if (limit.rlim_cur == limit.rlim_max) {
        return;
    }
    limit.rlim_cur = limit.rlim_max;
    (void)setrlimit(RLIMIT_STACK, &limit);
}
int main(int argc, char **argv) {
    iw_raise_stack_limit();
    __iw_x64_init_runtime();
    iw_value_t result = __iw_host_entry_main(argc, argv);
    return (int)iw_as_i64(result);
}
`;

const windowsX64DriverSource = `#include <stdint.h>
#include <stdio.h>
typedef intptr_t iw_value_t;
extern void __iw_x64_init_runtime(void);
extern iw_value_t __iw_host_entry_main(int argc, char **argv);
static inline long long iw_as_i64(iw_value_t value) { return ((long long)value) >> 1; }
int main(int argc, char **argv) {
    __iw_x64_init_runtime();
    iw_value_t result = __iw_host_entry_main(argc, argv);
    return (int)iw_as_i64(result);
}
`;

const windowsSystemLibraries = ["Ws2_32.lib"] as const;

export function getPlatformToolchain(target: BuildTarget): PlatformToolchain {
    if (isWindowsTarget(target)) {
        return {
            target,
            executableSuffix: ".exe",
            nativeAssemblySuffix: ".s",
            objectFileSuffix: ".obj",
            staticLibrarySuffixes: [".lib", ".a"],
            x64DriverSource: windowsX64DriverSource,
            cCompileCommand: "clang-cl",
            cCompileArgs: (sourcePath, ffiLibPaths, outputPath) => [
                "/nologo",
                "/TC",
                sourcePath,
                `/Fe:${outputPath}`,
                "/link",
                ...ffiLibPaths,
                ...windowsSystemLibraries
            ],
            compileCToObjectCommand: "clang-cl",
            compileCToObjectArgs: (sourcePath, outputPath) => [
                "/nologo",
                "/c",
                "/TC",
                sourcePath,
                `/Fo:${outputPath}`
            ],
            compileAssemblyToObjectCommand: "clang-cl",
            compileAssemblyToObjectArgs: (sourcePath, outputPath) => [
                "/nologo",
                "/c",
                sourcePath,
                `/Fo:${outputPath}`
            ],
            x64LinkCommand: "cl",
            x64LinkArgs: (linkInputs, outputPath) => ["/nologo", "/O2", ...linkInputs, ...windowsSystemLibraries, `/Fe:${outputPath}`],
            linkObjectsCommand: "cl",
            linkObjectsArgs: (objectPaths, ffiLibPaths, outputPath) => ["/nologo", "/O2", ...objectPaths, ...ffiLibPaths, ...windowsSystemLibraries, `/Fe:${outputPath}`],
            runBinaryInvocation: (binaryPath, programArgs) => ({
                command: binaryPath,
                args: [...programArgs]
            })
        };
    }

    if (isWindowsHost()) {
        return {
            target,
            executableSuffix: ".out",
            nativeAssemblySuffix: ".s",
            objectFileSuffix: ".o",
            staticLibrarySuffixes: [".a"],
            x64DriverSource: linuxX64DriverSource,
            cCompileCommand: "wsl.exe",
            cCompileArgs: (sourcePath, ffiLibPaths, outputPath) => buildWslExecArgs("cc", [
                "-std=c11",
                "-O0",
                toWslPath(sourcePath),
                ...ffiLibPaths.map((libPath) => toWslPath(libPath)),
                "-lm",
                "-pthread",
                "-o",
                toWslPath(outputPath)
            ]),
            compileCToObjectCommand: "wsl.exe",
            compileCToObjectArgs: (sourcePath, outputPath) => buildWslExecArgs("cc", [
                "-std=c11",
                "-O0",
                "-c",
                toWslPath(sourcePath),
                "-o",
                toWslPath(outputPath)
            ]),
            compileAssemblyToObjectCommand: "wsl.exe",
            compileAssemblyToObjectArgs: (sourcePath, outputPath) => buildWslExecArgs("cc", [
                "-c",
                toWslPath(sourcePath),
                "-o",
                toWslPath(outputPath)
            ]),
            x64LinkCommand: "wsl.exe",
            x64LinkArgs: (linkInputs, outputPath) => buildWslExecArgs("cc", [
                "-O0",
                "-std=c11",
                "-pthread",
                "-no-pie",
                ...linkInputs.map((linkInput) => toWslPath(linkInput)),
                "-lm",
                "-o",
                toWslPath(outputPath)
            ]),
            linkObjectsCommand: "wsl.exe",
            linkObjectsArgs: (objectPaths, ffiLibPaths, outputPath) => buildWslExecArgs("cc", [
                "-O0",
                "-std=c11",
                "-pthread",
                "-no-pie",
                ...objectPaths.map((objectPath) => toWslPath(objectPath)),
                ...ffiLibPaths.map((libPath) => toWslPath(libPath)),
                "-lm",
                "-o",
                toWslPath(outputPath)
            ]),
            runBinaryInvocation: (binaryPath, programArgs) => ({
                command: "wsl.exe",
                args: buildWslExecArgs(toWslPath(binaryPath), programArgs)
            })
        };
    }

    return {
        target,
        executableSuffix: ".out",
        nativeAssemblySuffix: ".s",
        objectFileSuffix: ".o",
        staticLibrarySuffixes: [".a"],
        x64DriverSource: linuxX64DriverSource,
        cCompileCommand: "cc",
        cCompileArgs: (sourcePath, ffiLibPaths, outputPath) => [
            "-std=c11",
            "-O0",
            sourcePath,
            ...ffiLibPaths,
            "-lm",
            "-pthread",
            "-o",
            outputPath
        ],
        compileCToObjectCommand: "cc",
        compileCToObjectArgs: (sourcePath, outputPath) => [
            "-std=c11",
            "-O0",
            "-c",
            sourcePath,
            "-o",
            outputPath
        ],
        compileAssemblyToObjectCommand: "cc",
        compileAssemblyToObjectArgs: (sourcePath, outputPath) => [
            "-c",
            sourcePath,
            "-o",
            outputPath
        ],
        x64LinkCommand: "cc",
        x64LinkArgs: (linkInputs, outputPath) => ["-O0", "-std=c11", "-pthread", "-no-pie", ...linkInputs, "-lm", "-o", outputPath],
        linkObjectsCommand: "cc",
        linkObjectsArgs: (objectPaths, ffiLibPaths, outputPath) => ["-O0", "-std=c11", "-pthread", "-no-pie", ...objectPaths, ...ffiLibPaths, "-lm", "-o", outputPath],
        runBinaryInvocation: (binaryPath, programArgs) => ({
            command: binaryPath,
            args: [...programArgs]
        })
    };
}

export function execToolchainOrThrow(command: string, args: readonly string[], label: string, formatError: (error: unknown) => string): void {
    try {
        execFileSync(command, [...args], { stdio: "pipe" });
    } catch (error) {
        throw new Error(`${label} failed:\n${formatError(error)}`);
    }
}
