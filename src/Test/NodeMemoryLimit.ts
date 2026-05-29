// Shared Node.js memory-limit helpers for heavy child Node.js invocations.

import { spawnSync, type SpawnSyncReturns } from "child_process";

const DEFAULT_NODE_MAX_OLD_SPACE_MB: number = 2048;
const DEFAULT_NODE_MAX_ADDRESS_SPACE_MB: number = 3072;
const NODE_MAX_OLD_SPACE_ENV_NAME: string = "IW_NODE_MAX_OLD_SPACE_MB";
const NODE_MAX_ADDRESS_SPACE_ENV_NAME: string = "IW_NODE_MAX_ADDRESS_SPACE_MB";
const NODE_MEMORY_GUARD_ACTIVE_ENV_NAME: string = "IW_NODE_MEMORY_GUARD_ACTIVE";
const PRLIMIT_PATH: string = "/usr/bin/prlimit";

export class NodeScriptInvocation {
    public readonly command: string;
    public readonly args: readonly string[];

    public constructor(command0: string, args0: readonly string[]) {
        this.command = command0;
        this.args = args0;
    }
}

function sanitizedProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

function hasMaxOldSpaceFlag(args: readonly string[]): boolean {
    for (const arg of args) {
        if (arg === "--max-old-space-size" || arg.startsWith("--max-old-space-size=")) {
            return true;
        }
    }
    return false;
}

function hasNodeOptionsMaxOldSpaceFlag(): boolean {
    const nodeOptions: string = process.env.NODE_OPTIONS ?? "";
    return nodeOptions.includes("--max-old-space-size");
}

function currentProcessAlreadyHasNodeMemoryLimit(): boolean {
    return hasMaxOldSpaceFlag(process.execArgv) || hasNodeOptionsMaxOldSpaceFlag();
}

function parseConfiguredNodeMaxOldSpaceMb(): number | null {
    const rawValue: string | undefined = process.env[NODE_MAX_OLD_SPACE_ENV_NAME];
    if (rawValue === undefined) {
        return DEFAULT_NODE_MAX_OLD_SPACE_MB;
    }
    const trimmedValue: string = rawValue.trim();
    if (trimmedValue === "0") {
        return null;
    }
    const parsedValue: number = Number.parseInt(trimmedValue, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid ${NODE_MAX_OLD_SPACE_ENV_NAME}='${rawValue}'`);
    }
    return parsedValue;
}

function parseConfiguredNodeMaxAddressSpaceMb(): number | null {
    if (process.platform !== "linux") {
        return null;
    }
    const rawValue: string | undefined = process.env[NODE_MAX_ADDRESS_SPACE_ENV_NAME];
    if (rawValue === undefined) {
        return DEFAULT_NODE_MAX_ADDRESS_SPACE_MB;
    }
    const trimmedValue: string = rawValue.trim();
    if (trimmedValue === "0") {
        return null;
    }
    const parsedValue: number = Number.parseInt(trimmedValue, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid ${NODE_MAX_ADDRESS_SPACE_ENV_NAME}='${rawValue}'`);
    }
    return parsedValue;
}

function sanitizedExecArgv(): string[] {
    const args: string[] = [];
    let skipNextValue: boolean = false;
    for (const arg of process.execArgv) {
        if (skipNextValue) {
            skipNextValue = false;
            continue;
        }
        if (arg === "--max-old-space-size") {
            skipNextValue = true;
            continue;
        }
        if (arg.startsWith("--max-old-space-size=")) {
            continue;
        }
        args.push(arg);
    }
    return args;
}

export function buildNodeScriptInvocation(scriptPath: string, scriptArgs: readonly string[]): NodeScriptInvocation {
    const nodeArgs: string[] = sanitizedExecArgv();
    const configuredLimitMb: number | null = parseConfiguredNodeMaxOldSpaceMb();
    if (!currentProcessAlreadyHasNodeMemoryLimit() && configuredLimitMb !== null) {
        nodeArgs.push(`--max-old-space-size=${String(configuredLimitMb)}`);
    }
    nodeArgs.push(scriptPath, ...scriptArgs);

    const configuredAddressSpaceMb: number | null = parseConfiguredNodeMaxAddressSpaceMb();
    if (configuredAddressSpaceMb === null) {
        return new NodeScriptInvocation(process.execPath, nodeArgs);
    }
    return new NodeScriptInvocation(PRLIMIT_PATH, [
        `--as=${String(configuredAddressSpaceMb * 1024 * 1024)}`,
        "--",
        process.execPath,
        ...nodeArgs
    ]);
}

export function ensureCurrentNodeProcessHasMemoryLimit(): void {
    if (process.env[NODE_MEMORY_GUARD_ACTIVE_ENV_NAME] === "1") {
        return;
    }
    const configuredLimitMb: number | null = parseConfiguredNodeMaxOldSpaceMb();
    const configuredAddressSpaceMb: number | null = parseConfiguredNodeMaxAddressSpaceMb();
    if (configuredLimitMb === null && configuredAddressSpaceMb === null) {
        return;
    }
    if (currentProcessAlreadyHasNodeMemoryLimit() && configuredAddressSpaceMb === null) {
        return;
    }

    const childEnv: Record<string, string> = sanitizedProcessEnv({
        ...process.env,
        [NODE_MEMORY_GUARD_ACTIVE_ENV_NAME]: "1"
    });
    const invocation: NodeScriptInvocation = buildNodeScriptInvocation(process.argv[1], process.argv.slice(2));
    const execveMember: unknown = Reflect.get(process, "execve");
    if (process.platform !== "win32" && typeof execveMember === "function") {
        Reflect.apply(execveMember, process, [invocation.command, [invocation.command, ...invocation.args], childEnv]);
        throw new Error("process.execve returned unexpectedly");
    }
    const result: SpawnSyncReturns<Buffer> = spawnSync(invocation.command, invocation.args, {
        env: childEnv,
        stdio: "inherit"
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.signal !== null) {
        process.kill(process.pid, result.signal);
        return;
    }
    process.exit(result.status ?? 1);
}