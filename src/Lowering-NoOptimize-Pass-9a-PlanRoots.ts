import type {
    CfgTrimmedRootCandidateBlock,
    CfgTrimmedRootCandidateBody,
    CfgTrimmedRootCandidateProgram,
    GcRootPlan,
    GcRootPlanBody,
    GcRootPlanStatement,
    TrimmedRootCandidateBody,
    TrimmedRootCandidateProgram,
    TrimmedRootCandidateStatement
} from "./backend-linux/Backend-Linux-IR-Shared";
import type {
    LinearBody,
    LinearStatement,
} from "./Lowering-Frontend-Shared";

interface PlanReconstructionState {
    labelCounter: number;
    readonly prefix: string;
    readonly blockMap: ReadonlyMap<string, CfgTrimmedRootCandidateBlock>;
}

function packageStatement(statement: TrimmedRootCandidateStatement): GcRootPlanStatement {
    switch (statement.kind) {
        case "assign":
            return { kind: "assign", gcRoots: statement.gcRoots };
        case "set_local":
            return { kind: "set_local", gcRoots: statement.gcRoots };
        case "object_set_field":
            return { kind: "object_set_field", gcRoots: statement.gcRoots };
        case "slot_store":
            return { kind: "slot_store", gcRoots: statement.gcRoots };
        case "if":
            return {
                kind: "if",
                gcRoots: statement.gcRoots,
                thenStatements: statement.thenStatements.map((inner) => packageStatement(inner)),
                elseStatements: statement.elseStatements.map((inner) => packageStatement(inner))
            };
        case "while":
            return {
                kind: "while",
                gcRoots: statement.gcRoots,
                condStatements: statement.condStatements.map((inner) => packageStatement(inner)),
                bodyStatements: statement.bodyStatements.map((inner) => packageStatement(inner))
            };
    }
}

function packageBody(body: TrimmedRootCandidateBody): GcRootPlanBody {
    return {
        gcRootNames: body.gcRootNames,
        statementPlans: body.statementRoots.map((statement) => packageStatement(statement)),
        resultGcRoots: body.resultGcRoots
    };
}

function nextLabel(state: PlanReconstructionState, hint: string): string {
    const label = `${state.prefix}_${hint}_${state.labelCounter}`;
    state.labelCounter += 1;
    return label;
}

function packageLinearStatementFallback(statement: LinearStatement): GcRootPlanStatement {
    switch (statement.kind) {
        case "assign":
        case "set_local":
        case "object_set_field":
        case "slot_store":
            return {
                kind: statement.kind,
                gcRoots: []
            };
        case "if":
            return {
                kind: "if",
                gcRoots: [],
                thenStatements: statement.thenStatements.map((inner) => packageLinearStatementFallback(inner)),
                elseStatements: statement.elseStatements.map((inner) => packageLinearStatementFallback(inner))
            };
        case "while":
            return {
                kind: "while",
                gcRoots: [],
                condStatements: statement.condStatements.map((inner) => packageLinearStatementFallback(inner)),
                bodyStatements: statement.bodyStatements.map((inner) => packageLinearStatementFallback(inner))
            };
    }
}

function packageFlatStatementFromCfg(block: CfgTrimmedRootCandidateBlock, index: number, fallback: LinearStatement): GcRootPlanStatement {
    const cfgStatement = block.statementRoots[index];
    if (!cfgStatement || cfgStatement.kind !== fallback.kind) {
        return packageLinearStatementFallback(fallback);
    }
    return {
        kind: cfgStatement.kind,
        gcRoots: cfgStatement.gcRoots
    };
}

function reconstructSequenceFromCfg(
    label: string,
    statements: readonly LinearStatement[],
    state: PlanReconstructionState
): readonly GcRootPlanStatement[] {
    const block = state.blockMap.get(label);
    if (!block) {
        return statements.map((statement) => packageLinearStatementFallback(statement));
    }
    const packaged: GcRootPlanStatement[] = [];
    let flatIndex = 0;
    for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (!statement) {
            break;
        }
        if (statement.kind !== "if" && statement.kind !== "while") {
            packaged.push(packageFlatStatementFromCfg(block, flatIndex, statement));
            flatIndex += 1;
            continue;
        }
        if (statement.kind === "if") {
            const afterLabel = nextLabel(state, "if_join");
            const afterPlans = reconstructSequenceFromCfg(afterLabel, statements.slice(index + 1), state);
            const thenLabel = nextLabel(state, "if_then");
            const thenPlans = reconstructSequenceFromCfg(thenLabel, statement.thenStatements, state);
            const elseLabel = nextLabel(state, "if_else");
            const elsePlans = reconstructSequenceFromCfg(elseLabel, statement.elseStatements, state);
            packaged.push({
                kind: "if",
                gcRoots: block.terminatorRoots,
                thenStatements: thenPlans,
                elseStatements: elsePlans
            });
            packaged.push(...afterPlans);
            return packaged;
        }
        if (statement.kind === "while") {
            const afterLabel = nextLabel(state, "while_exit");
            const afterPlans = reconstructSequenceFromCfg(afterLabel, statements.slice(index + 1), state);
            const condLabel = nextLabel(state, "while_cond");
            const bodyLabel = nextLabel(state, "while_body");
            const bodyPlans = reconstructSequenceFromCfg(bodyLabel, statement.bodyStatements, state);
            const condPlans = reconstructSequenceFromCfg(condLabel, statement.condStatements, state);
            packaged.push({
                kind: "while",
                gcRoots: block.terminatorRoots,
                condStatements: condPlans,
                bodyStatements: bodyPlans
            });
            packaged.push(...afterPlans);
            return packaged;
        }
        packaged.push(packageLinearStatementFallback(statement));
    }
    return packaged;
}

function packageLinearBodyFallback(linearBody: LinearBody, gcRootNames: readonly string[] = []): GcRootPlanBody {
    return {
        gcRootNames,
        statementPlans: linearBody.statements.map((statement) => packageLinearStatementFallback(statement)),
        resultGcRoots: []
    };
}

function packageCfgBody(cfgBody: CfgTrimmedRootCandidateBody, linearBody: LinearBody): GcRootPlanBody {
    const entryBlock = cfgBody.blocks.find((block) => block.label.endsWith("_entry")) ?? cfgBody.blocks[0];
    if (!entryBlock || !cfgBody.blocks.some((block) => block.label === entryBlock.label)) {
        return packageLinearBodyFallback(linearBody, cfgBody.gcRootNames);
    }
    const state: PlanReconstructionState = {
        labelCounter: 0,
        prefix: entryBlock.label.endsWith("_entry") ? entryBlock.label.slice(0, -"_entry".length) : entryBlock.label,
        blockMap: new Map(cfgBody.blocks.map((block) => [block.label, block]))
    };
    return {
        gcRootNames: cfgBody.gcRootNames,
        statementPlans: reconstructSequenceFromCfg(state.prefix + "_entry", linearBody.statements, state),
        resultGcRoots: cfgBody.returnRoots
    };
}

export function planGcRootsPass(
    trimmed: TrimmedRootCandidateProgram,
    cfgTrimmed?: CfgTrimmedRootCandidateProgram,
    linearized?: { readonly topLevelBody: LinearBody; readonly functions: readonly { readonly symbol: string; readonly body: LinearBody; }[] }
): GcRootPlan {
    const cfgByFunction = new Map(cfgTrimmed?.functions.map((fn) => [fn.symbol, fn.body] as const) ?? []);
    const linearByFunction = new Map(linearized?.functions.map((fn) => [fn.symbol, fn.body] as const) ?? []);
    return {
        kind: "gc_root_plan",
        entry: cfgTrimmed && linearized
            ? packageCfgBody(cfgTrimmed.entry, linearized.topLevelBody)
            : packageBody(trimmed.entry),
        functions: trimmed.functions.map((fn) => ({
            symbol: fn.symbol,
            body: cfgTrimmed && linearized && linearByFunction.get(fn.symbol)
                ? packageCfgBody(cfgByFunction.get(fn.symbol) ?? { gcRootNames: fn.body.gcRootNames, returnRoots: [], blocks: [] }, linearByFunction.get(fn.symbol)!)
                : packageBody(fn.body)
        }))
    };
}

export function planGcRootsFromCfgPass(
    linearized: { readonly topLevelBody: LinearBody; readonly functions: readonly { readonly symbol: string; readonly body: LinearBody; }[] },
    cfgTrimmed: CfgTrimmedRootCandidateProgram
): GcRootPlan {
    const cfgByFunction = new Map(cfgTrimmed.functions.map((fn) => [fn.symbol, fn.body] as const));
    const linearByFunction = new Map(linearized.functions.map((fn) => [fn.symbol, fn.body] as const));
    return {
        kind: "gc_root_plan",
        entry: packageCfgBody(cfgTrimmed.entry, linearized.topLevelBody),
        functions: linearized.functions.map((fn) => ({
            symbol: fn.symbol,
            body: packageCfgBody(
                cfgByFunction.get(fn.symbol) ?? { gcRootNames: [], returnRoots: [], blocks: [] },
                linearByFunction.get(fn.symbol) ?? fn.body
            )
        }))
    };
}
