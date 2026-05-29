const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeMemory = require("./node-memory");

nodeMemory.ensureCurrentNodeProcessHasMemoryLimit();

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cliPath = path.join(repoRoot, "build", "main.js");
const buildConfigTemplatePath = path.join(__dirname, "build-validate-iw.json");
const buildConfigTemplateDir = path.dirname(buildConfigTemplatePath);
const cacheRoot = path.join(os.tmpdir(), "ironwall-json-validator-cache");
const cachedSourcePath = path.join(cacheRoot, "validator.c");
const cachedBinaryPath = path.join(cacheRoot, "validator.out");
const PRLIMIT_PATH = "/usr/bin/prlimit";
const TIMEOUT_PATH = "/usr/bin/timeout";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function exitWithChildStatus(error) {
  if (typeof error?.status === "number") {
    process.exit(error.status);
  }
  if (typeof error?.signal === "string") {
    process.stderr.write(`validator terminated by signal ${error.signal}\n`);
    process.exit(1);
  }
  throw error;
}

function loadBuildConfigTemplate() {
  return JSON.parse(fs.readFileSync(buildConfigTemplatePath, "utf8"));
}

function absolutizeDirectories(template) {
  return template.directories.map((entry) => ({
    ...entry,
    path: path.resolve(buildConfigTemplateDir, entry.path)
  }));
}

function newestInputMtimeMs() {
  const template = loadBuildConfigTemplate();
  let newest = fs.statSync(cliPath).mtimeMs;
  newest = Math.max(newest, fs.statSync(buildConfigTemplatePath).mtimeMs);
  for (const entry of absolutizeDirectories(template)) {
    for (const fileName of entry.files) {
      newest = Math.max(newest, fs.statSync(path.join(entry.path, fileName)).mtimeMs);
    }
  }
  return newest;
}

function cachedBinaryIsFresh() {
  if (!fs.existsSync(cachedBinaryPath)) {
    return false;
  }
  return fs.statSync(cachedBinaryPath).mtimeMs >= newestInputMtimeMs();
}

function buildCachedValidator() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ironwall-json-validate-"));
  const configPath = path.join(tempDir, "build-iw.json");
  const childEnv = {
    ...process.env,
    IW_EXTERNAL_FRONTEND_JSON_COMMAND: ""
  };
  try {
    const template = loadBuildConfigTemplate();
    const config = {
      ...template,
      mode: "emit-c",
      directories: absolutizeDirectories(template),
      output: cachedSourcePath,
      programArgs: []
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const invocation = nodeMemory.buildNodeScriptInvocationArgs(cliPath, [configPath]);
    cp.execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: childEnv,
      stdio: "inherit"
    });
    cp.execFileSync("cc", ["-std=c11", "-O0", cachedSourcePath, "-lm", "-pthread", "-o", cachedBinaryPath], {
      cwd: repoRoot,
      stdio: "inherit"
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function validatorBinaryPath() {
  if (process.env.IRONWALL_JSON_VALIDATOR_BIN) {
    return process.env.IRONWALL_JSON_VALIDATOR_BIN;
  }
  if (!cachedBinaryIsFresh()) {
    buildCachedValidator();
  }
  return cachedBinaryPath;
}

function parsePositiveIntegerEnv(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return null;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    fail(`invalid ${name}='${rawValue}'`);
  }
  return parsedValue;
}

function buildWrappedChildInvocation(binaryPath, repoRelativeInputPath) {
  const childTimeoutMs = parsePositiveIntegerEnv("IRONWALL_JSON_CHILD_TIMEOUT_MS");
  const childMaxAddressSpaceKb = parsePositiveIntegerEnv("IRONWALL_JSON_CHILD_MAX_ADDRESS_SPACE_KB");
  let command = binaryPath;
  let args = [repoRelativeInputPath, repoRoot];

  if (childTimeoutMs !== null) {
    if (!fs.existsSync(TIMEOUT_PATH)) {
      fail(`missing required tool: ${TIMEOUT_PATH}`);
    }
    command = TIMEOUT_PATH;
    args = [
      "--signal=TERM",
      "--kill-after=5s",
      `${String(Math.max(1, Math.ceil(childTimeoutMs / 1000)))}s`,
      binaryPath,
      repoRelativeInputPath,
      repoRoot
    ];
  }

  if (childMaxAddressSpaceKb !== null) {
    if (!fs.existsSync(PRLIMIT_PATH)) {
      fail(`missing required tool: ${PRLIMIT_PATH}`);
    }
    command = PRLIMIT_PATH;
    args = [
      `--as=${String(childMaxAddressSpaceKb * 1024)}`,
      "--",
      ...(childTimeoutMs === null
        ? [binaryPath, repoRelativeInputPath, repoRoot]
        : [TIMEOUT_PATH, "--signal=TERM", "--kill-after=5s", `${String(Math.max(1, Math.ceil(childTimeoutMs / 1000)))}s`, binaryPath, repoRelativeInputPath, repoRoot])
    ];
  }

  return { command, args };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    fail("missing input file path");
  }
  const resolvedInputPath = path.resolve(repoRoot, inputPath);
  const repoRelativeInputPath = path.relative(repoRoot, resolvedInputPath);

  try {
    const invocation = buildWrappedChildInvocation(validatorBinaryPath(), repoRelativeInputPath);
    cp.execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      stdio: "inherit"
    });
  } catch (error) {
    exitWithChildStatus(error);
  }
}

main();
