import type {
    CfgBlock,
    CfgBody,
    CfgFunctionDefinition,
    CfgProgram,
    CfgStatement,
    CfgTerminator,
    LinearBody,
    LinearStatement,
    LinearizedFunctionDefinition,
    LinearizedProgram
} from "./Lowering-Frontend-Shared";

interface CfgLoweringState {
    labelCounter: number;
    blocks: CfgBlock[];
    readonly prefix: string;
}

function nextLabel(state: CfgLoweringState, hint: string): string {
    const label = `${state.prefix}_${hint}_${state.labelCounter}`;
    state.labelCounter += 1;
    return label;
}

function isFlatStatement(statement: LinearStatement): statement is CfgStatement {
    return statement.kind === "assign" || statement.kind === "set_local" || statement.kind === "object_set_field" || statement.kind === "slot_store";
}

function pushBlock(state: CfgLoweringState, label: string, statements: readonly CfgStatement[], terminator: CfgTerminator): void {
    state.blocks.push({ label, statements, terminator });
}

function lowerSequenceInto(label: string, statements: readonly LinearStatement[], exitTerminator: CfgTerminator, state: CfgLoweringState): void {
    const flatStatements: CfgStatement[] = [];
    for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (statement && isFlatStatement(statement)) {
            flatStatements.push(statement);
            continue;
        }
        if (!statement) {
            break;
        }
        if (statement.kind === "if") {
            const afterLabel = nextLabel(state, "if_join");
            lowerSequenceInto(afterLabel, statements.slice(index + 1), exitTerminator, state);
            const thenLabel = nextLabel(state, "if_then");
            const elseLabel = nextLabel(state, "if_else");
            lowerSequenceInto(thenLabel, statement.thenStatements, { kind: "jump", target: afterLabel }, state);
            lowerSequenceInto(elseLabel, statement.elseStatements, { kind: "jump", target: afterLabel }, state);
            pushBlock(state, label, flatStatements, { kind: "branch", cond: statement.cond, trueTarget: thenLabel, falseTarget: elseLabel });
            return;
        }
        if (statement.kind === "while") {
            const afterLabel = nextLabel(state, "while_exit");
            lowerSequenceInto(afterLabel, statements.slice(index + 1), exitTerminator, state);
            const condLabel = nextLabel(state, "while_cond");
            const bodyLabel = nextLabel(state, "while_body");
            lowerSequenceInto(bodyLabel, statement.bodyStatements, { kind: "jump", target: condLabel }, state);
            lowerSequenceInto(condLabel, statement.condStatements, { kind: "branch", cond: statement.cond, trueTarget: bodyLabel, falseTarget: afterLabel }, state);
            pushBlock(state, label, flatStatements, { kind: "jump", target: condLabel });
            return;
        }
    }
    pushBlock(state, label, flatStatements, exitTerminator);
}

function lowerBody(body: LinearBody, prefix: string): CfgBody {
    const state: CfgLoweringState = {
        labelCounter: 0,
        blocks: [],
        prefix
    };
    const entryLabel = `${prefix}_entry`;
    lowerSequenceInto(entryLabel, body.statements, { kind: "return", value: body.result }, state);
    return {
        entryLabel,
        locals: body.locals,
        blocks: state.blocks
    };
}

function lowerFunction(fn: LinearizedFunctionDefinition): CfgFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: lowerBody(fn.body, fn.symbol.replace(/[^A-Za-z0-9_]+/g, "_")),
        origin: fn.origin
    };
}

export function lowerToCfgPass(program: LinearizedProgram): CfgProgram {
    return {
        kind: "cfg_program",
        entry: lowerBody(program.topLevelBody, "entry"),
        globals: program.globals,
        functions: program.functions.map((fn) => lowerFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}