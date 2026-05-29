const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { validateIwDump } = require("./validate-iw-dump.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cliPath = path.join(repoRoot, "build", "main.js");
const buildConfigTemplatePath = path.join(__dirname, "build-iw.json");
const buildConfigTemplateDir = path.dirname(buildConfigTemplatePath);

const fixtureCases = [
  {
    inputPath: "src/examples/json-lib/app~iw~parse@defs.iw",
    expectedProgramUnit: "app~iw~parse@defs",
    minImportCount: 2,
    minDeclarationCount: 40,
    minMemberCount: 20,
    minVarCount: 20,
    minIfCount: 20,
    minAssignmentCount: 20
  },
  {
    inputPath: "src/examples/json-lib/app~json~lib@defs.iw",
    expectedProgramUnit: "app~json~lib@defs",
    minImportCount: 1,
    minDeclarationCount: 20,
    minMemberCount: 0,
    minVarCount: 10,
    minIfCount: 10,
    minAssignmentCount: 10
  },
  {
    inputPath: "src/examples/log-audit/app~log~audit@main.iw",
    expectedProgramUnit: "app~log~audit@main",
    minImportCount: 5,
    minDeclarationCount: 1,
    minMemberCount: 0,
    minVarCount: 20,
    minIfCount: 10
  },
  {
    inputPath: "src/examples/http-loopback/app~http~loopback~lib@defs.iw",
    expectedProgramUnit: "app~http~loopback~lib@defs",
    minImportCount: 2,
    minDeclarationCount: 8,
    minMemberCount: 0,
    minVarCount: 10,
    minIfCount: 5,
    minWhileCount: 1,
    minAssignmentCount: 4
  },
  {
    inputPath: "src/examples/string-cond-panorama/app~string~cond~panorama@main.iw",
    expectedProgramUnit: "app~string~cond~panorama@main",
    minImportCount: 2,
    minDeclarationCount: 5,
    minMemberCount: 5,
    minVarCount: 5,
    minIfCount: 5,
    minWhileCount: 1,
    minLetCount: 1,
    minCondCount: 3,
    minAssignmentCount: 5
  }
];

function loadBuildConfigTemplate() {
  return JSON.parse(fs.readFileSync(buildConfigTemplatePath, "utf8"));
}

function absolutizeDirectories(template) {
  return template.directories.map((entry) => ({
    ...entry,
    path: path.resolve(buildConfigTemplateDir, entry.path)
  }));
}

function runDumpForFixture(inputPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ironwall-iw-dump-"));
  const configPath = path.join(tempDir, "build-iw.json");
  const outputPath = path.join(tempDir, "dump.json");
  try {
    const template = loadBuildConfigTemplate();
    const config = {
      ...template,
      directories: absolutizeDirectories(template),
      output: outputPath,
      programArgs: [inputPath]
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    cp.execFileSync(process.execPath, [cliPath, configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function validateFixtureCase(fixtureCase) {
  const parsed = runDumpForFixture(fixtureCase.inputPath);
  validateIwDump(parsed);

  assert.strictEqual(parsed.input.path, fixtureCase.inputPath, `${fixtureCase.inputPath}: expected echoed input path`);
  assert.strictEqual(parsed.parser.hasErrors, false, `${fixtureCase.inputPath}: expected parser.hasErrors=false`);
  assert.strictEqual(parsed.lexer.hasUnbalancedBrackets, false, `${fixtureCase.inputPath}: expected balanced brackets`);
  assert.strictEqual(parsed.parser.headers.programUnit, fixtureCase.expectedProgramUnit, `${fixtureCase.inputPath}: expected program unit`);
  assert.ok(parsed.parser.headers.importCount >= fixtureCase.minImportCount, `${fixtureCase.inputPath}: expected importCount >= ${fixtureCase.minImportCount}`);
  assert.ok(parsed.parser.declarations.count >= fixtureCase.minDeclarationCount, `${fixtureCase.inputPath}: expected declaration count >= ${fixtureCase.minDeclarationCount}`);
  assert.ok(parsed.parser.members.count >= fixtureCase.minMemberCount, `${fixtureCase.inputPath}: expected member count >= ${fixtureCase.minMemberCount}`);
  assert.ok(parsed.parser.forms.varCount >= fixtureCase.minVarCount, `${fixtureCase.inputPath}: expected varCount >= ${fixtureCase.minVarCount}`);
  assert.ok(parsed.parser.forms.ifCount >= fixtureCase.minIfCount, `${fixtureCase.inputPath}: expected ifCount >= ${fixtureCase.minIfCount}`);
  if (fixtureCase.minWhileCount !== undefined) {
    assert.ok(parsed.parser.forms.whileCount >= fixtureCase.minWhileCount, `${fixtureCase.inputPath}: expected whileCount >= ${fixtureCase.minWhileCount}`);
  }
  if (fixtureCase.minLetCount !== undefined) {
    assert.ok(parsed.parser.forms.letCount >= fixtureCase.minLetCount, `${fixtureCase.inputPath}: expected letCount >= ${fixtureCase.minLetCount}`);
  }
  if (fixtureCase.minCondCount !== undefined) {
    assert.ok(parsed.parser.forms.condCount >= fixtureCase.minCondCount, `${fixtureCase.inputPath}: expected condCount >= ${fixtureCase.minCondCount}`);
  }
  if (fixtureCase.minAssignmentCount !== undefined) {
    assert.ok(parsed.parser.forms.assignmentCount >= fixtureCase.minAssignmentCount, `${fixtureCase.inputPath}: expected assignmentCount >= ${fixtureCase.minAssignmentCount}`);
    assert.ok(
      parsed.parser.forms.samples.some((form) => form.nodeKind === "VarSetForm" || form.nodeKind === "CmSetForm"),
      `${fixtureCase.inputPath}: expected sampled assignment form`
    );
  }
  if (parsed.parser.members.count > 0) {
    assert.ok(parsed.parser.ast.members.length > 0, `${fixtureCase.inputPath}: expected sampled member AST nodes`);
  }
  assert.ok(parsed.parser.ast.declarations.length > 0, `${fixtureCase.inputPath}: expected sampled declarations in AST`);
  assert.ok(parsed.parser.ast.forms.length > 0, `${fixtureCase.inputPath}: expected sampled forms in AST`);
}

function selectFixtureCases(argv) {
  if (argv.length === 0) {
    return fixtureCases;
  }
  const wanted = new Set(argv);
  const selected = fixtureCases.filter((fixtureCase) => wanted.has(fixtureCase.inputPath));
  assert.strictEqual(selected.length, wanted.size, `unknown fixture path in arguments: ${argv.join(", ")}`);
  return selected;
}

function main() {
  const selectedCases = selectFixtureCases(process.argv.slice(2));
  for (const fixtureCase of selectedCases) {
    validateFixtureCase(fixtureCase);
    process.stdout.write(`iw-fixture ok ${fixtureCase.inputPath}\n`);
  }
}

main();
