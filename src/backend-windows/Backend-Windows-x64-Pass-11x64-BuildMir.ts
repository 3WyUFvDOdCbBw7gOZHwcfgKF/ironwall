import type {
    BackendValueRepresentation,
    CfgTrimmedRootCandidateBody,
    CfgTrimmedRootCandidateProgram,
    RepresentationSelectionBody,
    RepresentationSelectionProgram,
    X64MirBlock,
    X64MirBody,
    X64MirFunctionDefinition,
    X64MirInstruction,
    X64MirOperand,
    X64MirProgram,
    X64MirRegisterBank,
    X64MirVirtualRegisterOperand
} from "./Backend-Windows-IR-Shared";
import type {
    SsaBody,
    SsaFunctionDefinition,
    SsaOperand,
    SsaProgram,
    SsaStatement,
    SsaTerminator
} from "../Lowering-Frontend-Shared";
import { lowerGcCollectLikeSymbolToBuiltin } from "../DeclaredCFunctionName";
import { x64NativeBoxedNumberValueSymbol, x64NativeDirectFunctionValueSymbol } from "./Backend-Windows-X64-NativeSupport";

function baseName(name: string): string {
    const hashIndex = name.indexOf("#");
    return hashIndex >= 0 ? name.slice(0, hashIndex) : name;
}

function bankForRepresentation(representation: BackendValueRepresentation): X64MirRegisterBank {
    void representation;
    return "gpr";
}

function operandBank(name: string, selection: RepresentationSelectionBody): X64MirRegisterBank {
    return bankForRepresentation(selection.bindingRepresentations.get(baseName(name)) ?? "reference");
}

function encodeTaggedImmediateI64(value: number): number {
    return (value * 2) + 1;
}

function encodeTaggedImmediate(typeName: string, value: number): number {
    switch (typeName) {
        case "i5":
            return encodeTaggedImmediateI64(value | 0);
        case "u5":
            return encodeTaggedImmediateI64(value >>> 0);
        default:
            return encodeTaggedImmediateI64(value);
    }
}

function lowerOperand(operand: SsaOperand, selection: RepresentationSelectionBody): X64MirOperand {
    switch (operand.kind) {
        case "local":
            return operand.name.includes("#")
                ? { kind: "vreg", name: operand.name, bank: operandBank(operand.name, selection) }
                : { kind: "symbol", symbol: operand.name };
        case "direct_function":
            return { kind: "symbol", symbol: x64NativeDirectFunctionValueSymbol(operand.symbol) };
        case "number_literal":
            return operand.typeName === "f5" || operand.typeName === "f6" || operand.typeName === "f7"
                ? { kind: "symbol", symbol: x64NativeBoxedNumberValueSymbol(operand.typeName, operand.value) }
                : { kind: "imm_i64", value: encodeTaggedImmediate(operand.typeName, operand.value) };
        case "text_literal":
            return {
                kind: "text",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
    }
}

function lowerTarget(name: string, selection: RepresentationSelectionBody): X64MirVirtualRegisterOperand {
    return {
        kind: "vreg",
        name,
        bank: operandBank(name, selection)
    };
}

function gcRootsForStatement(cfgBody: CfgTrimmedRootCandidateBody | undefined, label: string, index: number): readonly string[] {
    const cfgBlock = cfgBody?.blocks.find((block) => block.label === label);
    return cfgBlock?.statementRoots[index]?.gcRoots ?? [];
}

function canonicalizeGcRoots(gcRoots: readonly string[]): readonly string[] {
    return [...gcRoots].sort((left, right) => left.localeCompare(right));
}

function lowerGcRootOperands(
    gcRoots: readonly string[],
    currentRoots: ReadonlyMap<string, X64MirOperand>
): readonly X64MirOperand[] {
    return gcRoots.map((name) => {
        const operand = currentRoots.get(name);
        if (!operand) {
            throw new Error(`x64 mir lowering failed: missing current root operand for '${name}'`);
        }
        return operand;
    });
}

function recordAssignedValue(
    statement: SsaStatement,
    selection: RepresentationSelectionBody,
    globalSymbols: ReadonlySet<string>,
    currentRoots: Map<string, X64MirOperand>
): void {
    void globalSymbols;
    switch (statement.kind) {
        case "assign":
        case "set_local":
            currentRoots.set(baseName(statement.target), lowerTarget(statement.target, selection));
            return;
        case "object_set_field":
        case "slot_store":
            return;
    }
}

function cloneMirOperand(operand: X64MirOperand): X64MirOperand {
    switch (operand.kind) {
        case "vreg":
            return { kind: "vreg", name: operand.name, bank: operand.bank };
        case "imm_i64":
            return { kind: "imm_i64", value: operand.value };
        case "symbol":
            return { kind: "symbol", symbol: operand.symbol };
        case "text":
            return {
                kind: "text",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
    }
}

function mirOperandKey(operand: X64MirOperand): string {
    switch (operand.kind) {
        case "vreg":
            return `vreg:${operand.name}:${operand.bank}`;
        case "imm_i64":
            return `imm_i64:${operand.value}`;
        case "symbol":
            return `symbol:${operand.symbol}`;
        case "text":
            return `text:${operand.referenceName}:${operand.typeName}:${operand.content}`;
    }
}

function rootEnvEquals(
    left: ReadonlyMap<string, X64MirOperand> | undefined,
    right: ReadonlyMap<string, X64MirOperand>
): boolean {
    if (!left || left.size !== right.size) {
        return false;
    }
    for (const [name, operand] of right.entries()) {
        const leftOperand = left.get(name);
        if (!leftOperand || mirOperandKey(leftOperand) !== mirOperandKey(operand)) {
            return false;
        }
    }
    return true;
}

function mergeRootEnvs(predecessors: readonly ReadonlyMap<string, X64MirOperand>[]): Map<string, X64MirOperand> {
    if (predecessors.length === 0) {
        return new Map();
    }
    const candidateNames = new Set<string>();
    predecessors.forEach((roots) => roots.forEach((_operand, name) => candidateNames.add(name)));
    const merged = new Map<string, X64MirOperand>();
    for (const name of candidateNames) {
        const operands = predecessors
            .map((roots) => roots.get(name))
            .filter((operand): operand is X64MirOperand => operand !== undefined);
        if (operands.length === 0) {
            continue;
        }
        const firstOperand = operands[0]!;
        if (operands.every((operand) => mirOperandKey(operand) === mirOperandKey(firstOperand))) {
            merged.set(name, cloneMirOperand(firstOperand));
        }
    }
    return merged;
}

function buildEntryRootMap(
    ssaBody: SsaBody,
    selection: RepresentationSelectionBody,
    functionParamNames: readonly string[]
): Map<string, X64MirOperand> {
    const entryRoots = new Map<string, X64MirOperand>(
        functionParamNames.map((name) => [name, lowerTarget(`${name}#0`, selection)] as const)
    );
    for (const binding of ssaBody.entryBindings) {
        entryRoots.set(
            binding.variable,
            binding.value.includes("#")
                ? lowerTarget(binding.value, selection)
                : { kind: "symbol", symbol: binding.value }
        );
    }
    return entryRoots;
}

function simulateBlockExitRoots(
    block: SsaBody["blocks"][number],
    entryRoots: ReadonlyMap<string, X64MirOperand>,
    selection: RepresentationSelectionBody,
    globalSymbols: ReadonlySet<string>
): Map<string, X64MirOperand> {
    const currentRoots = new Map<string, X64MirOperand>(Array.from(entryRoots.entries()).map(([name, operand]) => [name, cloneMirOperand(operand)] as const));
    for (const statement of block.statements) {
        recordAssignedValue(statement, selection, globalSymbols, currentRoots);
    }
    return currentRoots;
}

function computeBlockEntryRoots(
    ssaBody: SsaBody,
    selection: RepresentationSelectionBody,
    functionParamNames: readonly string[],
    globalSymbols: ReadonlySet<string>
): ReadonlyMap<string, ReadonlyMap<string, X64MirOperand>> {
    const entryParamRoots = buildEntryRootMap(ssaBody, selection, functionParamNames);
    const blockEntryRoots = new Map<string, ReadonlyMap<string, X64MirOperand>>();
    const blockExitRoots = new Map<string, ReadonlyMap<string, X64MirOperand>>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const block of ssaBody.blocks) {
            const mergedRoots = block.label === ssaBody.entryLabel
                ? new Map<string, X64MirOperand>(Array.from(entryParamRoots.entries()).map(([name, operand]) => [name, cloneMirOperand(operand)] as const))
                : mergeRootEnvs(block.predecessors.map((label) => blockExitRoots.get(label) ?? new Map<string, X64MirOperand>()));
            for (const phi of block.phiNodes) {
                mergedRoots.set(baseName(phi.target), lowerTarget(phi.target, selection));
            }
            if (!rootEnvEquals(blockEntryRoots.get(block.label), mergedRoots)) {
                blockEntryRoots.set(block.label, mergedRoots);
                changed = true;
            }
            const exitRoots = simulateBlockExitRoots(block, mergedRoots, selection, globalSymbols);
            if (!rootEnvEquals(blockExitRoots.get(block.label), exitRoots)) {
                blockExitRoots.set(block.label, exitRoots);
                changed = true;
            }
        }
    }
    return blockEntryRoots;
}

function lowerInstruction(
    statement: SsaStatement,
    selection: RepresentationSelectionBody,
    globalSymbols: ReadonlySet<string>,
    gcRoots: readonly string[],
    gcRootOperands: readonly X64MirOperand[]
): X64MirInstruction {
    switch (statement.kind) {
        case "assign":
            switch (statement.value.kind) {
                case "copy":
                    return {
                        kind: "move",
                        target: lowerTarget(statement.target, selection),
                        source: lowerOperand(statement.value.value, selection),
                        gcRoots
                    };
                case "direct_call":
                    return {
                        kind: "call_direct",
                        target: lowerTarget(statement.target, selection),
                        symbol: lowerGcCollectLikeSymbolToBuiltin(statement.value.symbol),
                        args: statement.value.args.map((arg) => lowerOperand(arg, selection)),
                        gcRoots,
                        gcRootOperands
                    };
                case "closure_call":
                    return {
                        kind: "call_closure",
                        target: lowerTarget(statement.target, selection),
                        callee: lowerOperand(statement.value.callee, selection),
                        args: statement.value.args.map((arg) => lowerOperand(arg, selection)),
                        gcRoots,
                        gcRootOperands
                    };
                case "object_alloc":
                    return {
                        kind: "object_alloc",
                        target: lowerTarget(statement.target, selection),
                        className: statement.value.className,
                        gcRoots,
                        gcRootOperands
                    };
                case "object_get_field":
                    return {
                        kind: "object_get_field",
                        target: lowerTarget(statement.target, selection),
                        receiver: lowerOperand(statement.value.receiver, selection),
                        className: statement.value.className,
                        fieldName: statement.value.fieldName,
                        gcRoots,
                        gcRootOperands
                    };
                case "slot_load":
                    return {
                        kind: "slot_load",
                        target: lowerTarget(statement.target, selection),
                        receiver: lowerOperand(statement.value.receiver, selection),
                        className: statement.value.className,
                        slotName: statement.value.slotName,
                        gcRoots,
                        gcRootOperands
                    };
                case "union_inject":
                    return {
                        kind: "union_inject",
                        target: lowerTarget(statement.target, selection),
                        unionTypeTagId: statement.value.unionTypeTagId,
                        memberTypeTagId: statement.value.memberTypeTagId,
                        value: lowerOperand(statement.value.value, selection),
                        gcRoots,
                        gcRootOperands
                    };
                case "union_has_tag":
                    return {
                        kind: "union_has_tag",
                        target: lowerTarget(statement.target, selection),
                        unionValue: lowerOperand(statement.value.unionValue, selection),
                        unionTypeTagId: statement.value.unionTypeTagId,
                        memberTypeTagId: statement.value.memberTypeTagId,
                        gcRoots,
                        gcRootOperands
                    };
                case "union_get_payload":
                    return {
                        kind: "union_get_payload",
                        target: lowerTarget(statement.target, selection),
                        unionValue: lowerOperand(statement.value.unionValue, selection),
                        unionTypeTagId: statement.value.unionTypeTagId,
                        memberTypeTagId: statement.value.memberTypeTagId,
                        gcRoots,
                        gcRootOperands
                    };
                case "closure_create":
                    return {
                        kind: "closure_create",
                        target: lowerTarget(statement.target, selection),
                        closureId: statement.value.closureId,
                        applySymbol: statement.value.applySymbol,
                        environmentLayout: statement.value.environmentLayout,
                        captures: statement.value.captures.map((capture) => lowerOperand(capture, selection)),
                        gcRoots,
                        gcRootOperands
                    };
            }
        case "set_local":
            void globalSymbols;
            return {
                kind: "move",
                target: lowerTarget(statement.target, selection),
                source: lowerOperand(statement.value, selection),
                gcRoots
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: lowerOperand(statement.receiver, selection),
                className: statement.className,
                fieldName: statement.fieldName,
                value: lowerOperand(statement.value, selection),
                gcRoots,
                gcRootOperands
            };
        case "slot_store":
            return {
                kind: "slot_store",
                receiver: lowerOperand(statement.receiver, selection),
                className: statement.className,
                slotName: statement.slotName,
                value: lowerOperand(statement.value, selection),
                gcRoots,
                gcRootOperands
            };
    }
}

function phiArgsForTarget(body: SsaBody, target: string, predecessor: string, selection: RepresentationSelectionBody): readonly X64MirOperand[] {
    const targetBlock = body.blocks.find((block) => block.label === target);
    if (!targetBlock) {
        return [];
    }
    return targetBlock.phiNodes.map((phi) => {
        const source = phi.sources.find((candidate) => candidate.predecessor === predecessor);
        if (!source) {
            throw new Error(`x64 mir lowering failed: missing phi source from '${predecessor}' to '${target}'`);
        }
        return lowerOperand(source.value, selection);
    });
}

function lowerTerminator(terminator: SsaTerminator, body: SsaBody, currentLabel: string, selection: RepresentationSelectionBody) {
    switch (terminator.kind) {
        case "return":
            return { kind: "return", value: lowerOperand(terminator.value, selection) } as const;
        case "jump":
            return {
                kind: "jump",
                target: terminator.target,
                args: phiArgsForTarget(body, terminator.target, currentLabel, selection)
            } as const;
        case "branch":
            return {
                kind: "branch",
                cond: lowerOperand(terminator.cond, selection),
                trueTarget: terminator.trueTarget,
                trueArgs: phiArgsForTarget(body, terminator.trueTarget, currentLabel, selection),
                falseTarget: terminator.falseTarget,
                falseArgs: phiArgsForTarget(body, terminator.falseTarget, currentLabel, selection)
            } as const;
    }
}

function lowerBody(
    ssaBody: SsaBody,
    selection: RepresentationSelectionBody,
    functionParamNames: readonly string[],
    globalSymbols: ReadonlySet<string>,
    cfgBody?: CfgTrimmedRootCandidateBody
): X64MirBody {
    const blockEntryRoots = computeBlockEntryRoots(ssaBody, selection, functionParamNames, globalSymbols);
    const blocks: X64MirBlock[] = ssaBody.blocks.map((block) => {
        const currentRoots = new Map<string, X64MirOperand>(
            Array.from((blockEntryRoots.get(block.label) ?? new Map<string, X64MirOperand>()).entries())
                .map(([name, operand]) => [name, cloneMirOperand(operand)] as const)
        );
        const params = block.phiNodes.map((phi) => {
            const target = lowerTarget(phi.target, selection);
            currentRoots.set(baseName(phi.target), target);
            return target;
        });
        const instructions: X64MirInstruction[] = [];
        block.statements.forEach((statement, index) => {
            const gcRoots = canonicalizeGcRoots(gcRootsForStatement(cfgBody, block.label, block.statementSourceIndexes[index] ?? index));
            const gcRootOperands = lowerGcRootOperands(gcRoots, currentRoots);
            const lowered = lowerInstruction(statement, selection, globalSymbols, gcRoots, gcRootOperands);
            instructions.push(lowered);
            if (statement.kind === "set_local" && globalSymbols.has(baseName(statement.target))) {
                instructions.push({
                    kind: "move",
                    target: { kind: "symbol", symbol: baseName(statement.target) },
                    source: lowerTarget(statement.target, selection),
                    gcRoots: []
                });
            }
            recordAssignedValue(statement, selection, globalSymbols, currentRoots);
        });
        return {
            label: block.label,
            predecessors: block.predecessors,
            params,
            instructions,
            terminator: lowerTerminator(block.terminator, ssaBody, block.label, selection)
        };
    });
    return {
        entryLabel: ssaBody.entryLabel,
        gcRootNames: cfgBody?.gcRootNames ?? [],
        blocks
    };
}

function lowerFunction(
    fn: SsaFunctionDefinition,
    selection: RepresentationSelectionBody,
    globalSymbols: ReadonlySet<string>,
    cfgBody?: CfgTrimmedRootCandidateBody
): X64MirFunctionDefinition {
    const body = lowerBody(fn.body, selection, fn.params.map((param) => param.name), globalSymbols, cfgBody);
    const functionParamTargets = fn.params.map((param) => lowerTarget(`${param.name}#0`, selection));
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: {
            ...body,
            blocks: body.blocks.map((block) => block.label === body.entryLabel
                ? { ...block, params: [...functionParamTargets, ...block.params] }
                : block)
        },
        origin: fn.origin
    };
}

export function buildX64MirPass(
    ssa: SsaProgram,
    selection: RepresentationSelectionProgram,
    cfgTrimmed: CfgTrimmedRootCandidateProgram
): X64MirProgram {
    const selectionByFunction = new Map(selection.functions.map((fn) => [fn.symbol, fn.body] as const));
    const cfgByFunction = new Map(cfgTrimmed.functions.map((fn) => [fn.symbol, fn.body] as const));
    const globalSymbols = new Set(ssa.globals.map((globalDef) => globalDef.symbol));
    const entryBody = lowerBody(ssa.entry, selection.entry, ssa.metadata.entryParams.map((param) => param.name), globalSymbols, cfgTrimmed.entry);
    const entryParamTargets = ssa.metadata.entryParams.map((param) => lowerTarget(`${param.name}#0`, selection.entry));
    return {
        kind: "x64_mir_program",
        entry: {
            ...entryBody,
            blocks: entryBody.blocks.map((block) => block.label === entryBody.entryLabel
                ? { ...block, params: [...entryParamTargets, ...block.params] }
                : block)
        },
        globals: ssa.globals,
        functions: ssa.functions.map((fn) => lowerFunction(
            fn,
            selectionByFunction.get(fn.symbol) ?? { bindingRepresentations: new Map(), resultRepresentation: "reference" },
            globalSymbols,
            cfgByFunction.get(fn.symbol)
        )),
        declaredFunctions: ssa.declaredFunctions,
        closureHelpers: ssa.closureHelpers,
        layouts: ssa.layouts,
        metadata: ssa.metadata
    };
}
