import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "child_process";
import { resolve } from "path";

const windowsSystemLibraries = ["Ws2_32.lib"] as const;

type WindowsToolInvocation = {
    readonly command: string;
    readonly args: readonly string[];
};

function isLinkerInput(arg: string): boolean {
    return /\.(a|lib)$/i.test(arg);
}

function buildWindowsCcInvocation(args: readonly string[]): WindowsToolInvocation {
    let outputPath: string | undefined;
    let compileOnly = false;
    let suppressWarnings = false;
    const compilerInputs: string[] = [];
    const linkerInputs: string[] = [...windowsSystemLibraries];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "-o") {
            outputPath = args[index + 1];
            index += 1;
            continue;
        }
        if (arg === "-c") {
            compileOnly = true;
            continue;
        }
        if (arg === "-w") {
            suppressWarnings = true;
            continue;
        }
        if (arg === "-O0" || arg === "-std=c11" || arg === "-pthread" || arg === "-no-pie" || arg === "-lm") {
            continue;
        }
        if (isLinkerInput(arg)) {
            linkerInputs.push(arg);
            continue;
        }
        compilerInputs.push(arg);
    }

    if (outputPath === undefined) {
        throw new Error(`Windows-local test toolchain expected '-o <path>' in cc args: ${args.join(" ")}`);
    }

    if (compileOnly) {
        if (compilerInputs.length !== 1) {
            throw new Error(`Windows-local test toolchain expected one compile input for 'cc -c': ${args.join(" ")}`);
        }
        return {
            command: "clang-cl",
            args: [
                "/nologo",
                ...(suppressWarnings ? ["/w"] : []),
                "/c",
                "/TC",
                compilerInputs[0],
                `/Fo:${outputPath}`
            ]
        };
    }

    return {
        command: "clang-cl",
        args: [
            "/nologo",
            ...(suppressWarnings ? ["/w"] : []),
            ...compilerInputs,
            `/Fe:${outputPath}`,
            "/link",
            ...linkerInputs
        ]
    };
}

function getWindowsToolInvocation(command: string, args: readonly string[]): WindowsToolInvocation {
    if (command === "cc") {
        return buildWindowsCcInvocation(args);
    }
    if (command === "ar") {
        return {
            command: "llvm-ar",
            args: [...args]
        };
    }
    return {
        command,
        args: [...args]
    };
}

export function execLinuxToolSync(command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string {
    if (process.platform !== "win32") {
        return execFileSync(command, [...args], options);
    }
    const invocation = getWindowsToolInvocation(command, args);
    return execFileSync(invocation.command, [...invocation.args], options);
}

export function execLinuxBinarySync(binaryPath: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string {
    if (process.platform !== "win32") {
        return execFileSync(binaryPath, [...args], options);
    }
    return execFileSync(resolve(binaryPath), [...args], options);
}

export function spawnLinuxBinarySync(binaryPath: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
    if (process.platform !== "win32") {
        return spawnSync(binaryPath, [...args], options);
    }
    return spawnSync(resolve(binaryPath), [...args], options);
}