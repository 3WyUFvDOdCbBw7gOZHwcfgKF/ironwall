import { IdentifierNode } from "./AstNode";
import {
    LiftedLoweringProgram,
    LoweredBinding,
    LoweredClassPrimitiveProgram,
    LoweredExpr,
    LoweredFunctionDefinition,
    LoweringStageAResult,
    LoweringSnapshotProgram,
    type LoweringLayoutTable
} from "./Lowering-Frontend-Shared";
import { collectLoweringClassLayouts } from "./Lowering-Pass-1-CollectLayouts";
import { createLoweringSnapshotProgram } from "./Lowering-Pass-0-Snapshot";
import type { LoweringSnapshotOptions } from "./Lowering-Pass-0-Snapshot";
import { lowerClassPrimitivesPass } from "./Lowering-Pass-2-LowerClassPrimitives";
import type { MonomorphizedArtifacts } from "./Typecheck-Pipeline";

function rewriteDirectMethodCalls(expr: LoweredExpr): LoweredExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "fn":
            return { ...expr, body: rewriteDirectMethodCalls(expr.body) };
        case "let":
            return {
                ...expr,
                bindings: expr.bindings.map((binding) => ({
                    ...binding,
                    value: rewriteDirectMethodCalls(binding.value)
                })),
                body: rewriteDirectMethodCalls(expr.body)
            };
        case "if":
            return {
                ...expr,
                condExpr: rewriteDirectMethodCalls(expr.condExpr),
                trueBranchExpr: rewriteDirectMethodCalls(expr.trueBranchExpr),
                falseBranchExpr: rewriteDirectMethodCalls(expr.falseBranchExpr)
            };
        case "while":
            return {
                ...expr,
                condExpr: rewriteDirectMethodCalls(expr.condExpr),
                bodyExpr: rewriteDirectMethodCalls(expr.bodyExpr)
            };
        case "cond":
            return {
                ...expr,
                clauses: expr.clauses.map((clause) => ({
                    cond: rewriteDirectMethodCalls(clause.cond),
                    body: rewriteDirectMethodCalls(clause.body)
                }))
            };
        case "dvar":
            return { ...expr, value: rewriteDirectMethodCalls(expr.value) };
        case "seq":
            return { ...expr, expressions: expr.expressions.map((inner) => rewriteDirectMethodCalls(inner)) };
        case "set_local":
            return { ...expr, value: rewriteDirectMethodCalls(expr.value) };
        case "call": {
            const callee = rewriteDirectMethodCalls(expr.callee);
            const args = expr.args.map((arg) => rewriteDirectMethodCalls(arg));
            if (callee.kind === "method_closure_create") {
                return {
                    kind: "direct_call",
                    symbol: callee.methodSymbol,
                    args: [callee.receiver, ...args]
                };
            }
            return {
                kind: "call",
                callee,
                args
            };
        }
        case "direct_call":
            return { ...expr, args: expr.args.map((arg) => rewriteDirectMethodCalls(arg)) };
        case "object_get_field":
            return { ...expr, receiver: rewriteDirectMethodCalls(expr.receiver) };
        case "object_set_field":
            return {
                ...expr,
                receiver: rewriteDirectMethodCalls(expr.receiver),
                value: rewriteDirectMethodCalls(expr.value)
            };
        case "method_closure_create":
            return { ...expr, receiver: rewriteDirectMethodCalls(expr.receiver) };
        case "union_inject":
            return { ...expr, value: rewriteDirectMethodCalls(expr.value) };
        case "match":
            return {
                ...expr,
                unionExpr: rewriteDirectMethodCalls(expr.unionExpr),
                branches: expr.branches.map((branch) => ({
                    ...branch,
                    body: rewriteDirectMethodCalls(branch.body)
                }))
            };
    }
}

function validateLiftedExpr(expr: LoweredExpr): void {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "fn":
            validateLiftedExpr(expr.body);
            return;
        case "let":
            expr.bindings.forEach((binding) => validateLiftedExpr(binding.value));
            validateLiftedExpr(expr.body);
            return;
        case "if":
            validateLiftedExpr(expr.condExpr);
            validateLiftedExpr(expr.trueBranchExpr);
            validateLiftedExpr(expr.falseBranchExpr);
            return;
        case "while":
            validateLiftedExpr(expr.condExpr);
            validateLiftedExpr(expr.bodyExpr);
            return;
        case "cond":
            expr.clauses.forEach((clause) => {
                validateLiftedExpr(clause.cond);
                validateLiftedExpr(clause.body);
            });
            return;
        case "dvar":
            validateLiftedExpr(expr.value);
            return;
        case "seq":
            expr.expressions.forEach((inner) => validateLiftedExpr(inner));
            return;
        case "set_local":
            validateLiftedExpr(expr.value);
            return;
        case "call":
            if (expr.callee.kind === "method_closure_create") {
                throw new Error("Pass 3 lifting validation failed: direct method calls must be rewritten to direct_call");
            }
            validateLiftedExpr(expr.callee);
            expr.args.forEach((arg) => validateLiftedExpr(arg));
            return;
        case "direct_call":
            expr.args.forEach((arg) => validateLiftedExpr(arg));
            return;
        case "object_get_field":
            validateLiftedExpr(expr.receiver);
            return;
        case "object_set_field":
            validateLiftedExpr(expr.receiver);
            validateLiftedExpr(expr.value);
            return;
        case "method_closure_create":
            validateLiftedExpr(expr.receiver);
            return;
        case "union_inject":
            validateLiftedExpr(expr.value);
            return;
        case "match":
            validateLiftedExpr(expr.unionExpr);
            expr.branches.forEach((branch) => validateLiftedExpr(branch.body));
            return;
    }
}

export function validateLiftedLoweringProgram(program: LiftedLoweringProgram, pass2: LoweredClassPrimitiveProgram): void {
    const expectedFunctionCount = pass2.functions.length + pass2.classes.reduce((count, classDef) => count + classDef.methods.length + classDef.constructorDefs.length, 0);
    if (program.functions.length !== expectedFunctionCount) {
        throw new Error("Pass 3 lifting validation failed: function count mismatch after lifting methods and constructors");
    }
    for (const statement of program.topLevelStatements) {
        validateLiftedExpr(statement);
    }
    for (const fn of program.functions) {
        validateLiftedExpr(fn.body);
    }
}

export function liftMethodsPass(program: LoweredClassPrimitiveProgram): LiftedLoweringProgram {
    const liftedFunctions: LoweredFunctionDefinition[] = program.functions.map((fn) => ({
        ...fn,
        body: rewriteDirectMethodCalls(fn.body)
    }));
    const liftedMethodMap = new Map<string, string>();
    for (const classDef of program.classes) {
        const selfBinding: LoweredBinding = {
            name: "self",
            typeExp: new IdentifierNode(classDef.className)
        };
        classDef.constructorDefs.forEach((constructorDef, index) => {
            liftedFunctions.push({
                symbol: constructorDef.symbol,
                params: [selfBinding, ...constructorDef.params],
                returnType: new IdentifierNode(classDef.className),
                body: rewriteDirectMethodCalls(constructorDef.body),
                origin: {
                    kind: "constructor",
                    className: classDef.className
                }
            });
            liftedMethodMap.set(`${classDef.className}#constructor/${index}`, constructorDef.symbol);
        });
        for (const method of classDef.methods) {
            liftedFunctions.push({
                symbol: method.symbol,
                params: [selfBinding, ...method.params],
                returnType: method.returnType,
                body: rewriteDirectMethodCalls(method.body),
                origin: {
                    kind: "method",
                    className: classDef.className,
                    methodName: method.methodName
                }
            });
            liftedMethodMap.set(`${classDef.className}.${method.methodName}`, method.symbol);
        }
    }

    const liftedProgram: LiftedLoweringProgram = {
        kind: "lifted_lowering_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteDirectMethodCalls(statement)),
        globals: program.globals,
        functions: liftedFunctions,
        declaredFunctions: program.declaredFunctions,
        layouts: program.layouts,
        liftedMethodMap,
        metadata: program.metadata
    };
    validateLiftedLoweringProgram(liftedProgram, program);
    return liftedProgram;
}

export function performLoweringStageA(ast: LoweringSnapshotProgram, layouts?: LoweringLayoutTable): {
    readonly layouts: LoweringLayoutTable;
    readonly pass2: LoweredClassPrimitiveProgram;
    readonly pass3: LiftedLoweringProgram;
} {
    const resolvedLayouts = layouts ?? collectLoweringClassLayouts(ast);
    const pass2 = lowerClassPrimitivesPass(ast, resolvedLayouts);
    const pass3 = liftMethodsPass(pass2);
    return {
        layouts: resolvedLayouts,
        pass2,
        pass3
    };
}

export function performLoweringStageAFromArtifacts(programAst: import("./AstNode").AstNode, artifacts: MonomorphizedArtifacts, options?: LoweringSnapshotOptions): LoweringStageAResult {
    const snapshot = createLoweringSnapshotProgram(programAst, artifacts, options);
    const layouts = collectLoweringClassLayouts(snapshot);
    const pass2 = lowerClassPrimitivesPass(snapshot, layouts);
    const pass3 = liftMethodsPass(pass2);
    return {
        snapshot,
        layouts,
        pass2,
        pass3
    };
}
