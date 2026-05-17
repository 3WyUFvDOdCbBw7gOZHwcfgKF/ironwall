// x64 optimized backend pass 14a: compute block liveness summaries and live intervals for virtual registers.

import type {
    X64CopyPropagatedProgram,
    X64LivenessBlockSummary,
    X64LivenessBody,
    X64LivenessFunctionDefinition,
    X64LivenessInterval,
    X64LivenessProgram,
    X64MirRegisterBank,
    X64SelectedBlock,
    X64SelectedBody,
    X64SelectedFunctionDefinition,
    X64SelectedInstruction,
    X64SelectedOperand,
    X64SelectedTerminator
} from "./Backend-Windows-IR-Shared";

interface PositionRange {
    start: number;
    end: number;
}

interface FlatBodyAnalysis {
    readonly positions: Map<string, PositionRange>;
    readonly banks: Map<string, X64MirRegisterBank>;
    readonly callPositions: readonly number[];
}

interface BlockLocalFlowInfo {
    readonly usedBeforeDef: ReadonlySet<string>;
    readonly definedNames: ReadonlySet<string>;
}

function addOperandUseNamesBeforeDefinition(operand: X64SelectedOperand, into: Set<string>, definedNames: Set<string>): void {
    if (operand.kind !== "vreg") {
        return;
    }
    if (!definedNames.has(operand.name)) {
        into.add(operand.name);
    }
}

function addDefinition(target: X64SelectedOperand, definedNames: Set<string>): void {
    if (target.kind === "vreg") {
        definedNames.add(target.name);
    }
}

function collectInstructionFlowInfo(instruction: X64SelectedInstruction, usedBeforeDef: Set<string>, definedNames: Set<string>): void {
    switch (instruction.kind) {
        case "copy": {
            addOperandUseNamesBeforeDefinition(instruction.source, usedBeforeDef, definedNames);
            addDefinition(instruction.target, definedNames);
            return;
        }
        case "call_direct": {
            for (const operand of instruction.stackArgs) {
                addOperandUseNamesBeforeDefinition(operand, usedBeforeDef, definedNames);
            }
            return;
        }
        case "call_indirect": {
            addOperandUseNamesBeforeDefinition(instruction.callee, usedBeforeDef, definedNames);
            return;
        }
        case "gc_frame_begin": {
            for (const operand of instruction.gcRootOperands) {
                addOperandUseNamesBeforeDefinition(operand, usedBeforeDef, definedNames);
            }
            return;
        }
        case "gc_frame_end": {
            return;
        }
        case "test": {
            addOperandUseNamesBeforeDefinition(instruction.left, usedBeforeDef, definedNames);
            addOperandUseNamesBeforeDefinition(instruction.right, usedBeforeDef, definedNames);
            return;
        }
        case "pseudo_object_alloc": {
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_object_get_field": {
            addOperandUseNamesBeforeDefinition(instruction.receiver, usedBeforeDef, definedNames);
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_object_set_field": {
            addOperandUseNamesBeforeDefinition(instruction.receiver, usedBeforeDef, definedNames);
            addOperandUseNamesBeforeDefinition(instruction.value, usedBeforeDef, definedNames);
            return;
        }
        case "pseudo_slot_load": {
            addOperandUseNamesBeforeDefinition(instruction.receiver, usedBeforeDef, definedNames);
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_slot_store": {
            addOperandUseNamesBeforeDefinition(instruction.receiver, usedBeforeDef, definedNames);
            addOperandUseNamesBeforeDefinition(instruction.value, usedBeforeDef, definedNames);
            return;
        }
        case "pseudo_union_inject": {
            addOperandUseNamesBeforeDefinition(instruction.value, usedBeforeDef, definedNames);
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_union_has_tag": {
            addOperandUseNamesBeforeDefinition(instruction.unionValue, usedBeforeDef, definedNames);
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_union_get_payload": {
            addOperandUseNamesBeforeDefinition(instruction.unionValue, usedBeforeDef, definedNames);
            definedNames.add(instruction.target.name);
            return;
        }
        case "pseudo_closure_create": {
            for (const capture of instruction.captures) {
                addOperandUseNamesBeforeDefinition(capture, usedBeforeDef, definedNames);
            }
            definedNames.add(instruction.target.name);
            return;
        }
    }
}

function collectTerminatorFlowInfo(terminator: X64SelectedTerminator, usedBeforeDef: Set<string>, definedNames: Set<string>): void {
    switch (terminator.kind) {
        case "ret": {
            return;
        }
        case "jmp": {
            for (const argument of terminator.args) {
                addOperandUseNamesBeforeDefinition(argument, usedBeforeDef, definedNames);
            }
            return;
        }
        case "jcc": {
            for (const argument of terminator.trueArgs) {
                addOperandUseNamesBeforeDefinition(argument, usedBeforeDef, definedNames);
            }
            for (const argument of terminator.falseArgs) {
                addOperandUseNamesBeforeDefinition(argument, usedBeforeDef, definedNames);
            }
            return;
        }
    }
}

function computeBlockLocalFlowInfo(block: X64SelectedBlock): BlockLocalFlowInfo {
    const usedBeforeDef: Set<string> = new Set<string>();
    const definedNames: Set<string> = new Set<string>();
    for (const param of block.params) {
        definedNames.add(param.name);
    }
    for (const instruction of block.instructions) {
        collectInstructionFlowInfo(instruction, usedBeforeDef, definedNames);
    }
    collectTerminatorFlowInfo(block.terminator, usedBeforeDef, definedNames);
    return {
        usedBeforeDef,
        definedNames
    };
}

function blockSuccessorLabels(block: X64SelectedBlock): readonly string[] {
    switch (block.terminator.kind) {
        case "ret": {
            return [];
        }
        case "jmp": {
            return [block.terminator.target];
        }
        case "jcc": {
            return [block.terminator.falseTarget, block.terminator.trueTarget];
        }
    }
}

function orderBlocks(body: X64SelectedBody): readonly X64SelectedBlock[] {
    const blockByLabel: Map<string, X64SelectedBlock> = new Map<string, X64SelectedBlock>();
    for (const block of body.blocks) {
        blockByLabel.set(block.label, block);
    }
    const ordered: X64SelectedBlock[] = [];
    const visited: Set<string> = new Set<string>();

    function visit(label: string): void {
        if (visited.has(label)) {
            return;
        }
        visited.add(label);
        const block: X64SelectedBlock | undefined = blockByLabel.get(label);
        if (!block) {
            return;
        }
        ordered.push(block);
        for (const successorLabel of blockSuccessorLabels(block)) {
            visit(successorLabel);
        }
    }

    visit(body.entryLabel);
    for (const block of body.blocks) {
        visit(block.label);
    }
    return ordered;
}

function translateSuccessorLiveIn(
    successorBlock: X64SelectedBlock,
    successorLiveIn: ReadonlySet<string>,
    edgeArgs: readonly X64SelectedOperand[]
): ReadonlySet<string> {
    const translated: Set<string> = new Set<string>();
    const paramIndexByName: Map<string, number> = new Map<string, number>();
    let paramIndex: number = 0;
    for (const param of successorBlock.params) {
        paramIndexByName.set(param.name, paramIndex);
        paramIndex += 1;
    }
    for (const liveName of successorLiveIn) {
        const mappedIndex: number | undefined = paramIndexByName.get(liveName);
        if (mappedIndex === undefined) {
            translated.add(liveName);
            continue;
        }
        const mappedOperand: X64SelectedOperand | undefined = edgeArgs[mappedIndex];
        if (mappedOperand && mappedOperand.kind === "vreg") {
            translated.add(mappedOperand.name);
        }
    }
    return translated;
}

function collectTranslatedLiveOut(
    block: X64SelectedBlock,
    blockByLabel: ReadonlyMap<string, X64SelectedBlock>,
    liveInByBlock: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlySet<string> {
    const translated: Set<string> = new Set<string>();
    switch (block.terminator.kind) {
        case "ret": {
            return translated;
        }
        case "jmp": {
            const successorBlock: X64SelectedBlock | undefined = blockByLabel.get(block.terminator.target);
            if (!successorBlock) {
                return translated;
            }
            const successorLiveIn: ReadonlySet<string> = liveInByBlock.get(successorBlock.label) ?? new Set<string>();
            for (const liveName of translateSuccessorLiveIn(successorBlock, successorLiveIn, block.terminator.args)) {
                translated.add(liveName);
            }
            return translated;
        }
        case "jcc": {
            const trueBlock: X64SelectedBlock | undefined = blockByLabel.get(block.terminator.trueTarget);
            if (trueBlock) {
                const trueLiveIn: ReadonlySet<string> = liveInByBlock.get(trueBlock.label) ?? new Set<string>();
                for (const liveName of translateSuccessorLiveIn(trueBlock, trueLiveIn, block.terminator.trueArgs)) {
                    translated.add(liveName);
                }
            }
            const falseBlock: X64SelectedBlock | undefined = blockByLabel.get(block.terminator.falseTarget);
            if (falseBlock) {
                const falseLiveIn: ReadonlySet<string> = liveInByBlock.get(falseBlock.label) ?? new Set<string>();
                for (const liveName of translateSuccessorLiveIn(falseBlock, falseLiveIn, block.terminator.falseArgs)) {
                    translated.add(liveName);
                }
            }
            return translated;
        }
    }
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) {
        return false;
    }
    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }
    return true;
}

function computeBlockSummaries(body: X64SelectedBody): readonly X64LivenessBlockSummary[] {
    const orderedBlocks: readonly X64SelectedBlock[] = orderBlocks(body);
    const reversedBlocks: readonly X64SelectedBlock[] = [...orderedBlocks].reverse();
    const blockByLabel: Map<string, X64SelectedBlock> = new Map<string, X64SelectedBlock>();
    const localFlowInfoByLabel: Map<string, BlockLocalFlowInfo> = new Map<string, BlockLocalFlowInfo>();
    const liveInByBlock: Map<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>();
    const liveOutByBlock: Map<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>();

    for (const block of body.blocks) {
        blockByLabel.set(block.label, block);
        localFlowInfoByLabel.set(block.label, computeBlockLocalFlowInfo(block));
        liveInByBlock.set(block.label, new Set<string>());
        liveOutByBlock.set(block.label, new Set<string>());
    }

    let changed: boolean = true;
    while (changed) {
        changed = false;
        for (const block of reversedBlocks) {
            const localFlowInfo: BlockLocalFlowInfo | undefined = localFlowInfoByLabel.get(block.label);
            if (!localFlowInfo) {
                continue;
            }
            const translatedLiveOut: ReadonlySet<string> = collectTranslatedLiveOut(block, blockByLabel, liveInByBlock);
            const nextLiveIn: Set<string> = new Set<string>();
            for (const name of localFlowInfo.usedBeforeDef) {
                nextLiveIn.add(name);
            }
            for (const name of translatedLiveOut) {
                if (!localFlowInfo.definedNames.has(name)) {
                    nextLiveIn.add(name);
                }
            }
            const previousLiveIn: ReadonlySet<string> = liveInByBlock.get(block.label) ?? new Set<string>();
            const previousLiveOut: ReadonlySet<string> = liveOutByBlock.get(block.label) ?? new Set<string>();
            if (!setsEqual(previousLiveIn, nextLiveIn)) {
                liveInByBlock.set(block.label, nextLiveIn);
                changed = true;
            }
            if (!setsEqual(previousLiveOut, translatedLiveOut)) {
                liveOutByBlock.set(block.label, translatedLiveOut);
                changed = true;
            }
        }
    }

    const summaries: X64LivenessBlockSummary[] = [];
    for (const block of body.blocks) {
        const liveInNames: string[] = [...(liveInByBlock.get(block.label) ?? new Set<string>())].sort((left: string, right: string) => left.localeCompare(right));
        const liveOutNames: string[] = [...(liveOutByBlock.get(block.label) ?? new Set<string>())].sort((left: string, right: string) => left.localeCompare(right));
        summaries.push({
            label: block.label,
            liveIn: liveInNames,
            liveOut: liveOutNames
        });
    }
    return summaries;
}

function recordUsePosition(
    operand: X64SelectedOperand,
    banks: Map<string, X64MirRegisterBank>,
    position: number,
    positions: Map<string, PositionRange>
): void {
    if (operand.kind !== "vreg") {
        return;
    }
    banks.set(operand.name, operand.bank);
    const existing: PositionRange | undefined = positions.get(operand.name);
    if (!existing) {
        positions.set(operand.name, { start: position, end: position });
        return;
    }
    existing.start = Math.min(existing.start, position);
    existing.end = Math.max(existing.end, position);
}

function recordDefinitionPosition(
    target: X64SelectedOperand,
    banks: Map<string, X64MirRegisterBank>,
    position: number,
    positions: Map<string, PositionRange>
): void {
    if (target.kind !== "vreg") {
        return;
    }
    banks.set(target.name, target.bank);
    const existing: PositionRange | undefined = positions.get(target.name);
    if (!existing) {
        positions.set(target.name, { start: position, end: position });
        return;
    }
    existing.start = Math.min(existing.start, position);
    existing.end = Math.max(existing.end, position);
}

function analyzeInstructionPositions(
    instruction: X64SelectedInstruction,
    banks: Map<string, X64MirRegisterBank>,
    position: number,
    positions: Map<string, PositionRange>,
    callPositions: number[]
): void {
    switch (instruction.kind) {
        case "copy": {
            recordUsePosition(instruction.source, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "call_direct": {
            callPositions.push(position);
            for (const operand of instruction.stackArgs) {
                recordUsePosition(operand, banks, position, positions);
            }
            return;
        }
        case "call_indirect": {
            callPositions.push(position);
            recordUsePosition(instruction.callee, banks, position, positions);
            return;
        }
        case "gc_frame_begin": {
            callPositions.push(position);
            for (const operand of instruction.gcRootOperands) {
                recordUsePosition(operand, banks, position, positions);
            }
            return;
        }
        case "gc_frame_end": {
            return;
        }
        case "test": {
            recordUsePosition(instruction.left, banks, position, positions);
            recordUsePosition(instruction.right, banks, position, positions);
            return;
        }
        case "pseudo_object_alloc": {
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_object_get_field": {
            recordUsePosition(instruction.receiver, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_object_set_field": {
            recordUsePosition(instruction.receiver, banks, position, positions);
            recordUsePosition(instruction.value, banks, position, positions);
            return;
        }
        case "pseudo_slot_load": {
            recordUsePosition(instruction.receiver, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_slot_store": {
            recordUsePosition(instruction.receiver, banks, position, positions);
            recordUsePosition(instruction.value, banks, position, positions);
            return;
        }
        case "pseudo_union_inject": {
            recordUsePosition(instruction.value, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_union_has_tag": {
            recordUsePosition(instruction.unionValue, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_union_get_payload": {
            recordUsePosition(instruction.unionValue, banks, position, positions);
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
        case "pseudo_closure_create": {
            for (const capture of instruction.captures) {
                recordUsePosition(capture, banks, position, positions);
            }
            recordDefinitionPosition(instruction.target, banks, position, positions);
            return;
        }
    }
}

function analyzeTerminatorPositions(
    terminator: X64SelectedTerminator,
    banks: Map<string, X64MirRegisterBank>,
    position: number,
    positions: Map<string, PositionRange>
): void {
    switch (terminator.kind) {
        case "ret": {
            return;
        }
        case "jmp": {
            for (const argument of terminator.args) {
                recordUsePosition(argument, banks, position, positions);
            }
            return;
        }
        case "jcc": {
            for (const argument of terminator.trueArgs) {
                recordUsePosition(argument, banks, position, positions);
            }
            for (const argument of terminator.falseArgs) {
                recordUsePosition(argument, banks, position, positions);
            }
            return;
        }
    }
}

function flattenBody(body: X64SelectedBody): FlatBodyAnalysis {
    const positions: Map<string, PositionRange> = new Map<string, PositionRange>();
    const banks: Map<string, X64MirRegisterBank> = new Map<string, X64MirRegisterBank>();
    const callPositions: number[] = [];
    let position: number = 0;
    for (const block of orderBlocks(body)) {
        for (const param of block.params) {
            banks.set(param.name, param.bank);
            const existing: PositionRange | undefined = positions.get(param.name);
            if (!existing) {
                positions.set(param.name, { start: position, end: position });
            }
        }
        for (const instruction of block.instructions) {
            position += 1;
            analyzeInstructionPositions(instruction, banks, position, positions, callPositions);
        }
        position += 1;
        analyzeTerminatorPositions(block.terminator, banks, position, positions);
    }
    return {
        positions,
        banks,
        callPositions
    };
}

function buildIntervals(body: X64SelectedBody): { readonly callPositions: readonly number[]; readonly intervals: readonly X64LivenessInterval[] } {
    const flatBodyAnalysis: FlatBodyAnalysis = flattenBody(body);
    const blockParamNames: Set<string> = new Set<string>();
    for (const block of body.blocks) {
        for (const param of block.params) {
            blockParamNames.add(param.name);
        }
    }
    const intervals: X64LivenessInterval[] = [];
    for (const [name, range] of flatBodyAnalysis.positions.entries()) {
        const bank: X64MirRegisterBank = flatBodyAnalysis.banks.get(name) ?? "gpr";
        const crossesCall: boolean = flatBodyAnalysis.callPositions.some((position: number) => position > range.start && position < range.end);
        intervals.push({
            name,
            bank,
            start: range.start,
            end: range.end,
            crossesCall,
            mustSpill: blockParamNames.has(name) || crossesCall
        });
    }
    intervals.sort((left: X64LivenessInterval, right: X64LivenessInterval) => {
        if (left.start !== right.start) {
            return left.start - right.start;
        }
        if (left.end !== right.end) {
            return left.end - right.end;
        }
        return left.name.localeCompare(right.name);
    });
    return {
        callPositions: [...flatBodyAnalysis.callPositions],
        intervals
    };
}

function analyzeBody(body: X64SelectedBody): X64LivenessBody {
    const intervalAnalysis: { readonly callPositions: readonly number[]; readonly intervals: readonly X64LivenessInterval[] } = buildIntervals(body);
    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        blocks: body.blocks,
        blockSummaries: computeBlockSummaries(body),
        callPositions: intervalAnalysis.callPositions,
        intervals: intervalAnalysis.intervals
    };
}

function analyzeFunction(fn: X64SelectedFunctionDefinition): X64LivenessFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: analyzeBody(fn.body),
        origin: fn.origin
    };
}

export function livenessAnalysisX64Pass(program: X64CopyPropagatedProgram): X64LivenessProgram {
    return {
        kind: "x64_liveness_program",
        entry: analyzeBody(program.entry),
        globals: program.globals,
        functions: program.functions.map((fn: X64SelectedFunctionDefinition) => analyzeFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}