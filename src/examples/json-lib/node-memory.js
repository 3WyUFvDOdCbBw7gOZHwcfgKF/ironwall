const DEFAULT_NODE_MAX_OLD_SPACE_MB = 2048;
const DEFAULT_NODE_MAX_ADDRESS_SPACE_MB = 3072;
const NODE_MAX_OLD_SPACE_ENV_NAME = "IW_NODE_MAX_OLD_SPACE_MB";
const NODE_MAX_ADDRESS_SPACE_ENV_NAME = "IW_NODE_MAX_ADDRESS_SPACE_MB";
const NODE_MEMORY_GUARD_ACTIVE_ENV_NAME = "IW_NODE_MEMORY_GUARD_ACTIVE";
const PRLIMIT_PATH = "/usr/bin/prlimit";

function failForInvalidNodeMemoryLimit(rawValue) {
  throw new Error(`invalid ${NODE_MAX_OLD_SPACE_ENV_NAME}='${rawValue}'`);
}

function hasMaxOldSpaceFlag(args) {
  for (const arg of args) {
    if (arg === "--max-old-space-size" || arg.startsWith("--max-old-space-size=")) {
      return true;
    }
  }
  return false;
}

function hasNodeOptionsMaxOldSpaceFlag() {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  return nodeOptions.includes("--max-old-space-size");
}

function currentProcessAlreadyHasNodeMemoryLimit() {
  return hasMaxOldSpaceFlag(process.execArgv) || hasNodeOptionsMaxOldSpaceFlag();
}

function parseConfiguredNodeMaxOldSpaceMb() {
  const rawValue = process.env[NODE_MAX_OLD_SPACE_ENV_NAME];
  if (rawValue === undefined) {
    return DEFAULT_NODE_MAX_OLD_SPACE_MB;
  }
  const trimmedValue = rawValue.trim();
  if (trimmedValue === "0") {
    return null;
  }
  const parsedValue = Number.parseInt(trimmedValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    failForInvalidNodeMemoryLimit(rawValue);
  }
  return parsedValue;
}

function parseConfiguredNodeMaxAddressSpaceMb() {
  if (process.platform !== "linux") {
    return null;
  }
  const rawValue = process.env[NODE_MAX_ADDRESS_SPACE_ENV_NAME];
  if (rawValue === undefined) {
    return DEFAULT_NODE_MAX_ADDRESS_SPACE_MB;
  }
  const trimmedValue = rawValue.trim();
  if (trimmedValue === "0") {
    return null;
  }
  const parsedValue = Number.parseInt(trimmedValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`invalid ${NODE_MAX_ADDRESS_SPACE_ENV_NAME}='${rawValue}'`);
  }
  return parsedValue;
}

function sanitizedExecArgv() {
  const args = [];
  let skipNextValue = false;
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

function buildNodeScriptInvocationArgs(scriptPath, scriptArgs) {
  const nodeArgs = sanitizedExecArgv();
  const configuredLimitMb = parseConfiguredNodeMaxOldSpaceMb();
  if (!currentProcessAlreadyHasNodeMemoryLimit() && configuredLimitMb !== null) {
    nodeArgs.push(`--max-old-space-size=${String(configuredLimitMb)}`);
  }
  nodeArgs.push(scriptPath, ...scriptArgs);

  const configuredAddressSpaceMb = parseConfiguredNodeMaxAddressSpaceMb();
  if (configuredAddressSpaceMb === null) {
    return {
      command: process.execPath,
      args: nodeArgs
    };
  }
  return {
    command: PRLIMIT_PATH,
    args: [
      `--as=${String(configuredAddressSpaceMb * 1024 * 1024)}`,
      "--",
      process.execPath,
      ...nodeArgs
    ]
  };
}

function sanitizedProcessEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function ensureCurrentNodeProcessHasMemoryLimit() {
  if (process.env[NODE_MEMORY_GUARD_ACTIVE_ENV_NAME] === "1") {
    return;
  }
  const configuredLimitMb = parseConfiguredNodeMaxOldSpaceMb();
  const configuredAddressSpaceMb = parseConfiguredNodeMaxAddressSpaceMb();
  if (configuredLimitMb === null && configuredAddressSpaceMb === null) {
    return;
  }
  if (currentProcessAlreadyHasNodeMemoryLimit() && configuredAddressSpaceMb === null) {
    return;
  }

  const invocation = buildNodeScriptInvocationArgs(process.argv[1], process.argv.slice(2));
  const childEnv = sanitizedProcessEnv({
    ...process.env,
    [NODE_MEMORY_GUARD_ACTIVE_ENV_NAME]: "1"
  });
  if (typeof process.execve === "function") {
    process.execve(invocation.command, [invocation.command, ...invocation.args], childEnv);
    throw new Error("process.execve returned unexpectedly");
  }
  const result = cp.spawnSync(invocation.command, invocation.args, {
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

module.exports = {
  buildNodeScriptInvocationArgs,
  ensureCurrentNodeProcessHasMemoryLimit
};