const fs = require("node:fs");

function readInput() {
  if (process.argv[2]) {
    return fs.readFileSync(process.argv[2], "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateToken(token, label) {
  assert(Number.isInteger(token.kindCode), `expected ${label}.kindCode`);
  assert(typeof token.kind === "string", `expected ${label}.kind`);
  assert(typeof token.lexeme === "string", `expected ${label}.lexeme`);
  assert(Number.isInteger(token.length), `expected ${label}.length`);
  assert(Number.isInteger(token.startOffset), `expected ${label}.startOffset`);
  assert(Number.isInteger(token.endOffset), `expected ${label}.endOffset`);
  assert(Number.isInteger(token.line), `expected ${label}.line`);
  assert(Number.isInteger(token.column), `expected ${label}.column`);
  assert(Number.isInteger(token.endColumn), `expected ${label}.endColumn`);
  assert(token.length === token.lexeme.length, `expected ${label}.length to match lexeme length`);
  assert(token.endOffset === token.startOffset + token.length, `expected ${label}.endOffset to be exclusive`);
  assert(token.endColumn === token.column + token.length, `expected ${label}.endColumn to be exclusive`);
}

function validateIwDump(parsed) {
  assert(parsed.kind === "IwDumpStub", "expected kind=IwDumpStub");
  assert(parsed.input && typeof parsed.input.path === "string", "expected input.path");
  assert(parsed.lexer && Number.isInteger(parsed.lexer.tokenCount), "expected lexer.tokenCount");
  assert(Number.isInteger(parsed.lexer.identifierCount), "expected lexer.identifierCount");
  assert(Number.isInteger(parsed.lexer.literalRefCount), "expected lexer.literalRefCount");
  assert(Number.isInteger(parsed.lexer.numberLiteralCount), "expected lexer.numberLiteralCount");
  assert(Number.isInteger(parsed.lexer.maxBracketDepth), "expected lexer.maxBracketDepth");
  assert(typeof parsed.lexer.hasUnbalancedBrackets === "boolean", "expected lexer.hasUnbalancedBrackets");
  assert(Array.isArray(parsed.lexer.sampleTokens), "expected lexer.sampleTokens");
  assert(parsed.lexer.sampleTokens.length === 3, "expected three lexer.sampleTokens");
  assert(Array.isArray(parsed.lexer.tokens), "expected lexer.tokens");
  assert(parsed.lexer.tokens.length === parsed.lexer.tokenCount, "expected lexer.tokens length to match tokenCount");
  for (const [index, token] of parsed.lexer.sampleTokens.entries()) {
    validateToken(token, `sampleTokens[${index}]`);
  }
  for (const [index, token] of parsed.lexer.tokens.entries()) {
    validateToken(token, `tokens[${index}]`);
    if (index > 0) {
      assert(token.startOffset >= parsed.lexer.tokens[index - 1].endOffset, `expected tokens[${index}] to be ordered`);
    }
  }
  const literalRefTokens = parsed.lexer.tokens.filter((token) => token.kind === "literalRef");
  assert(literalRefTokens.length === parsed.lexer.literalRefCount, "expected literalRef token count to match lexer.literalRefCount");
  for (const [index, token] of literalRefTokens.entries()) {
    assert(token.kindCode === 4, `expected literalRefTokens[${index}].kindCode=4`);
    assert(token.lexeme.startsWith("$"), `expected literalRefTokens[${index}] to start with $`);
  }
  const numberLiteralTokens = parsed.lexer.tokens.filter((token) => token.kind === "numberLiteral");
  assert(numberLiteralTokens.length === parsed.lexer.numberLiteralCount, "expected numberLiteral token count to match lexer.numberLiteralCount");
  for (const [index, token] of numberLiteralTokens.entries()) {
    assert(token.kindCode === 6, `expected numberLiteralTokens[${index}].kindCode=6`);
    assert(token.lexeme.startsWith("$"), `expected numberLiteralTokens[${index}] to start with $`);
    assert(token.lexeme.includes("^"), `expected numberLiteralTokens[${index}] to include type suffix`);
  }
  const keywordTokens = parsed.lexer.tokens.filter((token) => token.kind === "keyword");
  assert(keywordTokens.length >= parsed.parser.programCount, "expected keyword tokens to include program headers");
  for (const [index, token] of keywordTokens.entries()) {
    assert(token.kindCode === 5, `expected keywordTokens[${index}].kindCode=5`);
    assert(!token.lexeme.startsWith("$"), `expected keywordTokens[${index}] not to be literal ref`);
  }
  assert(parsed.lexer.tokenCount >= parsed.lexer.identifierCount, "expected tokenCount >= identifierCount");
  assert(parsed.lexer.tokenCount >= parsed.lexer.identifierCount + parsed.lexer.literalRefCount + parsed.lexer.numberLiteralCount, "expected tokenCount to cover atom sub-counts");
  assert(parsed.lexer.maxBracketDepth >= 0, "expected nonnegative maxBracketDepth");
  if (parsed.lexer.tokenCount > 0) {
    assert(JSON.stringify(parsed.lexer.tokens[0]) === JSON.stringify(parsed.lexer.sampleTokens[0]), "expected first full token to match first sample token");
    assert(parsed.lexer.sampleTokens[0].kindCode > 0, "expected first sample token kind");
    assert(parsed.lexer.sampleTokens[0].kind !== "none", "expected first sample token kind name");
    assert(parsed.lexer.sampleTokens[0].lexeme.length > 0, "expected first sample token lexeme");
    assert(parsed.lexer.sampleTokens[0].length > 0, "expected first sample token length");
    assert(parsed.lexer.sampleTokens[0].line > 0, "expected first sample token line");
    assert(parsed.lexer.sampleTokens[0].column > 0, "expected first sample token column");
    assert(parsed.lexer.sampleTokens[1].kindCode === 3, "expected first atom sample kind code");
    assert(parsed.lexer.sampleTokens[1].kind === "atom", "expected first atom sample kind");
    assert(parsed.lexer.sampleTokens[1].lexeme.length > 0, "expected first atom sample lexeme");
    assert(parsed.lexer.sampleTokens[2].kindCode === 3, "expected second atom sample kind code");
    assert(parsed.lexer.sampleTokens[2].kind === "atom", "expected second atom sample kind");
    assert(parsed.lexer.sampleTokens[2].lexeme.length > 0, "expected second atom sample lexeme");
  }
  assert(parsed.parser && Number.isInteger(parsed.parser.programCount), "expected parser.programCount");
  assert(parsed.parser.headers && typeof parsed.parser.headers.programUnit === "string", "expected parser.headers.programUnit");
  assert(typeof parsed.parser.headers.firstImportUnit === "string", "expected parser.headers.firstImportUnit");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.startOffset), "expected programLocation.startOffset");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.endOffset), "expected programLocation.endOffset");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.line), "expected programLocation.line");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.column), "expected programLocation.column");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.endLine), "expected programLocation.endLine");
  assert(Number.isInteger(parsed.parser.headers.programLocation?.endColumn), "expected programLocation.endColumn");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.startOffset), "expected firstImportLocation.startOffset");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.endOffset), "expected firstImportLocation.endOffset");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.line), "expected firstImportLocation.line");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.column), "expected firstImportLocation.column");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.endLine), "expected firstImportLocation.endLine");
  assert(Number.isInteger(parsed.parser.headers.firstImportLocation?.endColumn), "expected firstImportLocation.endColumn");
  assert(Number.isInteger(parsed.parser.headers.importCount), "expected parser.headers.importCount");
  assert(Array.isArray(parsed.parser.headers.samples), "expected parser.headers.samples");
  assert(parsed.parser.headers.samples.length === parsed.parser.headers.importCount, "expected parser.headers.samples length to match importCount");
  assert(parsed.parser.declarations && Number.isInteger(parsed.parser.declarations.count), "expected parser.declarations.count");
  assert(Number.isInteger(parsed.parser.declarations.functionCount), "expected parser.declarations.functionCount");
  assert(Number.isInteger(parsed.parser.declarations.classCount), "expected parser.declarations.classCount");
  assert(typeof parsed.parser.declarations.firstFunctionName === "string", "expected parser.declarations.firstFunctionName");
  assert(typeof parsed.parser.declarations.firstClassName === "string", "expected parser.declarations.firstClassName");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.startOffset), "expected firstFunctionLocation.startOffset");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.endOffset), "expected firstFunctionLocation.endOffset");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.line), "expected firstFunctionLocation.line");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.column), "expected firstFunctionLocation.column");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.endLine), "expected firstFunctionLocation.endLine");
  assert(Number.isInteger(parsed.parser.declarations.firstFunctionLocation?.endColumn), "expected firstFunctionLocation.endColumn");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.startOffset), "expected firstClassLocation.startOffset");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.endOffset), "expected firstClassLocation.endOffset");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.line), "expected firstClassLocation.line");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.column), "expected firstClassLocation.column");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.endLine), "expected firstClassLocation.endLine");
  assert(Number.isInteger(parsed.parser.declarations.firstClassLocation?.endColumn), "expected firstClassLocation.endColumn");
  assert(Array.isArray(parsed.parser.declarations.samples), "expected parser.declarations.samples");
  assert(Number.isInteger(parsed.parser.exportCount), "expected parser.exportCount");
  assert(parsed.parser.members && Number.isInteger(parsed.parser.members.count), "expected parser.members.count");
  assert(Number.isInteger(parsed.parser.members.publicCount), "expected parser.members.publicCount");
  assert(Number.isInteger(parsed.parser.members.propertyCount), "expected parser.members.propertyCount");
  assert(Number.isInteger(parsed.parser.members.constructorCount), "expected parser.members.constructorCount");
  assert(Number.isInteger(parsed.parser.members.methodCount), "expected parser.members.methodCount");
  assert(Array.isArray(parsed.parser.members.samples), "expected parser.members.samples");
  assert(parsed.parser.forms && Number.isInteger(parsed.parser.forms.varCount), "expected parser.forms.varCount");
  assert(Number.isInteger(parsed.parser.forms.ifCount), "expected parser.forms.ifCount");
  assert(Number.isInteger(parsed.parser.forms.whileCount), "expected parser.forms.whileCount");
  assert(Number.isInteger(parsed.parser.forms.matchCount), "expected parser.forms.matchCount");
  assert(Number.isInteger(parsed.parser.forms.letCount), "expected parser.forms.letCount");
  assert(Number.isInteger(parsed.parser.forms.condCount), "expected parser.forms.condCount");
  assert(Number.isInteger(parsed.parser.forms.returnTypeCount), "expected parser.forms.returnTypeCount");
  assert(Number.isInteger(parsed.parser.forms.assignmentCount), "expected parser.forms.assignmentCount");
  assert(Array.isArray(parsed.parser.forms.samples), "expected parser.forms.samples");
  if ("rawAst" in parsed.parser) {
    assert(parsed.parser.rawAst && typeof parsed.parser.rawAst.kind === "string", "expected parser.rawAst kind");
  }
  assert(parsed.parser.ast && parsed.parser.ast.nodeKind === "Program", "expected parser.ast Program node");
  assert(parsed.parser.ast.programUnit === parsed.parser.headers.programUnit, "expected ast programUnit to match headers");
  assert(Number.isInteger(parsed.parser.ast.location?.startOffset), "expected ast.location.startOffset");
  assert(parsed.parser.ast.imports && Number.isInteger(parsed.parser.ast.imports.count), "expected ast.imports.count");
  assert(parsed.parser.ast.imports.count === parsed.parser.headers.importCount, "expected ast import count to match headers");
  assert(Array.isArray(parsed.parser.ast.declarations), "expected ast.declarations");
  assert(Array.isArray(parsed.parser.ast.members), "expected ast.members");
  assert(Array.isArray(parsed.parser.ast.forms), "expected ast.forms");
  assert(parsed.parser.ast.declarations.length <= parsed.parser.declarations.count, "expected ast declarations to be sampled from declarations");
  for (const [index, declaration] of parsed.parser.ast.declarations.entries()) {
    assert(["FunctionDecl", "ClassDecl"].includes(declaration.nodeKind), `expected ast.declarations[${index}].nodeKind`);
    assert(typeof declaration.name === "string" && declaration.name.length > 0, `expected ast.declarations[${index}].name`);
    assert(Number.isInteger(declaration.location?.startOffset), `expected ast.declarations[${index}].location.startOffset`);
    assert(Number.isInteger(declaration.location?.endOffset), `expected ast.declarations[${index}].location.endOffset`);
    assert(declaration.location.endOffset > declaration.location.startOffset, `expected positive ast.declarations[${index}] span`);
    assert(typeof declaration.isExported === "boolean", `expected ast.declarations[${index}].isExported`);
  }
  for (const [index, declaration] of parsed.parser.declarations.samples.entries()) {
    assert(["FunctionDecl", "ClassDecl"].includes(declaration.nodeKind), `expected declarations.samples[${index}].nodeKind`);
    assert(typeof declaration.name === "string" && declaration.name.length > 0, `expected declarations.samples[${index}].name`);
    assert(typeof declaration.isExported === "boolean", `expected declarations.samples[${index}].isExported`);
  }
  for (const [index, importSample] of parsed.parser.headers.samples.entries()) {
    assert(typeof importSample.name === "string" && importSample.name.length > 0, `expected headers.samples[${index}].name`);
    assert(Number.isInteger(importSample.location?.startOffset), `expected headers.samples[${index}].location.startOffset`);
    assert(Number.isInteger(importSample.location?.endOffset), `expected headers.samples[${index}].location.endOffset`);
  }
  for (const [index, member] of parsed.parser.members.samples.entries()) {
    assert(["PropertyDecl", "ConstructorDecl", "MethodDecl"].includes(member.nodeKind), `expected members.samples[${index}].nodeKind`);
    assert(typeof member.name === "string" && member.name.length > 0, `expected members.samples[${index}].name`);
    assert(Number.isInteger(member.location?.startOffset), `expected members.samples[${index}].location.startOffset`);
    assert(typeof member.isPublic === "boolean", `expected members.samples[${index}].isPublic`);
  }
  for (const [index, form] of parsed.parser.forms.samples.entries()) {
    assert(["VarForm", "IfForm", "WhileForm", "MatchForm", "LetForm", "CondForm", "VarSetForm", "CmSetForm"].includes(form.nodeKind), `expected forms.samples[${index}].nodeKind`);
    assert(typeof form.name === "string" && form.name.length > 0, `expected forms.samples[${index}].name`);
    assert(Number.isInteger(form.location?.startOffset), `expected forms.samples[${index}].location.startOffset`);
  }
  for (const [index, member] of parsed.parser.ast.members.entries()) {
    assert(["PropertyDecl", "ConstructorDecl", "MethodDecl"].includes(member.nodeKind), `expected ast.members[${index}].nodeKind`);
    assert(typeof member.name === "string" && member.name.length > 0, `expected ast.members[${index}].name`);
    assert(typeof member.isPublic === "boolean", `expected ast.members[${index}].isPublic`);
  }
  for (const [index, form] of parsed.parser.ast.forms.entries()) {
    assert(["VarForm", "IfForm", "WhileForm", "MatchForm", "LetForm", "CondForm", "VarSetForm", "CmSetForm"].includes(form.nodeKind), `expected ast.forms[${index}].nodeKind`);
    assert(typeof form.name === "string" && form.name.length > 0, `expected ast.forms[${index}].name`);
  }
  assert(parsed.parser && typeof parsed.parser.hasErrors === "boolean", "expected parser.hasErrors");
  if (!parsed.parser.hasErrors) {
    assert(parsed.parser.programCount === 1, "expected one program header for valid dump");
    assert(parsed.parser.headers.programUnit.length > 0, "expected nonempty parser.headers.programUnit");
    assert(parsed.parser.headers.programLocation.line > 0, "expected positive program line");
    assert(parsed.parser.headers.programLocation.column > 0, "expected positive program column");
    assert(parsed.parser.headers.programLocation.endOffset > parsed.parser.headers.programLocation.startOffset, "expected positive program offset span");
    assert(parsed.parser.headers.programLocation.endLine === parsed.parser.headers.programLocation.line, "expected single-line program span");
    assert(
      parsed.parser.headers.programLocation.endColumn === parsed.parser.headers.programLocation.column + (parsed.parser.headers.programLocation.endOffset - parsed.parser.headers.programLocation.startOffset),
      "expected program endColumn to be exclusive"
    );
    assert(parsed.parser.declarations.count >= 1, "expected at least one declaration");
    assert(
      parsed.parser.declarations.count === parsed.parser.declarations.functionCount + parsed.parser.declarations.classCount,
      "expected declaration count to match function + class counts"
    );
    assert(parsed.parser.declarations.samples.length <= parsed.parser.declarations.count, "expected sampled declarations not to exceed declaration count");
    assert(
      parsed.parser.members.count === parsed.parser.members.propertyCount + parsed.parser.members.constructorCount + parsed.parser.members.methodCount,
      "expected member count to match property + constructor + method counts"
    );
    assert(parsed.parser.members.samples.length <= parsed.parser.members.count, "expected sampled members not to exceed member count");
    assert(parsed.parser.forms.varCount >= 1, "expected at least one var form in fixture");
    assert(parsed.parser.forms.samples.length <= parsed.parser.forms.varCount + parsed.parser.forms.ifCount + parsed.parser.forms.whileCount + parsed.parser.forms.matchCount + parsed.parser.forms.letCount + parsed.parser.forms.condCount + parsed.parser.forms.assignmentCount, "expected sampled forms not to exceed total tracked forms");
    if (parsed.parser.declarations.firstFunctionName.length > 0) {
      assert(parsed.parser.ast.declarations.some((declaration) => declaration.nodeKind === "FunctionDecl" && declaration.name === parsed.parser.declarations.firstFunctionName), "expected ast to include first function declaration");
      assert(parsed.parser.declarations.firstFunctionLocation.line > 0, "expected positive first function line");
      assert(parsed.parser.declarations.firstFunctionLocation.column > 0, "expected positive first function column");
      assert(parsed.parser.declarations.firstFunctionLocation.endOffset > parsed.parser.declarations.firstFunctionLocation.startOffset, "expected positive first function offset span");
      assert(parsed.parser.declarations.firstFunctionLocation.endLine === parsed.parser.declarations.firstFunctionLocation.line, "expected single-line first function span");
    }
  }
  assert(Array.isArray(parsed.writerSmoke?.array), "expected writerSmoke.array");
  assert(parsed.writerSmoke?.object?.stable === true, "expected writerSmoke.object.stable=true");
  assert(Array.isArray(parsed.writerSmoke?.emptyArray), "expected writerSmoke.emptyArray");
  assert(parsed.writerSmoke.emptyArray.length === 0, "expected empty writerSmoke.emptyArray");
  assert(parsed.writerSmoke?.emptyObject && Object.keys(parsed.writerSmoke.emptyObject).length === 0, "expected empty writerSmoke.emptyObject");
}

module.exports = {
  validateIwDump
};

if (require.main === module) {
  const parsed = JSON.parse(readInput());
  validateIwDump(parsed);
  process.stdout.write("iw-dump scaffold ok\n");
}
