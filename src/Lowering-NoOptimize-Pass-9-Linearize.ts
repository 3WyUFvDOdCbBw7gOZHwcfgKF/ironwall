// No-opt lowering pass 9 linearization.
import type {
    ClosureConvertedFunctionDefinition,
    ClosureExpr,
    FoldedTypedPrimitiveProgram,
    LinearBody,
    LinearOperand,
    LinearStatement,
    LinearizedFunctionDefinition,
    LinearizedProgram,
    ScalarReplacedFreshProgram,
    TypedSlotProgram
} from "./Lowering-Frontend-Shared";

interface LinearizeState {
    tempCounter: number;
    locals: Set<string>;
}

function cloneState(state: LinearizeState): LinearizeState {
    return {
        tempCounter: state.tempCounter,
        locals: new Set(state.locals)
    };
}

function nextLinearTemp(state: LinearizeState): string {
    const current = state.tempCounter;
    state.tempCounter += 1;
    const name = `__iw_linear_${current}`;
    state.locals.add(name);
    return name;
}

function operandFromAtomicExpr(expr: ClosureExpr): LinearOperand {
    switch (expr.kind) {
        case "identifier":
            return { kind: "local", name: expr.name };
        case "number_literal":
            return { kind: "number_literal", value: expr.value, typeName: expr.typeName };
        case "text_literal":
            return {
                kind: "text_literal",
                typeName: expr.typeName,
                referenceName: expr.referenceName,
                content: expr.content
            };
        case "direct_function_ref":
            return { kind: "direct_function", symbol: expr.symbol };
        default:
            throw new Error(`Pass 9 linearization failed: expected atomic closure expr, got '${expr.kind}'`);
    }
}

function assignCopy(target: string, value: LinearOperand): LinearStatement {
    return {
        kind: "assign",
        target,
        value: {
            kind: "copy",
            value
        }
    };
}

function unitOperand(): LinearOperand {
    return { kind: "number_literal", value: 0, typeName: "i5" };
}

function linearizeExpr(expr: ClosureExpr, state: LinearizeState): { readonly statements: LinearStatement[]; readonly result: LinearOperand } {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return {
                statements: [],
                result: operandFromAtomicExpr(expr)
            };
        case "object_alloc": {
            const target = nextLinearTemp(state);
            return {
                statements: [{ kind: "assign", target, value: { kind: "object_alloc", className: expr.className } }],
                result: { kind: "local", name: target }
            };
        }
        case "let": {
            const statements: LinearStatement[] = [];
            for (const binding of expr.bindings) {
                state.locals.add(binding.bind.name);
                const bindingResult = linearizeExpr(binding.value, state);
                statements.push(...bindingResult.statements, assignCopy(binding.bind.name, bindingResult.result));
            }
            const bodyResult = linearizeExpr(expr.body, state);
            return {
                statements: [...statements, ...bodyResult.statements],
                result: bodyResult.result
            };
        }
        case "if": {
            const condResult = linearizeExpr(expr.condExpr, state);
            const target = nextLinearTemp(state);
            const thenState = cloneState(state);
            const thenResult = linearizeExpr(expr.trueBranchExpr, thenState);
            const elseState = cloneState(thenState);
            const elseResult = linearizeExpr(expr.falseBranchExpr, elseState);
            state.tempCounter = Math.max(state.tempCounter, thenState.tempCounter, elseState.tempCounter);
            thenState.locals.forEach((name) => state.locals.add(name));
            elseState.locals.forEach((name) => state.locals.add(name));
            const thenStatements = [...thenResult.statements, assignCopy(target, thenResult.result)];
            const elseStatements = [...elseResult.statements, assignCopy(target, elseResult.result)];
            return {
                statements: [...condResult.statements, { kind: "if", cond: condResult.result, thenStatements, elseStatements }],
                result: { kind: "local", name: target }
            };
        }
        case "while": {
            const condState = cloneState(state);
            const condResult = linearizeExpr(expr.condExpr, condState);
            const bodyState = cloneState(condState);
            const bodyResult = linearizeExpr(expr.bodyExpr, bodyState);
            state.tempCounter = Math.max(state.tempCounter, condState.tempCounter, bodyState.tempCounter);
            condState.locals.forEach((name) => state.locals.add(name));
            bodyState.locals.forEach((name) => state.locals.add(name));
            return {
                statements: [{
                    kind: "while",
                    condStatements: condResult.statements,
                    cond: condResult.result,
                    bodyStatements: bodyResult.statements
                }],
                result: unitOperand()
            };
        }
        case "seq": {
            const statements: LinearStatement[] = [];
            let result: LinearOperand = unitOperand();
            for (const inner of expr.expressions) {
                const innerResult = linearizeExpr(inner, state);
                statements.push(...innerResult.statements);
                result = innerResult.result;
            }
            return { statements, result };
        }
        case "set_local": {
            const valueResult = linearizeExpr(expr.value, state);
            return {
                statements: [...valueResult.statements, { kind: "set_local", target: expr.identifier, value: valueResult.result }],
                result: unitOperand()
            };
        }
        case "direct_call": {
            const statements: LinearStatement[] = [];
            const args: LinearOperand[] = [];
            for (const arg of expr.args) {
                const argResult = linearizeExpr(arg, state);
                statements.push(...argResult.statements);
                args.push(argResult.result);
            }
            const target = nextLinearTemp(state);
            statements.push({ kind: "assign", target, value: { kind: "direct_call", symbol: expr.symbol, args } });
            return { statements, result: { kind: "local", name: target } };
        }
        case "object_get_field": {
            const receiverResult = linearizeExpr(expr.receiver, state);
            const target = nextLinearTemp(state);
            return {
                statements: [...receiverResult.statements, { kind: "assign", target, value: { kind: "object_get_field", receiver: receiverResult.result, className: expr.className, fieldName: expr.fieldName } }],
                result: { kind: "local", name: target }
            };
        }
        case "slot_load": {
            const receiverResult = linearizeExpr(expr.receiver, state);
            const target = nextLinearTemp(state);
            return {
                statements: [...receiverResult.statements, { kind: "assign", target, value: { kind: "slot_load", receiver: receiverResult.result, className: expr.className, slotName: expr.slotName } }],
                result: { kind: "local", name: target }
            };
        }
        case "union_inject": {
            const valueResult = linearizeExpr(expr.value, state);
            const target = nextLinearTemp(state);
            return {
                statements: [...valueResult.statements, {
                    kind: "assign",
                    target,
                    value: {
                        kind: "union_inject",
                        unionTypeTagId: expr.unionTypeTagId,
                        memberTypeTagId: expr.memberTypeTagId,
                        value: valueResult.result
                    }
                }],
                result: { kind: "local", name: target }
            };
        }
        case "object_set_field": {
            const receiverResult = linearizeExpr(expr.receiver, state);
            const valueResult = linearizeExpr(expr.value, state);
            return {
                statements: [...receiverResult.statements, ...valueResult.statements, { kind: "object_set_field", receiver: receiverResult.result, className: expr.className, fieldName: expr.fieldName, value: valueResult.result }],
                result: unitOperand()
            };
        }
        case "slot_store": {
            const receiverResult = linearizeExpr(expr.receiver, state);
            const valueResult = linearizeExpr(expr.value, state);
            return {
                statements: [...receiverResult.statements, ...valueResult.statements, { kind: "slot_store", receiver: receiverResult.result, className: expr.className, slotName: expr.slotName, value: valueResult.result }],
                result: unitOperand()
            };
        }
        case "closure_create": {
            const statements: LinearStatement[] = [];
            const captures: LinearOperand[] = [];
            for (const capture of expr.captures) {
                const captureResult = linearizeExpr(capture, state);
                statements.push(...captureResult.statements);
                captures.push(captureResult.result);
            }
            const target = nextLinearTemp(state);
            statements.push({
                kind: "assign",
                target,
                value: {
                    kind: "closure_create",
                    closureId: expr.closureId,
                    applySymbol: expr.applySymbol,
                    environmentLayout: expr.environmentLayout,
                    captures
                }
            });
            return { statements, result: { kind: "local", name: target } };
        }
        case "closure_call": {
            const calleeResult = linearizeExpr(expr.callee, state);
            const statements = [...calleeResult.statements];
            const args: LinearOperand[] = [];
            for (const arg of expr.args) {
                const argResult = linearizeExpr(arg, state);
                statements.push(...argResult.statements);
                args.push(argResult.result);
            }
            const target = nextLinearTemp(state);
            statements.push({ kind: "assign", target, value: { kind: "closure_call", callee: calleeResult.result, args } });
            return { statements, result: { kind: "local", name: target } };
        }
        case "match": {
            const unionResult = linearizeExpr(expr.unionExpr, state);
            const resultTarget = nextLinearTemp(state);
            const buildBranch = (branchIndex: number): LinearStatement[] => {
                const branch = expr.branches[branchIndex];
                if (!branch) {
                    throw new Error("Pass 9 linearization failed: match must contain at least one branch");
                }
                const condTarget = nextLinearTemp(state);
                const branchState = cloneState(state);
                branchState.locals.add(branch.bind.name);
                const payloadAssign: LinearStatement = {
                    kind: "assign",
                    target: branch.bind.name,
                    value: {
                        kind: "union_get_payload",
                        unionValue: unionResult.result,
                        unionTypeTagId: expr.unionTypeTagId,
                        memberTypeTagId: branch.memberTypeTagId
                    }
                };
                const branchResult = linearizeExpr(branch.body, branchState);
                state.tempCounter = Math.max(state.tempCounter, branchState.tempCounter);
                branchState.locals.forEach((name) => state.locals.add(name));
                const thenStatements = [
                    payloadAssign,
                    ...branchResult.statements,
                    assignCopy(resultTarget, branchResult.result)
                ];
                if (branchIndex === expr.branches.length - 1) {
                    return [
                        {
                            kind: "assign",
                            target: condTarget,
                            value: {
                                kind: "union_has_tag",
                                unionValue: unionResult.result,
                                unionTypeTagId: expr.unionTypeTagId,
                                memberTypeTagId: branch.memberTypeTagId
                            }
                        },
                        {
                            kind: "if",
                            cond: { kind: "local", name: condTarget },
                            thenStatements,
                            elseStatements: [
                                {
                                    kind: "assign",
                                    target: resultTarget,
                                    value: { kind: "direct_call", symbol: "iw_match_unreachable", args: [] }
                                }
                            ]
                        }
                    ];
                }
                return [
                    {
                        kind: "assign",
                        target: condTarget,
                        value: {
                            kind: "union_has_tag",
                            unionValue: unionResult.result,
                            unionTypeTagId: expr.unionTypeTagId,
                            memberTypeTagId: branch.memberTypeTagId
                        }
                    },
                    {
                        kind: "if",
                        cond: { kind: "local", name: condTarget },
                        thenStatements,
                        elseStatements: buildBranch(branchIndex + 1)
                    }
                ];
            };
            return {
                statements: [...unionResult.statements, ...buildBranch(0)],
                result: { kind: "local", name: resultTarget }
            };
        }
    }
}

function validateLinearBody(body: LinearBody): void {
    if (body.statements.some((statement) => statement.kind === undefined)) {
        throw new Error("Pass 9 linearization validation failed: invalid statement kind");
    }
}

function synthesizeTopLevelEntryCall(
    entrySymbol: string | null,
    entryParams: readonly { readonly name: string; }[],
    state: LinearizeState
): { readonly statements: readonly LinearStatement[]; readonly result: LinearOperand | null } {
    if (entrySymbol === null) {
        return {
            statements: [],
            result: null
        };
    }

    const target = nextLinearTemp(state);
    return {
        statements: [{
            kind: "assign",
            target,
            value: {
                kind: "direct_call",
                symbol: entrySymbol,
                args: entryParams.map((param) => ({ kind: "local", name: param.name } satisfies LinearOperand))
            }
        }],
        result: { kind: "local", name: target }
    };
}

function linearizeFunction(fn: ClosureConvertedFunctionDefinition): LinearizedFunctionDefinition {
    const state: LinearizeState = {
        tempCounter: 0,
        locals: new Set(fn.params.map((param) => param.name))
    };
    const bodyResult = linearizeExpr(fn.body, state);
    const body: LinearBody = {
        locals: Array.from(state.locals).sort((left, right) => left.localeCompare(right)),
        statements: bodyResult.statements,
        result: bodyResult.result
    };
    validateLinearBody(body);
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body,
        origin: fn.origin,
        unitId: fn.unitId ?? null
    };
}

export function validateNoOptimizeLinearizedProgram(program: LinearizedProgram): void {
    validateLinearBody(program.topLevelBody);
    program.functions.forEach((fn) => validateLinearBody(fn.body));
}

export function noOptimizeLinearizePass(program: TypedSlotProgram | FoldedTypedPrimitiveProgram | ScalarReplacedFreshProgram): LinearizedProgram {
    const topLevelState: LinearizeState = {
        tempCounter: 0,
        locals: new Set()
    };
    const topLevelResult = linearizeExpr({ kind: "seq", expressions: program.topLevelStatements }, topLevelState);
    const synthesizedEntryCall = synthesizeTopLevelEntryCall(program.metadata.entryConcreteFunctionSymbol, program.metadata.entryParams, topLevelState);
    const linearized: LinearizedProgram = {
        kind: "linearized_program",
        topLevelBody: {
            locals: Array.from(topLevelState.locals).sort((left, right) => left.localeCompare(right)),
            statements: [...topLevelResult.statements, ...synthesizedEntryCall.statements],
            result: synthesizedEntryCall.result ?? topLevelResult.result
        },
        globals: program.globals,
        functions: program.functions.map((fn) => linearizeFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
    validateNoOptimizeLinearizedProgram(linearized);
    return linearized;
}
