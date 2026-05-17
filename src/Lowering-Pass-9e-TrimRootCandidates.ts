import type {
    MayCollectBody,
    MayCollectProgram,
    MayCollectStatement,
    RepresentationSelectionBody,
    RepresentationSelectionProgram,
    TrimmedRootCandidateBody,
    TrimmedRootCandidateProgram,
    TrimmedRootCandidateStatement
} from "./backend-linux/Backend-Linux-IR-Shared";
import type {
    LinearBody,
    LinearOperand,
    LinearRvalue,
    LinearStatement,
    LinearizedProgram,
} from "./Lowering-Frontend-Shared";
import { isGcCollectLikeSymbol } from "./DeclaredCFunctionName";

interface PlannedStatements {
    readonly liveBefore: ReadonlySet<string>;
    readonly statementRoots: readonly TrimmedRootCandidateStatement[];
}

function operandHasSafepoint(_operand: LinearOperand): boolean {
    return false;
}

function collectOperandReads(operand: LinearOperand): ReadonlySet<string> {
    return operand.kind === "local" ? new Set([operand.name]) : new Set();
}

function rvalueHasSafepoint(rvalue: LinearRvalue, mayCollect: boolean): boolean {
    switch (rvalue.kind) {
        case "copy":
            return operandHasSafepoint(rvalue.value);
        case "object_alloc":
        case "union_inject":
        case "closure_create":
            return false;
        case "direct_call":
        case "closure_call":
            return mayCollect;
        case "object_get_field":
        case "slot_load":
            return operandHasSafepoint(rvalue.receiver);
        case "union_has_tag":
        case "union_get_payload":
            return operandHasSafepoint(rvalue.unionValue);
    }
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

function collectReadsFromOperands(operands: readonly LinearOperand[]): ReadonlySet<string> {
    const reads = new Set<string>();
    operands.forEach((operand) => collectOperandReads(operand).forEach((name) => reads.add(name)));
    return reads;
}

function collectUses(statement: LinearStatement): ReadonlySet<string> {
    switch (statement.kind) {
        case "assign":
            return collectRvalueReads(statement.value);
        case "set_local":
            return collectOperandReads(statement.value);
        case "object_set_field":
        case "slot_store":
            return collectReadsFromOperands([statement.receiver, statement.value]);
        case "if":
        case "while":
            return collectOperandReads(statement.cond);
    }
}

function collectDefs(statement: LinearStatement): ReadonlySet<string> {
    switch (statement.kind) {
        case "assign":
        case "set_local":
            return new Set([statement.target]);
        case "object_set_field":
        case "slot_store":
        case "if":
        case "while":
            return new Set();
    }
}

function statementHasSafepoint(statement: LinearStatement, annotation: MayCollectStatement): boolean {
    if (statement.kind !== annotation.kind) {
        throw new Error(`Pass 9e root trimming failed: may-collect annotation mismatch for '${statement.kind}'`);
    }
    switch (statement.kind) {
        case "assign":
            return rvalueHasSafepoint(statement.value, annotation.mayCollect);
        case "set_local":
            return operandHasSafepoint(statement.value);
        case "object_set_field":
        case "slot_store":
            return operandHasSafepoint(statement.receiver) || operandHasSafepoint(statement.value);
        case "if":
        case "while":
            return annotation.mayCollect || operandHasSafepoint(statement.cond);
    }
}

function isConservativeGcCollect(statement: LinearStatement): boolean {
    return statement.kind === "assign"
        && statement.value.kind === "direct_call"
        && isGcCollectLikeSymbol(statement.value.symbol);
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

function unionInto(target: Set<string>, source: ReadonlySet<string>): void {
    source.forEach((value) => target.add(value));
}

function sortGcRoots(liveSet: ReadonlySet<string>, rootCandidates: ReadonlySet<string>, params: ReadonlySet<string>, locals: readonly string[]): readonly string[] {
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

function planStatementSequence(
    statements: readonly LinearStatement[],
    annotations: readonly MayCollectStatement[],
    liveAfter: ReadonlySet<string>,
    rootCandidates: ReadonlySet<string>,
    params: ReadonlySet<string>,
    locals: readonly string[]
): PlannedStatements {
    if (statements.length !== annotations.length) {
        throw new Error(`Pass 9e root trimming failed: statement/annotation length mismatch, expected ${statements.length}, got ${annotations.length}`);
    }

    const statementRoots: TrimmedRootCandidateStatement[] = [];
    let currentLiveAfter = new Set(liveAfter);

    for (let index = statements.length - 1; index >= 0; index -= 1) {
        const statement = statements[index];
        const annotation = annotations[index];

        if (statement.kind === "if") {
            if (annotation.kind !== "if") {
                throw new Error("Pass 9e root trimming failed: expected if annotation");
            }
            const thenPlan = planStatementSequence(statement.thenStatements, annotation.thenStatements, currentLiveAfter, rootCandidates, params, locals);
            const elsePlan = planStatementSequence(statement.elseStatements, annotation.elseStatements, currentLiveAfter, rootCandidates, params, locals);
            const liveBefore = new Set<string>(thenPlan.liveBefore);
            unionInto(liveBefore, elsePlan.liveBefore);
            unionInto(liveBefore, collectUses(statement));
            statementRoots.unshift({
                kind: "if",
                gcRoots: annotation.mayCollect ? sortGcRoots(liveBefore, rootCandidates, params, locals) : [],
                thenStatements: thenPlan.statementRoots,
                elseStatements: elsePlan.statementRoots
            });
            currentLiveAfter = liveBefore;
            continue;
        }

        if (statement.kind === "while") {
            if (annotation.kind !== "while") {
                throw new Error("Pass 9e root trimming failed: expected while annotation");
            }
            const condPlan = planStatementSequence(statement.condStatements, annotation.condStatements, currentLiveAfter, rootCandidates, params, locals);
            const bodyPlan = planStatementSequence(statement.bodyStatements, annotation.bodyStatements, condPlan.liveBefore, rootCandidates, params, locals);
            const liveBefore = new Set<string>(currentLiveAfter);
            unionInto(liveBefore, condPlan.liveBefore);
            unionInto(liveBefore, bodyPlan.liveBefore);
            unionInto(liveBefore, collectUses(statement));
            statementRoots.unshift({
                kind: "while",
                gcRoots: annotation.mayCollect ? sortGcRoots(liveBefore, rootCandidates, params, locals) : [],
                condStatements: condPlan.statementRoots,
                bodyStatements: bodyPlan.statementRoots
            });
            currentLiveAfter = liveBefore;
            continue;
        }

        const liveBefore = subtractSet(currentLiveAfter, collectDefs(statement));
        unionInto(liveBefore, collectUses(statement));
        const gcRoots = !statementHasSafepoint(statement, annotation)
            ? []
            : isConservativeGcCollect(statement)
                ? sortGcRoots(rootCandidates, rootCandidates, params, locals)
                : sortGcRoots(liveBefore, rootCandidates, params, locals);
        statementRoots.unshift({
            kind: statement.kind,
            gcRoots
        } as TrimmedRootCandidateStatement);
        currentLiveAfter = liveBefore;
    }

    return {
        liveBefore: currentLiveAfter,
        statementRoots
    };
}

function trimBodyRoots(
    params: readonly { readonly name: string; readonly typeExp: import("./AstNode").AstNode; }[],
    body: LinearBody,
    selection: RepresentationSelectionBody,
    mayCollectBody: MayCollectBody
): TrimmedRootCandidateBody {
    const possibleRoots = new Set<string>(
        Array.from(selection.bindingRepresentations.entries())
            .filter(([, representation]) => representation === "reference")
            .map(([name]) => name)
    );
    const gcRootNames = Array.from(new Set([
        ...params.map((param) => param.name).filter((name) => possibleRoots.has(name)),
        ...body.locals.filter((name) => possibleRoots.has(name)).sort((left, right) => left.localeCompare(right))
    ]));
    const paramNames = new Set(params.map((param) => param.name));
    const statementPlan = planStatementSequence(body.statements, mayCollectBody.statementAnnotations, collectOperandReads(body.result), new Set(gcRootNames), paramNames, body.locals);
    return {
        gcRootNames,
        statementRoots: statementPlan.statementRoots,
        resultGcRoots: operandHasSafepoint(body.result)
            ? sortGcRoots(statementPlan.liveBefore, new Set(gcRootNames), paramNames, body.locals)
            : []
    };
}

export function trimRootCandidatesPass(program: LinearizedProgram, selection: RepresentationSelectionProgram, mayCollect: MayCollectProgram): TrimmedRootCandidateProgram {
    const selectionByFunction = new Map(selection.functions.map((fn) => [fn.symbol, fn.body] as const));
    const mayCollectByFunction = new Map(mayCollect.functions.map((fn) => [fn.symbol, fn.body] as const));
    return {
        kind: "trimmed_root_candidate_program",
        entry: trimBodyRoots(program.metadata.entryParams, program.topLevelBody, selection.entry, mayCollect.entry),
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            body: trimBodyRoots(
                fn.params,
                fn.body,
                selectionByFunction.get(fn.symbol) ?? { bindingRepresentations: new Map(), resultRepresentation: "reference" },
                mayCollectByFunction.get(fn.symbol) ?? { mayCollect: false, statementAnnotations: [] }
            )
        }))
    };
}
