import { strictEqual, throws } from "assert";
import {
    buildDeclaredCFunctionConfirmationTag,
    buildDeclaredCFunctionName,
    buildExportedIwFunctionConfirmationTag,
    buildExportedIwFunctionName,
    parseDeclaredCFunctionName,
    parseExportedIwFunctionName,
    validateDeclaredCFunctionName,
    validateExportedIwFunctionName
} from "../DeclaredCFunctionName";
import { parseProgramSource } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";

const namespaceUuid: string = "6f3c1e4b2a9d4f6e8c1b3d5a7f9e2c4b";
const functionName: string = "iw_sys_fd_open_read_s3";
const expectedTag: string = buildDeclaredCFunctionConfirmationTag(namespaceUuid, functionName);
const fullName: string = buildDeclaredCFunctionName(namespaceUuid, functionName);

strictEqual(
    expectedTag,
    fullName.slice(-8),
    "declared C function names should embed the computed 32-bit confirmation tag"
);

const parsed = parseDeclaredCFunctionName(fullName);
if (parsed === null) {
    throw new Error("expected declared C function name to parse");
}

strictEqual(parsed.uuid, namespaceUuid, "parsed UUID mismatch");
strictEqual(parsed.functionName, functionName, "parsed function name mismatch");
strictEqual(parsed.confirmationTag, expectedTag, "parsed confirmation tag mismatch");
strictEqual(validateDeclaredCFunctionName(fullName).fullName, fullName, "validated function name mismatch");

throws(
    () => validateDeclaredCFunctionName(`_${namespaceUuid}_clang_${functionName}_deadbeef`),
    /invalid confirmation tag/,
    "declare names with mismatched tags should fail validation"
);

throws(
    () => validateDeclaredCFunctionName("iw_sys_fd_open_read_s3"),
    /must use the _<uuid>_clang_<function_name>_<tag1> naming scheme/,
    "legacy declare names should fail validation"
);

const exportedFunctionName: string = "iw_callable_echo_s3";
const expectedExportedTag: string = buildExportedIwFunctionConfirmationTag(namespaceUuid, exportedFunctionName);
const exportedFullName: string = buildExportedIwFunctionName(namespaceUuid, exportedFunctionName);

strictEqual(
    expectedExportedTag,
    exportedFullName.slice(-8),
    "exported IW function names should embed the computed 32-bit confirmation tag"
);

const parsedExported = parseExportedIwFunctionName(exportedFullName);
if (parsedExported === null) {
    throw new Error("expected exported IW function name to parse");
}

strictEqual(parsedExported.uuid, namespaceUuid, "parsed exported UUID mismatch");
strictEqual(parsedExported.functionName, exportedFunctionName, "parsed exported function name mismatch");
strictEqual(parsedExported.confirmationTag, expectedExportedTag, "parsed exported confirmation tag mismatch");
strictEqual(validateExportedIwFunctionName(exportedFullName).fullName, exportedFullName, "validated exported function name mismatch");

throws(
    () => validateExportedIwFunctionName(`_${namespaceUuid}_iwlang_${exportedFunctionName}_deadbeef`),
    /invalid iwlang confirmation tag/,
    "iwlang names with mismatched tags should fail validation"
);

throws(
    () => validateExportedIwFunctionName("iw_callable_echo_s3"),
    /must use the _<uuid>_iwlang_<function_name>_<tag1> naming scheme/,
    "legacy iwlang names should fail validation"
);

const duplicateUuid: string = "b7b865f2e4f9418e9d4e7634d480c82b";
const duplicateLeft: string = buildDeclaredCFunctionName(duplicateUuid, "iw_duplicate_left");
const duplicateRight: string = buildDeclaredCFunctionName(duplicateUuid, "iw_duplicate_right");
throws(
    () => performTypeChecking(parseProgramSource(`{program test~duplicate~extern~uuid@main
  (declare (function ${duplicateLeft} () to i5))
  (declare (function ${duplicateRight} () to i5))
}`), { disableBaseLibAutoLoad: true }),
    /external function UUID 'b7b865f2e4f9418e9d4e7634d480c82b' is reused/,
    "declared extern functions must not reuse UUIDs"
);

process.stdout.write("declared-c-function-name ok\n");
