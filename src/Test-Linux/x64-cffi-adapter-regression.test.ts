import { ok, strictEqual } from "assert";
import type {
    BackendExternFunctionIR,
    ClosureFunctionOrigin,
    LoweringExportedIwFunction,
    LoweringLayoutTable,
    LoweringMetadata,
    LoweringSnapshotDeclaredFunction
} from "../Lowering-Frontend-Shared";
import { generateX64NativeSupportCFromFinalBackendIR } from "../backend-linux/Backend-Linux-C";
import type {
    BackendFunctionIR,
    FinalBackendIRProgram,
    X64MirBody,
    X64MirImmediateI64Operand,
    X64MirProgram,
    X64MirVirtualRegisterOperand,
    X64SelectedCallDirectInstruction,
    X64SelectedInstruction,
} from "../backend-linux/Backend-Linux-IR-Shared";
import { selectX64InstructionsPass as selectNoOptimizeX64InstructionsPass } from "../backend-linux/Backend-Linux-x64-NoOptimize-Pass-2-SelectInstr";
import { selectX64InstructionsPass as selectOptimizedX64InstructionsPass } from "../backend-linux/Backend-Linux-x64-Pass-12x64-SelectInstr";
import { FunctionTypeValue, PrimitiveTypeValue } from "../backend-linux/Backend-Linux-Typecheck-Core";
import { x64NativeDirectCallWrapperSymbol } from "../X64-NativeSupport";

const CFFI_SYMBOL = "test_cffi_add7";
const IW_EXTERNAL_SYMBOL = "test~external@iw_add7";
const HOST_ENTRY_INTERNAL_SYMBOL = "iw_internal_entry_main";
const HOST_EXPORTED_INTERNAL_SYMBOL = "iw_internal_export_i5";
const HOST_EXPORTED_HOST_SYMBOL = "iw_host_export_i5";
const I5_TYPE = new PrimitiveTypeValue("i5");
const EMPTY_LAYOUTS: LoweringLayoutTable = {
    kind: "lowering_layout_table",
    classes: new Map()
};
const TOP_LEVEL_ORIGIN: ClosureFunctionOrigin = {
    kind: "top_level"
};

function buildMetadata(exportedIwFunctions: readonly LoweringExportedIwFunction[] = []): LoweringMetadata {
    return {
        sourceTopLevelNodeCount: 0,
        executableStatementCount: 0,
        concreteClassCount: 0,
        concreteFunctionCount: 0,
        monomorphizedClassCount: 0,
        monomorphizedFunctionCount: 0,
        concreteClassTypeTagIds: [],
        referencedUnionTypeTagIds: [],
        referencedUnionMetadata: [],
        exportedIwFunctions,
        entryConcreteFunctionSymbol: null,
        entryParams: []
    };
}

function buildI5ParamTypes(count: number): PrimitiveTypeValue[] {
    const types: PrimitiveTypeValue[] = [];
    for (let index = 0; index < count; index += 1) {
        types.push(I5_TYPE);
    }
    return types;
}

function buildParamNames(count: number): readonly string[] {
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
        names.push(`arg${index}`);
    }
    return names;
}

function buildDeclaredFunction(symbol: string, callingConvention: "c_ffi" | "iw_external"): LoweringSnapshotDeclaredFunction {
    const paramTypes = buildI5ParamTypes(7);
    return {
        symbol,
        paramNames: buildParamNames(7),
        functionType: new FunctionTypeValue(paramTypes, I5_TYPE),
        sourceName: symbol,
        callingConvention
    };
}

function immI64(value: number): X64MirImmediateI64Operand {
    return {
        kind: "imm_i64",
        value
    };
}

function vreg(name: string): X64MirVirtualRegisterOperand {
    return {
        kind: "vreg",
        name,
        bank: "gpr"
    };
}

function buildSelectMirBody(): X64MirBody {
    return {
        entryLabel: "entry",
        gcRootNames: [],
        blocks: [{
            label: "entry",
            predecessors: [],
            params: [],
            instructions: [{
                kind: "call_direct",
                target: vreg("cffi_result"),
                symbol: CFFI_SYMBOL,
                args: [immI64(1), immI64(2), immI64(3), immI64(4), immI64(5), immI64(6), immI64(7)],
                gcRoots: [],
                gcRootOperands: []
            }, {
                kind: "call_direct",
                target: vreg("iw_external_result"),
                symbol: IW_EXTERNAL_SYMBOL,
                args: [immI64(11), immI64(12), immI64(13), immI64(14), immI64(15), immI64(16), immI64(17)],
                gcRoots: [],
                gcRootOperands: []
            }],
            terminator: {
                kind: "return",
                value: immI64(0)
            }
        }]
    };
}

function buildSelectMirProgram(): X64MirProgram {
    return {
        kind: "x64_mir_program",
        entry: buildSelectMirBody(),
        globals: [],
        functions: [],
        declaredFunctions: [
            buildDeclaredFunction(CFFI_SYMBOL, "c_ffi"),
            buildDeclaredFunction(IW_EXTERNAL_SYMBOL, "iw_external")
        ],
        closureHelpers: [],
        layouts: EMPTY_LAYOUTS,
        metadata: buildMetadata()
    };
}

function collectDirectCalls(instructions: readonly X64SelectedInstruction[]): readonly X64SelectedCallDirectInstruction[] {
    const calls: X64SelectedCallDirectInstruction[] = [];
    for (const instruction of instructions) {
        if (instruction.kind === "call_direct") {
            calls.push(instruction);
        }
    }
    return calls;
}

function hasImplicitStackArgCopy(instructions: readonly X64SelectedInstruction[]): boolean {
    for (const instruction of instructions) {
        if (instruction.kind !== "copy") {
            continue;
        }
        if (instruction.target.kind === "stack_arg") {
            return true;
        }
    }
    return false;
}

function assertSelectedCallConventions(
    label: string,
    selectProgram: (program: X64MirProgram) => { readonly entry: { readonly blocks: readonly { readonly instructions: readonly X64SelectedInstruction[]; }[]; } }
): void {
    const selectedProgram = selectProgram(buildSelectMirProgram());
    const instructions = selectedProgram.entry.blocks[0].instructions;
    const calls = collectDirectCalls(instructions);

    strictEqual(calls.length, 2, `${label} should keep both direct calls`);
    strictEqual(hasImplicitStackArgCopy(instructions), false, `${label} should model outgoing stack args on call_direct instead of copy->stack_arg`);

    strictEqual(calls[0].callingConvention, "sysv_c_ffi", `${label} should classify declared c_ffi calls as sysv_c_ffi`);
    strictEqual(calls[0].symbol, x64NativeDirectCallWrapperSymbol(CFFI_SYMBOL), `${label} should route c_ffi calls through the Linux direct-call adapter`);
    strictEqual(calls[0].stackArgs.length, 1, `${label} should record one outgoing stack arg for the c_ffi call`);
    strictEqual(calls[0].stackArgs[0].kind, "imm_i64", `${label} should preserve the c_ffi stack argument operand`);
    if (calls[0].stackArgs[0].kind === "imm_i64") {
        strictEqual(calls[0].stackArgs[0].value, 7, `${label} should preserve the c_ffi stack argument value`);
    }

    strictEqual(calls[1].callingConvention, "internal", `${label} should classify declared iw_external calls as internal`);
    strictEqual(calls[1].symbol, IW_EXTERNAL_SYMBOL, `${label} should call iw_external symbols directly without a C adapter`);
    strictEqual(calls[1].stackArgs.length, 1, `${label} should record one outgoing stack arg for the iw_external call`);
    strictEqual(calls[1].stackArgs[0].kind, "imm_i64", `${label} should preserve the iw_external stack argument operand`);
    if (calls[1].stackArgs[0].kind === "imm_i64") {
        strictEqual(calls[1].stackArgs[0].value, 17, `${label} should preserve the iw_external stack argument value`);
    }
}

function buildExternFunction(symbol: string, callingConvention: "c_ffi" | "iw_external"): BackendExternFunctionIR {
    const params = buildParamNames(7);
    const paramTypes = buildI5ParamTypes(7);
    return {
        symbol,
        params,
        paramTypes,
        paramRepresentations: ["immediate", "immediate", "immediate", "immediate", "immediate", "immediate", "immediate"],
        resultType: I5_TYPE,
        resultRepresentation: "immediate",
        callingConvention
    };
}

function buildBackendEntry(symbol: string): BackendFunctionIR {
    return {
        symbol,
        params: [],
        locals: [],
        bindingRepresentations: new Map(),
        immediateNames: [],
        resultRepresentation: "immediate",
        gcRootNames: [],
        gcPlan: {
            gcRootNames: [],
            statementPlans: [],
            resultGcRoots: []
        },
        statements: [],
        result: {
            kind: "number_literal",
            value: 0,
            typeName: "i5"
        },
        origin: TOP_LEVEL_ORIGIN,
        unitId: null
    };
}

function buildBackendFunction(symbol: string, params: readonly string[]): BackendFunctionIR {
    return {
        symbol,
        params,
        locals: [],
        bindingRepresentations: new Map(params.map((param) => [param, "immediate"] as const)),
        immediateNames: [...params],
        resultRepresentation: "immediate",
        gcRootNames: [],
        gcPlan: {
            gcRootNames: [],
            statementPlans: [],
            resultGcRoots: []
        },
        statements: [],
        result: {
            kind: "number_literal",
            value: 0,
            typeName: "i5"
        },
        origin: TOP_LEVEL_ORIGIN,
        unitId: null
    };
}

function buildSupportProgram(): FinalBackendIRProgram {
    return {
        kind: "final_backend_ir_program",
        entry: buildBackendEntry("test~main@entry"),
        globals: [],
        functions: [],
        externFunctions: [
            buildExternFunction(CFFI_SYMBOL, "c_ffi"),
            buildExternFunction(IW_EXTERNAL_SYMBOL, "iw_external")
        ],
        closureHelpers: [],
        layouts: EMPTY_LAYOUTS,
        metadata: buildMetadata()
    };
}

function buildHostAdapterSupportProgram(): FinalBackendIRProgram {
    return {
        kind: "final_backend_ir_program",
        entry: buildBackendEntry(HOST_ENTRY_INTERNAL_SYMBOL),
        globals: [],
        functions: [buildBackendFunction(HOST_EXPORTED_INTERNAL_SYMBOL, ["arg0"])],
        externFunctions: [],
        closureHelpers: [],
        layouts: EMPTY_LAYOUTS,
        metadata: buildMetadata([{
            concreteSymbol: HOST_EXPORTED_INTERNAL_SYMBOL,
            exportSymbol: HOST_EXPORTED_HOST_SYMBOL,
            paramTypes: [I5_TYPE],
            resultType: I5_TYPE
        }])
    };
}

function assertSupportCAdapterEmission(): void {
    const supportC = generateX64NativeSupportCFromFinalBackendIR(
        buildSupportProgram(),
        "",
        undefined,
        "",
        {
            omitHostEntryWrapper: true,
            omitRuntimeInit: true
        }
    );

    ok(
        supportC.includes(x64NativeDirectCallWrapperSymbol(CFFI_SYMBOL)),
        "support C should emit a direct-call adapter for c_ffi symbols"
    );
    strictEqual(
        supportC.includes(x64NativeDirectCallWrapperSymbol(IW_EXTERNAL_SYMBOL)),
        false,
        "support C should not emit a direct-call adapter for iw_external symbols"
    );
}

function assertSupportCHostInternalAbiSeparation(): void {
    const supportC = generateX64NativeSupportCFromFinalBackendIR(
        buildHostAdapterSupportProgram(),
        "",
        undefined,
        "",
        {
            omitRuntimeInit: true
        }
    );

    ok(supportC.includes("#ifndef IW_INTERNAL_ABI"), "support C should define IW_INTERNAL_ABI");
    ok(supportC.includes("#ifndef IW_HOST_ABI"), "support C should define IW_HOST_ABI");
    ok(
        supportC.includes("extern iw_value_t IW_INTERNAL_ABI iw_fn_iw_internal_entry_main() __asm__(\"iw_x64_entry\");"),
        "support C should mark the compiled entry prototype as internal ABI"
    );
    ok(
        supportC.includes("iw_value_t IW_HOST_ABI __iw_host_entry_main(int argc, char **argv) {"),
        "support C should emit the host entry wrapper with host ABI"
    );
    ok(
        supportC.includes("extern iw_value_t IW_INTERNAL_ABI iw_fn_iw_internal_export_i5(iw_value_t iw_param_arg0) __asm__(\"iw_internal_export_i5\");"),
        "support C should mark exported IW concrete targets as internal ABI"
    );
    ok(
        supportC.includes("int32_t IW_HOST_ABI iw_host_export_i5(int32_t iw_export_param_0) {"),
        "support C should emit exported IW host wrappers with host ABI"
    );
    ok(
        supportC.includes("iw_export_raw_result = iw_fn_iw_internal_export_i5(iw_from_i64((int64_t)(int32_t)(iw_export_param_0)));"),
        "support C should route exported IW host wrappers through the internal ABI target"
    );
}

assertSelectedCallConventions("optimized select", selectOptimizedX64InstructionsPass);
process.stdout.write("x64-cffi-adapter optimized select ok\n");

assertSelectedCallConventions("no-opt select", selectNoOptimizeX64InstructionsPass);
process.stdout.write("x64-cffi-adapter no-opt select ok\n");

assertSupportCAdapterEmission();
process.stdout.write("x64-cffi-adapter support-c ok\n");

assertSupportCHostInternalAbiSeparation();
process.stdout.write("x64-cffi-adapter host-internal abi ok\n");