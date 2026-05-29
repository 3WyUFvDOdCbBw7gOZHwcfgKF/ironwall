#!/usr/bin/env node
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeMemory = require("./node-memory");

nodeMemory.ensureCurrentNodeProcessHasMemoryLimit();

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cliPath = path.join(repoRoot, "build", "main.js");
const buildConfigTemplatePath = path.join(__dirname, "build-iw.json");
const buildConfigTemplateDir = path.dirname(buildConfigTemplatePath);
const cacheRoot = path.join(os.tmpdir(), "ironwall-iw-frontend-json-cache");
const cachedSourcePath = path.join(cacheRoot, "iw-frontend-json.c");
const cachedBinaryPath = path.join(cacheRoot, "iw-frontend-json.out");
const cacheStampPath = path.join(cacheRoot, "iw-frontend-json.sha256");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    mode: "ast",
    inputFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-file") {
      index += 1;
      options.inputFile = argv[index] ?? null;
    } else if (arg === "--tokens") {
      options.mode = "tokens";
    } else if (arg === "--bundle") {
      options.mode = "bundle";
    } else if (arg === "--help") {
      process.stdout.write("Usage: run-iw-frontend-json.js [--tokens|--bundle] --input-file path/to/input.iw\n");
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (options.inputFile === null || options.inputFile.length === 0) {
    fail("missing --input-file");
  }
  return options;
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

function updateFingerprintWithFile(hash, filePath) {
  hash.update(filePath);
  hash.update("\0");
  hash.update(fs.readFileSync(filePath));
  hash.update("\0");
}

function inputFilesForFingerprint(template) {
  const filePaths = [__filename, buildConfigTemplatePath, path.join(__dirname, "node-memory.js")];
  for (const entry of absolutizeDirectories(template)) {
    if (Array.isArray(entry.files)) {
      for (const fileName of [...entry.files].sort()) {
        filePaths.push(path.join(entry.path, fileName));
      }
    }
  }
  return filePaths;
}

function computeCacheFingerprint() {
  const template = loadBuildConfigTemplate();
  const hash = crypto.createHash("sha256");
  for (const filePath of inputFilesForFingerprint(template)) {
    updateFingerprintWithFile(hash, filePath);
  }
  return hash.digest("hex");
}

function cachedBinaryIsFresh() {
  if (!fs.existsSync(cachedBinaryPath)) {
    return false;
  }
  if (!fs.existsSync(cacheStampPath)) {
    return false;
  }
  if (process.env.IW_FORCE_REBUILD_IW_FRONTEND_JSON === "1") {
    return false;
  }
  return fs.readFileSync(cacheStampPath, "utf8").trim() === computeCacheFingerprint();
}

function buildCachedDumpBinary() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ironwall-iw-frontend-json-"));
  const configPath = path.join(tempDir, "build-iw.json");
  const cacheFingerprint = computeCacheFingerprint();
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
    fs.writeFileSync(cacheStampPath, `${cacheFingerprint}\n`, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function dumpBinaryPath() {
  if (process.env.IRONWALL_IW_DUMP_BIN) {
    return process.env.IRONWALL_IW_DUMP_BIN;
  }
  if (!cachedBinaryIsFresh()) {
    buildCachedDumpBinary();
  }
  return cachedBinaryPath;
}

function runIronwallDump(inputFile, options = {}) {
  const resolvedInputPath = path.resolve(inputFile);
  const repoRelativeInputPath = path.relative(repoRoot, resolvedInputPath);
  const dumpArgs = [repoRelativeInputPath];
  if (options.frontendTokensOnly === true) {
    dumpArgs.push("--frontend-tokens-only");
  } else if (options.frontendBundleOnly === true) {
    dumpArgs.push("--frontend-bundle-only");
  } else if (options.frontendAstOnly === true) {
    dumpArgs.push("--frontend-ast-only");
  }
  const stdout = cp.execFileSync(dumpBinaryPath(), dumpArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.quietStderr === true ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(stdout);
}

function tokensJsonFromDump(dump) {
  if (Array.isArray(dump?.lexer?.frontendTokens)) {
    return dump.lexer.frontendTokens;
  }
  fail("Ironwall dump did not provide lexer.frontendTokens");
}

function expectKind(node, kind, context) {
  if (node.kind !== kind) {
    fail(`${context} must be ${kind}`);
  }
  return node;
}

function astJsonFromDump(dump) {
  if (dump?.parser?.frontendAst && typeof dump.parser.frontendAst.kind === "string") {
    return expectKind(dump.parser.frontendAst, "ProgramNode", "frontend AST");
  }
  if (dump?.parser?.hasErrors === true && typeof dump?.parser?.diagnosticMessage === "string" && dump.parser.diagnosticMessage.length > 0) {
    fail(dump.parser.diagnosticMessage);
  }
  fail("Ironwall dump did not provide parser.frontendAst");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "tokens") {
    const tokens = runIronwallDump(options.inputFile, {
      frontendTokensOnly: true,
      quietStderr: true
    });
    process.stdout.write(`${JSON.stringify(tokens, null, 2)}\n`);
    return;
  }

  if (options.mode === "bundle") {
    const tokens = runIronwallDump(options.inputFile, {
      frontendTokensOnly: true,
      quietStderr: true
    });
    const astDump = runIronwallDump(options.inputFile, {
      frontendAstOnly: true
    });
    process.stdout.write(`${JSON.stringify({ tokens, ast: astJsonFromDump(astDump) }, null, 2)}\n`);
    return;
  }

  const dump = runIronwallDump(options.inputFile, {
    frontendAstOnly: options.mode === "ast"
  });
  const ast = astJsonFromDump(dump);
  process.stdout.write(`${JSON.stringify(ast, null, 2)}\n`);
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    runIronwallDump
  };
}
