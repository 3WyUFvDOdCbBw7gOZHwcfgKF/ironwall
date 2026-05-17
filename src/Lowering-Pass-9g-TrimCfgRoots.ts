import type {
    CfgTrimmedRootCandidateBlock,
    CfgTrimmedRootCandidateBody,
    CfgTrimmedRootCandidateProgram,
    CfgTrimmedRootCandidateStatement,
    MayCollectProgram,
    RepresentationSelectionBody,
    RepresentationSelectionProgram
} from "./backend-linux/Backend-Linux-IR-Shared";
import type {
    CfgBody,
    CfgProgram,
    CfgStatement,
    CfgTerminator,
    LinearOperand,
    LinearRvalue,
} from "./Lowering-Frontend-Shared";
import { isGcCollectLikeSymbol } from "./DeclaredCFunctionName";

function isGcCollectSymbol(symbol: string): boolean {
    return isGcCollectLikeSymbol(symbol);
}

function collectOperandReads(operand: LinearOperand): ReadonlySet<string> {
    return operand.kind === "local" ? new Set([operand.name]) : new Set();
}

function collectReadsFromOperands(operands: readonly LinearOperand[]): ReadonlySet<string> {
    const reads = new Set<string>();
    operands.forEach((operand) => collectOperandReads(operand).forEach((name) => reads.add(name)));
    return reads;
}

function collectRvalueReads(rvalue: LinearRvalue): ReadonlySet<string> {
    switch (rvalue.kind) {
        case "copy":
            return collectOperandReads(rvalue.value);
        case "object_alloc":
            return new Set();
        case "object_get_field":
        case "slot_load":
            return collectOperandReads(rvalue.receiver);
        case "union_inject":
            return collectOperandReads(rvalue.value);
        case "union_has_tag":
        case "union_get_payload":
            return collectOperandReads(rvalue.unionValue);
        case "closure_create":
            return collectReadsFromOperands(rvalue.captures);
        case "direct_call":
            return collectReadsFromOperands(rvalue.args);
        case "closure_call": {
            const reads = new Set<string>(collectOperandReads(rvalue.callee));
            rvalue.args.forEach((arg) => collectOperandReads(arg).forEach((name) => reads.add(name)));
            return reads;
        }
    }
}

function collectStatementUses(statement: CfgStatement): ReadonlySet<string> {
    switch (statement.kind) {
        case "assign":
            return collectRvalueReads(statement.value);
        case "set_local":
            return collectOperandReads(statement.value);
        case "object_set_field":
        case "slot_store":
            return collectReadsFromOperands([statement.receiver, statement.value]);
    }
}

function collectStatementDefs(statement: CfgStatement): ReadonlySet<string> {
    switch (statement.kind) {
        case "assign":
        case "set_local":
            return new Set([statement.target]);
        case "object_set_field":
        case "slot_store":
            return new Set();
    }
}

function collectTerminatorUses(terminator: CfgTerminator): ReadonlySet<string> {
    switch (terminator.kind) {
        case "return":
            return collectOperandReads(terminator.value);
        case "jump":
            return new Set();
        case "branch":
            return collectOperandReads(terminator.cond);
    }
}

function successorLabels(terminator: CfgTerminator): readonly string[] {
    switch (terminator.kind) {
        case "return":
            return [];
        case "jump":
            return [terminator.target];
        case "branch":
            return [terminator.trueTarget, terminator.falseTarget];
    }
}

function unionInto(target: Set<string>, source: ReadonlySet<string>): void {
    source.forEach((value) => target.add(value));
}

function subtractSet(values: ReadonlySet<string>, removed: ReadonlySet<string>): Set<string> {
    const result = new Set<string>();
    values.forEach((value) => {
        if (!removed.has(value)) {
            result.add(value);
        }
    });
    return result;
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

function sortRoots(liveSet: ReadonlySet<string>, rootCandidates: ReadonlySet<string>, params: ReadonlySet<string>, locals: readonly string[]): readonly string[] {
    const localSet = new Set(locals);
    return Array.from(liveSet)
        .filter((name) => rootCandidates.has(name))
        .sort((left, right) => {
            const leftParam = params.has(left);
            const rightParam = params.has(right);
            if (leftParam !== rightParam) {
                return leftParam ? -1 : 1;
            }
            const leftLocal = localSet.has(left);
            const rightLocal = localSet.has(right);
            if (leftLocal !== rightLocal) {
                return leftLocal ? 1 : -1;
            }
            return left.localeCompare(right);
        });
}

function statementMayCollect(statement: CfgStatement, functionMayCollect: ReadonlyMap<string, boolean>): boolean {
    if (statement.kind !== "assign") {
        return false;
    }
    if (statement.value.kind === "closure_call") {
        return true;
    }
    if (statement.value.kind !== "direct_call") {
        return false;
    }
    if (isGcCollectSymbol(statement.value.symbol)) {
        return true;
    }
    return functionMayCollect.get(statement.value.symbol) ?? false;
}

function isConservativeGcCollect(statement: CfgStatement): boolean {
    return statement.kind === "assign"
        && statement.value.kind === "direct_call"
    && isGcCollectSymbol(statement.value.symbol);
}

function buildPredecessorMap(body: CfgBody): Map<string, string[]> {
    const predecessors = new Map<string, string[]>();
    for (const block of body.blocks) {
        predecessors.set(block.label, []);
    }
    for (const block of body.blocks) {
        for (const successor of successorLabels(block.terminator)) {
            predecessors.get(successor)?.push(block.label);
        }
    }
    return predecessors;
}

function trimCfgBodyRoots(
    params: readonly { readonly name: string; readonly typeExp: import("./AstNode").AstNode; }[],
    body: CfgBody,
    selection: RepresentationSelectionBody,
    functionMayCollect: ReadonlyMap<string, boolean>
): CfgTrimmedRootCandidateBody {
    const rootCandidates = new Set<string>(
        Array.from(selection.bindingRepresentations.entries())
            .filter(([, representation]) => representation === "reference")
            .map(([name]) => name)
    );
    const gcRootNames = Array.from(new Set([
        ...params.map((param) => param.name).filter((name) => rootCandidates.has(name)),
        ...body.locals.filter((name) => rootCandidates.has(name)).sort((left, right) => left.localeCompare(right))
    ]));
    const paramNames = new Set(params.map((param) => param.name));
    const predecessorMap = buildPredecessorMap(body);
    const liveInMap = new Map<string, Set<string>>();
    const liveOutMap = new Map<string, Set<string>>();

    for (const block of body.blocks) {
        liveInMap.set(block.label, new Set());
        liveOutMap.set(block.label, new Set());
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (let index = body.blocks.length - 1; index >= 0; index -= 1) {
            const block = body.blocks[index];
            const nextLiveOut = new Set<string>();
            for (const successor of successorLabels(block.terminator)) {
                unionInto(nextLiveOut, liveInMap.get(successor) ?? new Set());
            }

            let live = new Set(nextLiveOut);
            unionInto(live, collectTerminatorUses(block.terminator));
            for (let statementIndex = block.statements.length - 1; statementIndex >= 0; statementIndex -= 1) {
                const statement = block.statements[statementIndex];
                live = subtractSet(live, collectStatementDefs(statement));
                unionInto(live, collectStatementUses(statement));
            }

            if (!setsEqual(nextLiveOut, liveOutMap.get(block.label) ?? new Set())) {
                liveOutMap.set(block.label, nextLiveOut);
                changed = true;
            }
            if (!setsEqual(live, liveInMap.get(block.label) ?? new Set())) {
                liveInMap.set(block.label, live);
                changed = true;
            }
        }
    }

    const blocks: CfgTrimmedRootCandidateBlock[] = body.blocks.map((block) => {
        let currentLiveAfter = new Set<string>(liveOutMap.get(block.label) ?? new Set());
        unionInto(currentLiveAfter, collectTerminatorUses(block.terminator));
        const statementRoots: CfgTrimmedRootCandidateStatement[] = block.statements.map(() => ({
            kind: "assign" as const,
            gcRoots: [] as readonly string[],
            mayCollect: false
        }));

        for (let index = block.statements.length - 1; index >= 0; index -= 1) {
            const statement = block.statements[index];
            const liveBefore = subtractSet(currentLiveAfter, collectStatementDefs(statement));
            unionInto(liveBefore, collectStatementUses(statement));
            const mayCollect = statementMayCollect(statement, functionMayCollect);
            statementRoots[index] = {
                kind: statement.kind,
                gcRoots: !mayCollect
                    ? []
                    : isConservativeGcCollect(statement)
                        ? sortRoots(rootCandidates, rootCandidates, paramNames, body.locals)
                        : sortRoots(liveBefore, rootCandidates, paramNames, body.locals),
                mayCollect
            };
            currentLiveAfter = liveBefore;
        }

        return {
            label: block.label,
            predecessors: predecessorMap.get(block.label) ?? [],
            liveIn: sortRoots(liveInMap.get(block.label) ?? new Set(), rootCandidates, paramNames, body.locals),
            liveOut: sortRoots(liveOutMap.get(block.label) ?? new Set(), rootCandidates, paramNames, body.locals),
            terminatorRoots: sortRoots(liveOutMap.get(block.label) ?? new Set(), rootCandidates, paramNames, body.locals),
            statementRoots
        };
    });

    const returnRoots = new Set<string>();
    for (const block of body.blocks) {
        if (block.terminator.kind !== "return") {
            continue;
        }
        sortRoots(collectTerminatorUses(block.terminator), rootCandidates, paramNames, body.locals)
            .forEach((name) => returnRoots.add(name));
    }

    return {
        gcRootNames,
        returnRoots: sortRoots(returnRoots, rootCandidates, paramNames, body.locals),
        blocks
    };
}

export function trimCfgRootCandidatesPass(
    program: CfgProgram,
    selection: RepresentationSelectionProgram,
    mayCollect: MayCollectProgram
): CfgTrimmedRootCandidateProgram {
    const selectionByFunction = new Map(selection.functions.map((fn) => [fn.symbol, fn.body] as const));
    const mayCollectByFunction = new Map(mayCollect.functions.map((fn) => [fn.symbol, fn.body.mayCollect] as const));
    return {
        kind: "cfg_trimmed_root_candidate_program",
        entry: trimCfgBodyRoots(program.metadata.entryParams, program.entry, selection.entry, mayCollectByFunction),
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            body: trimCfgBodyRoots(
                fn.params,
                fn.body,
                selectionByFunction.get(fn.symbol) ?? { bindingRepresentations: new Map(), resultRepresentation: "reference" },
                mayCollectByFunction
            )
        }))
    };
}
