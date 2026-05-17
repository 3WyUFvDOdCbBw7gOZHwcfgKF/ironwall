import { IdentifierNode } from "./AstNode";
import type {
    BindingFact,
    FactsAnalysisResult,
    LoweredExpr,
    PropagatedFactsProgram,
    SimplifiedAnfProgram,
    ValueFact
} from "./Lowering-Frontend-Shared";

interface MutableBindingFact {
    bindingId: string;
    name: string;
    declaredIn: "let" | "param" | "match";
    useCount: number;
    isAssigned: boolean;
    isCaptured: boolean;
    escapes: boolean;
    isPure: boolean;
    fact: ValueFact;
    depth: number;
}

interface ScopeFrame {
    readonly bindings: Map<string, MutableBindingFact>;
}

interface FactsState {
    bindingCounter: number;
    readonly frames: ScopeFrame[];
    readonly bindings: MutableBindingFact[];
}

function createScopeFrame(): ScopeFrame {
    return { bindings: new Map() };
}

function pushScope(state: FactsState): void {
    state.frames.push(createScopeFrame());
}

function popScope(state: FactsState): void {
    state.frames.pop();
}

function currentDepth(state: FactsState): number {
    return state.frames.length - 1;
}

function lookupBinding(state: FactsState, name: string): MutableBindingFact | undefined {
    for (let index = state.frames.length - 1; index >= 0; index -= 1) {
        const binding = state.frames[index].bindings.get(name);
        if (binding !== undefined) {
            return binding;
        }
    }
    return undefined;
}

function isPureExpr(expr: LoweredExpr): boolean {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "fn":
            return true;
        case "let":
            return expr.bindings.every((binding) => isPureExpr(binding.value)) && isPureExpr(expr.body);
        case "if":
            return isPureExpr(expr.condExpr) && isPureExpr(expr.trueBranchExpr) && isPureExpr(expr.falseBranchExpr);
        case "while":
            return false;
        case "seq":
            return expr.expressions.every((inner) => isPureExpr(inner));
        case "object_get_field":
            return isPureExpr(expr.receiver);
        case "call":
        case "direct_call":
        case "set_local":
        case "object_alloc":
        case "object_set_field":
        case "method_closure_create":
        case "union_inject":
        case "match":
        case "cond":
        case "dvar":
            return false;
    }
}

function inferValueFact(expr: LoweredExpr, typeExp?: import("./AstNode").AstNode): ValueFact {
    if (expr.kind === "identifier") {
        if (expr.name === "true") {
            return { kind: "boolean_literal", value: true };
        }
        if (expr.name === "false") {
            return { kind: "boolean_literal", value: false };
        }
        return { kind: "unknown" };
    }
    if (expr.kind === "number_literal") {
        if (typeExp instanceof IdentifierNode && typeExp.name === "bool" && (expr.value === 0 || expr.value === 1)) {
            return { kind: "boolean_literal", value: expr.value === 1 };
        }
        return { kind: "number_literal", value: expr.value, typeName: expr.typeName };
    }
    if (expr.kind === "text_literal") {
        return {
            kind: "text_literal",
            typeName: expr.typeName,
            referenceName: expr.referenceName
        };
    }
    if (expr.kind === "direct_function_ref") {
        return { kind: "direct_function_ref", symbol: expr.symbol };
    }
    return { kind: "unknown" };
}

function registerBinding(
    state: FactsState,
    declaredIn: "let" | "param" | "match",
    name: string,
    typeExp: import("./AstNode").AstNode | undefined,
    valueExpr?: LoweredExpr
): MutableBindingFact {
    const bindingId = `binding_${state.bindingCounter}`;
    state.bindingCounter += 1;
    const binding: MutableBindingFact = {
        bindingId,
        name,
        declaredIn,
        useCount: 0,
        isAssigned: false,
        isCaptured: false,
        escapes: false,
        isPure: valueExpr ? isPureExpr(valueExpr) : true,
        fact: valueExpr ? inferValueFact(valueExpr, typeExp) : { kind: "unknown" },
        depth: currentDepth(state)
    };
    state.frames[state.frames.length - 1].bindings.set(name, binding);
    state.bindings.push(binding);
    return binding;
}

function noteIdentifierUse(state: FactsState, name: string, escape: boolean): void {
    const binding = lookupBinding(state, name);
    if (!binding) {
        return;
    }
    binding.useCount += 1;
    if (escape) {
        binding.escapes = true;
    }
    if (binding.depth < currentDepth(state)) {
        binding.isCaptured = true;
        binding.escapes = true;
    }
}

function analyzeExpr(expr: LoweredExpr, state: FactsState, escape: boolean): void {
    switch (expr.kind) {
        case "identifier":
            noteIdentifierUse(state, expr.name, escape);
            return;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return;
        case "fn": {
            pushScope(state);
            for (const param of expr.params) {
                registerBinding(state, "param", param.name, param.typeExp);
            }
            analyzeExpr(expr.body, state, true);
            popScope(state);
            return;
        }
        case "let": {
            pushScope(state);
            for (const binding of expr.bindings) {
                analyzeExpr(binding.value, state, false);
                registerBinding(state, "let", binding.bind.name, binding.bind.typeExp, binding.value);
            }
            analyzeExpr(expr.body, state, escape);
            popScope(state);
            return;
        }
        case "if":
            analyzeExpr(expr.condExpr, state, false);
            analyzeExpr(expr.trueBranchExpr, state, escape);
            analyzeExpr(expr.falseBranchExpr, state, escape);
            return;
        case "while":
            analyzeExpr(expr.condExpr, state, false);
            analyzeExpr(expr.bodyExpr, state, false);
            return;
        case "seq":
            expr.expressions.forEach((inner, index) => analyzeExpr(inner, state, escape && index === expr.expressions.length - 1));
            return;
        case "set_local": {
            const binding = lookupBinding(state, expr.identifier);
            if (binding) {
                binding.isAssigned = true;
            }
            analyzeExpr(expr.value, state, false);
            return;
        }
        case "call":
            analyzeExpr(expr.callee, state, true);
            expr.args.forEach((arg) => analyzeExpr(arg, state, true));
            return;
        case "direct_call":
            expr.args.forEach((arg) => analyzeExpr(arg, state, true));
            return;
        case "object_get_field":
            analyzeExpr(expr.receiver, state, false);
            return;
        case "object_set_field":
            analyzeExpr(expr.receiver, state, true);
            analyzeExpr(expr.value, state, true);
            return;
        case "method_closure_create":
            analyzeExpr(expr.receiver, state, true);
            return;
        case "union_inject":
            analyzeExpr(expr.value, state, true);
            return;
        case "match":
            analyzeExpr(expr.unionExpr, state, true);
            for (const branch of expr.branches) {
                pushScope(state);
                registerBinding(state, "match", branch.bind.name, branch.bind.typeExp);
                analyzeExpr(branch.body, state, escape);
                popScope(state);
            }
            return;
        case "cond":
        case "dvar":
            throw new Error(`Pass 5b facts analysis failed: unexpected node kind '${expr.kind}'`);
    }
}

export function validateFactsAnalysis(result: FactsAnalysisResult): void {
    const seen = new Set<string>();
    for (const binding of result.bindings) {
        if (seen.has(binding.bindingId)) {
            throw new Error(`Pass 5b facts validation failed: duplicate binding id '${binding.bindingId}'`);
        }
        seen.add(binding.bindingId);
    }
}

export function analyzeFactsPass(program: SimplifiedAnfProgram | PropagatedFactsProgram): FactsAnalysisResult {
    const state: FactsState = {
        bindingCounter: 0,
        frames: [createScopeFrame()],
        bindings: []
    };
    program.topLevelStatements.forEach((statement, index) => analyzeExpr(statement, state, index === program.topLevelStatements.length - 1));
    for (const fn of program.functions) {
        pushScope(state);
        for (const param of fn.params) {
            registerBinding(state, "param", param.name, param.typeExp);
        }
        analyzeExpr(fn.body, state, true);
        popScope(state);
    }
    const result: FactsAnalysisResult = {
        kind: "facts_analysis",
        bindings: state.bindings.map((binding): BindingFact => ({
            bindingId: binding.bindingId,
            name: binding.name,
            declaredIn: binding.declaredIn,
            useCount: binding.useCount,
            isAssigned: binding.isAssigned,
            isCaptured: binding.isCaptured,
            escapes: binding.escapes,
            isPure: binding.isPure,
            fact: binding.fact
        }))
    };
    validateFactsAnalysis(result);
    return result;
}