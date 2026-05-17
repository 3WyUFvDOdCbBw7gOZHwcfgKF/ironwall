import type {
    MayCollectBody,
    MayCollectProgram,
    MayCollectStatement
} from "./backend-linux/Backend-Linux-IR-Shared";
import type {
    LinearBody,
    LinearRvalue,
    LinearStatement,
    LinearizedProgram
} from "./Lowering-Frontend-Shared";
import { isGcCollectLikeSymbol, resolveDeclaredCFunctionAlias } from "./DeclaredCFunctionName";

interface AnalysisState {
    readonly functionMayCollect: Map<string, boolean>;
}

function directCallMayCollect(symbol: string, state: AnalysisState): boolean {
    const resolvedSymbol = resolveDeclaredCFunctionAlias(symbol);
    if (
        isGcCollectLikeSymbol(symbol)
        || resolvedSymbol === "iw_thread_join_i5"
        || resolvedSymbol === "iw_sys_process_wait"
        || resolvedSymbol === "iw_sys_wait_one"
        || resolvedSymbol === "iw_sys_wait_many"
        || resolvedSymbol === "iw_mutex_lock"
        || resolvedSymbol === "iw_cond_wait"
        || resolvedSymbol === "iw_cond_timed_wait_ms"
        || resolvedSymbol === "iw_sem_wait"
        || resolvedSymbol === "iw_sem_timed_wait_ms"
        || resolvedSymbol === "iw_sleep_ms"
        || resolvedSymbol === "iw_thread_yield"
    ) {
        return true;
    }
    return state.functionMayCollect.get(symbol) === true;
}

function rvalueMayCollect(rvalue: LinearRvalue, state: AnalysisState): boolean {
    switch (rvalue.kind) {
        case "copy":
        case "object_alloc":
        case "union_inject":
        case "object_get_field":
        case "slot_load":
        case "union_has_tag":
        case "union_get_payload":
        case "closure_create":
            return false;
        case "direct_call":
            return directCallMayCollect(rvalue.symbol, state);
        case "closure_call":
            return true;
    }
}

function annotateStatements(statements: readonly LinearStatement[], state: AnalysisState): readonly MayCollectStatement[] {
    return statements.map((statement): MayCollectStatement => {
        switch (statement.kind) {
            case "assign":
                return {
                    kind: "assign",
                    mayCollect: rvalueMayCollect(statement.value, state)
                };
            case "set_local":
                return {
                    kind: "set_local",
                    mayCollect: false
                };
            case "object_set_field":
                return {
                    kind: "object_set_field",
                    mayCollect: false
                };
            case "slot_store":
                return {
                    kind: "slot_store",
                    mayCollect: false
                };
            case "if": {
                const thenStatements = annotateStatements(statement.thenStatements, state);
                const elseStatements = annotateStatements(statement.elseStatements, state);
                return {
                    kind: "if",
                    mayCollect: thenStatements.some((inner) => inner.mayCollect) || elseStatements.some((inner) => inner.mayCollect),
                    thenStatements,
                    elseStatements
                };
            }
            case "while": {
                const condStatements = annotateStatements(statement.condStatements, state);
                const bodyStatements = annotateStatements(statement.bodyStatements, state);
                return {
                    kind: "while",
                    mayCollect: condStatements.some((inner) => inner.mayCollect) || bodyStatements.some((inner) => inner.mayCollect),
                    condStatements,
                    bodyStatements
                };
            }
        }
    });
}

function bodyMayCollect(body: LinearBody, state: AnalysisState): boolean {
    return annotateStatements(body.statements, state).some((statement) => statement.mayCollect);
}

function annotateBody(body: LinearBody, state: AnalysisState): MayCollectBody {
    const statementAnnotations = annotateStatements(body.statements, state);
    return {
        mayCollect: statementAnnotations.some((statement) => statement.mayCollect),
        statementAnnotations
    };
}

export function annotateMayCollectPass(program: LinearizedProgram): MayCollectProgram {
    const state: AnalysisState = {
        functionMayCollect: new Map(program.functions.map((fn) => [fn.symbol, false] as const))
    };

    let changed = true;
    while (changed) {
        changed = false;
        for (const fn of program.functions) {
            const nextValue = bodyMayCollect(fn.body, state);
            if (state.functionMayCollect.get(fn.symbol) !== nextValue) {
                state.functionMayCollect.set(fn.symbol, nextValue);
                changed = true;
            }
        }
    }

    return {
        kind: "may_collect_program",
        entry: annotateBody(program.topLevelBody, state),
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            body: annotateBody(fn.body, state)
        }))
    };
}
