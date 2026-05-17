import type {
    CfgBlock,
    CfgBody,
    CfgFunctionDefinition,
    CfgProgram,
    CfgStatement,
    CfgTerminator,
    LinearClosureCallRvalue,
    LinearCopyRvalue,
    LinearDirectCallRvalue,
    LinearDirectFunctionOperand,
    LinearObjectAllocRvalue,
    LinearObjectGetFieldRvalue,
    LinearObjectSetFieldStatement,
    LinearOperand,
    LinearRvalue,
    LinearSlotLoadRvalue,
    LinearSlotStoreStatement,
    LinearTextOperand,
    LinearNumberOperand,
    LinearUnionGetPayloadRvalue,
    LinearUnionHasTagRvalue,
    LinearUnionInjectRvalue,
    SsaBody,
    SsaEntryBinding,
    SsaFunctionDefinition,
    SsaPhiInput,
    SsaPhiNode,
    SsaProgram,
    SsaStatement,
    SsaTerminator
} from "./Lowering-Frontend-Shared";

interface MutablePhiNode {
    variable: string;
    target: string;
    sources: SsaPhiInput[];
}

interface MutableSsaBlock {
    label: string;
    predecessors: string[];
    immediateDominator: string | null;
    dominanceFrontier: string[];
    phiNodes: MutablePhiNode[];
    statements: SsaStatement[];
    statementSourceIndexes: number[];
    terminator: SsaTerminator;
}

interface CfgAnalysis {
    readonly predecessorMap: ReadonlyMap<string, readonly string[]>;
    readonly immediateDominatorMap: ReadonlyMap<string, string | null>;
    readonly dominanceFrontierMap: ReadonlyMap<string, readonly string[]>;
    readonly dominatorChildrenMap: ReadonlyMap<string, readonly string[]>;
}

function cloneOperand(operand: LinearOperand): LinearOperand {
    switch (operand.kind) {
        case "local":
            return { kind: "local", name: operand.name };
        case "number_literal":
            return { kind: "number_literal", value: operand.value, typeName: operand.typeName } satisfies LinearNumberOperand;
        case "text_literal":
            return {
                kind: "text_literal",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            } satisfies LinearTextOperand;
        case "direct_function":
            return { kind: "direct_function", symbol: operand.symbol } satisfies LinearDirectFunctionOperand;
    }
}

function renameOperand(operand: LinearOperand, stacks: Map<string, string[]>): LinearOperand {
    if (operand.kind !== "local") {
        return cloneOperand(operand);
    }
    const stack = stacks.get(operand.name);
    if (!stack || stack.length === 0) {
        return { kind: "local", name: operand.name };
    }
    return { kind: "local", name: stack[stack.length - 1] };
}

function renameRvalue(value: LinearRvalue, stacks: Map<string, string[]>): LinearRvalue {
    switch (value.kind) {
        case "copy":
            return { kind: "copy", value: renameOperand(value.value, stacks) } satisfies LinearCopyRvalue;
        case "object_alloc":
            return { kind: "object_alloc", className: value.className } satisfies LinearObjectAllocRvalue;
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: renameOperand(value.receiver, stacks),
                className: value.className,
                fieldName: value.fieldName
            } satisfies LinearObjectGetFieldRvalue;
        case "slot_load":
            return {
                kind: "slot_load",
                receiver: renameOperand(value.receiver, stacks),
                className: value.className,
                slotName: value.slotName
            } satisfies LinearSlotLoadRvalue;
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId,
                value: renameOperand(value.value, stacks)
            } satisfies LinearUnionInjectRvalue;
        case "union_has_tag":
            return {
                kind: "union_has_tag",
                unionValue: renameOperand(value.unionValue, stacks),
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId
            } satisfies LinearUnionHasTagRvalue;
        case "union_get_payload":
            return {
                kind: "union_get_payload",
                unionValue: renameOperand(value.unionValue, stacks),
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId
            } satisfies LinearUnionGetPayloadRvalue;
        case "closure_create":
            return {
                kind: "closure_create",
                closureId: value.closureId,
                applySymbol: value.applySymbol,
                environmentLayout: value.environmentLayout,
                captures: value.captures.map((capture) => renameOperand(capture, stacks))
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: value.symbol,
                args: value.args.map((arg) => renameOperand(arg, stacks))
            } satisfies LinearDirectCallRvalue;
        case "closure_call":
            return {
                kind: "closure_call",
                callee: renameOperand(value.callee, stacks),
                args: value.args.map((arg) => renameOperand(arg, stacks))
            } satisfies LinearClosureCallRvalue;
    }
}

function renameStatement(statement: CfgStatement, stacks: Map<string, string[]>, nextVersion: (name: string) => string): { statement: SsaStatement; pushed?: string } {
    switch (statement.kind) {
        case "assign": {
            const value = renameRvalue(statement.value, stacks);
            const target = nextVersion(statement.target);
            return {
                statement: {
                    kind: "assign",
                    target,
                    value
                },
                pushed: statement.target
            };
        }
        case "set_local": {
            const value = renameOperand(statement.value, stacks);
            const target = nextVersion(statement.target);
            return {
                statement: {
                    kind: "set_local",
                    target,
                    value
                },
                pushed: statement.target
            };
        }
        case "object_set_field":
            return {
                statement: {
                    kind: "object_set_field",
                    receiver: renameOperand(statement.receiver, stacks),
                    className: statement.className,
                    fieldName: statement.fieldName,
                    value: renameOperand(statement.value, stacks)
                } satisfies LinearObjectSetFieldStatement
            };
        case "slot_store":
            return {
                statement: {
                    kind: "slot_store",
                    receiver: renameOperand(statement.receiver, stacks),
                    className: statement.className,
                    slotName: statement.slotName,
                    value: renameOperand(statement.value, stacks)
                } satisfies LinearSlotStoreStatement
            };
    }
}

function renameTerminator(terminator: CfgTerminator, stacks: Map<string, string[]>): SsaTerminator {
    switch (terminator.kind) {
        case "return":
            return { kind: "return", value: renameOperand(terminator.value, stacks) };
        case "jump":
            return { kind: "jump", target: terminator.target };
        case "branch":
            return {
                kind: "branch",
                cond: renameOperand(terminator.cond, stacks),
                trueTarget: terminator.trueTarget,
                falseTarget: terminator.falseTarget
            };
    }
}

function successorLabels(block: CfgBlock): readonly string[] {
    switch (block.terminator.kind) {
        case "return":
            return [];
        case "jump":
            return [block.terminator.target];
        case "branch":
            return [block.terminator.trueTarget, block.terminator.falseTarget];
    }
}

function buildPredecessorMap(body: CfgBody): Map<string, string[]> {
    const predecessorMap = new Map<string, string[]>();
    for (const block of body.blocks) {
        predecessorMap.set(block.label, []);
    }
    for (const block of body.blocks) {
        for (const successor of successorLabels(block)) {
            const predecessors = predecessorMap.get(successor);
            if (!predecessors) {
                throw new Error(`ssa build: unknown CFG successor '${successor}'`);
            }
            predecessors.push(block.label);
        }
    }
    return predecessorMap;
}

function intersectSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
    const result = new Set<T>();
    for (const item of left) {
        if (right.has(item)) {
            result.add(item);
        }
    }
    return result;
}

function computeDominators(body: CfgBody, predecessorMap: ReadonlyMap<string, readonly string[]>): Map<string, Set<string>> {
    const allLabels = body.blocks.map((block) => block.label);
    const allSet = new Set(allLabels);
    const dominatorMap = new Map<string, Set<string>>();
    for (const label of allLabels) {
        dominatorMap.set(label, label === body.entryLabel ? new Set([label]) : new Set(allSet));
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const label of allLabels) {
            if (label === body.entryLabel) {
                continue;
            }
            const predecessors = predecessorMap.get(label) ?? [];
            let next = new Set(allSet);
            if (predecessors.length > 0) {
                next = new Set(dominatorMap.get(predecessors[0]) ?? []);
                for (const predecessor of predecessors.slice(1)) {
                    next = intersectSets(next, dominatorMap.get(predecessor) ?? new Set<string>());
                }
            }
            next.add(label);
            const current = dominatorMap.get(label) ?? new Set<string>();
            if (current.size !== next.size || Array.from(current).some((item) => !next.has(item))) {
                dominatorMap.set(label, next);
                changed = true;
            }
        }
    }
    return dominatorMap;
}

function computeImmediateDominators(body: CfgBody, dominatorMap: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string | null> {
    const immediateDominatorMap = new Map<string, string | null>();
    for (const block of body.blocks) {
        if (block.label === body.entryLabel) {
            immediateDominatorMap.set(block.label, null);
            continue;
        }
        const strictDominators = Array.from(dominatorMap.get(block.label) ?? []).filter((label) => label !== block.label);
        let immediate: string | null = null;
        for (const candidate of strictDominators) {
            const dominatedByOtherStrict = strictDominators.some((other) => other !== candidate && (dominatorMap.get(other)?.has(candidate) ?? false));
            if (!dominatedByOtherStrict) {
                immediate = candidate;
                break;
            }
        }
        immediateDominatorMap.set(block.label, immediate);
    }
    return immediateDominatorMap;
}

function computeDominatorChildren(body: CfgBody, immediateDominatorMap: ReadonlyMap<string, string | null>): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const block of body.blocks) {
        result.set(block.label, []);
    }
    for (const block of body.blocks) {
        const immediate = immediateDominatorMap.get(block.label);
        if (immediate) {
            result.get(immediate)?.push(block.label);
        }
    }
    return result;
}

function computeDominanceFrontier(
    body: CfgBody,
    predecessorMap: ReadonlyMap<string, readonly string[]>,
    immediateDominatorMap: ReadonlyMap<string, string | null>
): Map<string, string[]> {
    const frontierMap = new Map<string, Set<string>>();
    for (const block of body.blocks) {
        frontierMap.set(block.label, new Set());
    }
    for (const block of body.blocks) {
        const predecessors = predecessorMap.get(block.label) ?? [];
        if (predecessors.length < 2) {
            continue;
        }
        const blockIdom = immediateDominatorMap.get(block.label) ?? null;
        for (const predecessor of predecessors) {
            let runner: string | null = predecessor;
            while (runner && runner !== blockIdom) {
                frontierMap.get(runner)?.add(block.label);
                runner = immediateDominatorMap.get(runner) ?? null;
            }
        }
    }
    return new Map(Array.from(frontierMap.entries()).map(([label, frontier]) => [label, Array.from(frontier).sort()]));
}

function analyzeCfg(body: CfgBody): CfgAnalysis {
    const predecessorMap = buildPredecessorMap(body);
    const dominatorMap = computeDominators(body, predecessorMap);
    const immediateDominatorMap = computeImmediateDominators(body, dominatorMap);
    const dominatorChildrenMap = computeDominatorChildren(body, immediateDominatorMap);
    const dominanceFrontierMap = computeDominanceFrontier(body, predecessorMap, immediateDominatorMap);
    return {
        predecessorMap,
        immediateDominatorMap,
        dominanceFrontierMap,
        dominatorChildrenMap
    };
}

function collectAssignedVariables(body: CfgBody): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const block of body.blocks) {
        for (const statement of block.statements) {
            if (statement.kind !== "assign" && statement.kind !== "set_local") {
                continue;
            }
            const blocks = result.get(statement.target) ?? new Set<string>();
            blocks.add(block.label);
            result.set(statement.target, blocks);
        }
    }
    return result;
}

function placePhiNodes(body: CfgBody, analysis: CfgAnalysis): Map<string, Map<string, MutablePhiNode>> {
    const assignedVariables = collectAssignedVariables(body);
    const phiByBlock = new Map<string, Map<string, MutablePhiNode>>();
    for (const block of body.blocks) {
        phiByBlock.set(block.label, new Map());
    }
    for (const [variable, defBlocks] of assignedVariables.entries()) {
        const worklist = [...defBlocks];
        const visited = new Set<string>(defBlocks);
        while (worklist.length > 0) {
            const blockLabel = worklist.pop();
            if (!blockLabel) {
                break;
            }
            for (const frontierLabel of analysis.dominanceFrontierMap.get(blockLabel) ?? []) {
                const blockPhis = phiByBlock.get(frontierLabel);
                if (!blockPhis) {
                    continue;
                }
                if (!blockPhis.has(variable)) {
                    blockPhis.set(variable, {
                        variable,
                        target: variable,
                        sources: []
                    });
                    if (!visited.has(frontierLabel)) {
                        visited.add(frontierLabel);
                        worklist.push(frontierLabel);
                    }
                }
            }
        }
    }
    return phiByBlock;
}

function createInitialStacks(body: CfgBody, params: readonly { readonly name: string }[]): { stacks: Map<string, string[]>; entryBindings: SsaEntryBinding[] } {
    const stacks = new Map<string, string[]>();
    const entryBindings: SsaEntryBinding[] = [];
    const variables = new Set<string>([...params.map((param) => param.name), ...body.locals]);
    for (const variable of Array.from(variables).sort()) {
        const initial = `${variable}#0`;
        stacks.set(variable, [initial]);
        entryBindings.push({ variable, value: initial });
    }
    return { stacks, entryBindings };
}

function buildSsaBody(body: CfgBody, params: readonly { readonly name: string }[]): SsaBody {
    const analysis = analyzeCfg(body);
    const phiByBlock = placePhiNodes(body, analysis);
    const blockMap = new Map(body.blocks.map((block) => [block.label, block]));
    const ssaBlocks = new Map<string, MutableSsaBlock>();
    const phiInputsByBlock = new Map<string, Map<string, SsaPhiInput[]>>();
    const versionCounters = new Map<string, number>();
    const { stacks, entryBindings } = createInitialStacks(body, params);

    function nextVersion(name: string): string {
        const current = (versionCounters.get(name) ?? 0) + 1;
        versionCounters.set(name, current);
        const value = `${name}#${current}`;
        const stack = stacks.get(name) ?? [];
        stack.push(value);
        stacks.set(name, stack);
        return value;
    }

    function renameBlock(label: string): void {
        const block = blockMap.get(label);
        if (!block) {
            throw new Error(`ssa rename: missing block '${label}'`);
        }
        const pushedNames: string[] = [];
        const rawPhiNodes = Array.from(phiByBlock.get(label)?.values() ?? []).sort((left, right) => left.variable.localeCompare(right.variable));
        const phiNodes: MutablePhiNode[] = rawPhiNodes.map((phi) => {
            const target = nextVersion(phi.variable);
            pushedNames.push(phi.variable);
            return {
                variable: phi.variable,
                target,
                sources: [...(phiInputsByBlock.get(label)?.get(phi.variable) ?? [])]
            };
        });

        const statements: SsaStatement[] = [];
        const statementSourceIndexes: number[] = [];
        for (const [index, statement] of block.statements.entries()) {
            const renamed = renameStatement(statement, stacks, nextVersion);
            statements.push(renamed.statement);
            statementSourceIndexes.push(index);
            if (renamed.pushed) {
                pushedNames.push(renamed.pushed);
            }
        }
        const terminator = renameTerminator(block.terminator, stacks);

        ssaBlocks.set(label, {
            label,
            predecessors: [...(analysis.predecessorMap.get(label) ?? [])],
            immediateDominator: analysis.immediateDominatorMap.get(label) ?? null,
            dominanceFrontier: [...(analysis.dominanceFrontierMap.get(label) ?? [])],
            phiNodes,
            statements,
            statementSourceIndexes,
            terminator
        });

        for (const successor of successorLabels(block)) {
            const inputMap = phiInputsByBlock.get(successor) ?? new Map<string, SsaPhiInput[]>();
            phiInputsByBlock.set(successor, inputMap);
            const successorPhis = Array.from(phiByBlock.get(successor)?.values() ?? []).sort((left, right) => left.variable.localeCompare(right.variable));
            successorPhis.forEach((phi) => {
                const stack = stacks.get(phi.variable);
                if (!stack || stack.length === 0) {
                    throw new Error(`ssa rename: missing phi source version for '${phi.variable}'`);
                }
                const sources = inputMap.get(phi.variable) ?? [];
                sources.push({ predecessor: label, value: { kind: "local", name: stack[stack.length - 1] } });
                inputMap.set(phi.variable, sources);
            });
            const existingSuccessorBlock = ssaBlocks.get(successor);
            if (existingSuccessorBlock) {
                existingSuccessorBlock.phiNodes = existingSuccessorBlock.phiNodes.map((phi) => ({
                    ...phi,
                    sources: [...(inputMap.get(phi.variable) ?? [])]
                }));
            }
        }

        for (const child of analysis.dominatorChildrenMap.get(label) ?? []) {
            renameBlock(child);
        }

        for (let index = pushedNames.length - 1; index >= 0; index -= 1) {
            const name = pushedNames[index];
            const stack = stacks.get(name);
            stack?.pop();
        }
    }

    renameBlock(body.entryLabel);

    const blocks = body.blocks.map((block) => {
        const ssaBlock = ssaBlocks.get(block.label);
        if (!ssaBlock) {
            throw new Error(`ssa build: failed to materialize block '${block.label}'`);
        }
        return {
            ...ssaBlock,
            phiNodes: ssaBlock.phiNodes.map((phi): SsaPhiNode => ({
                variable: phi.variable,
                target: phi.target,
                sources: [...phi.sources].sort((left, right) => left.predecessor.localeCompare(right.predecessor))
            }))
        };
    });

    return {
        entryLabel: body.entryLabel,
        locals: body.locals,
        entryBindings,
        blocks
    };
}

function lowerFunctionToSsa(fn: CfgFunctionDefinition): SsaFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: buildSsaBody(fn.body, fn.params),
        origin: fn.origin
    };
}

export function buildSsaPass(program: CfgProgram): SsaProgram {
    return {
        kind: "ssa_program",
        entry: buildSsaBody(program.entry, program.metadata.entryParams),
        globals: program.globals,
        functions: program.functions.map((fn) => lowerFunctionToSsa(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
