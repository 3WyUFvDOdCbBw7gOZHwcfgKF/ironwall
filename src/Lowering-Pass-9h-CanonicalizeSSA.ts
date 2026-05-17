import type {
    LinearOperand,
    LinearRvalue,
    SsaBody,
    SsaFunctionDefinition,
    SsaOperand,
    SsaPhiInput,
    SsaPhiNode,
    SsaProgram,
    SsaStatement,
    SsaTerminator
} from "./Lowering-Frontend-Shared";

function baseName(name: string): string {
    const hashIndex = name.indexOf("#");
    return hashIndex >= 0 ? name.slice(0, hashIndex) : name;
}

function isSyntheticLocalName(name: string): boolean {
    return baseName(name).startsWith("__iw_");
}

function cloneOperand(operand: SsaOperand): SsaOperand {
    switch (operand.kind) {
        case "local":
            return { kind: "local", name: operand.name };
        case "number_literal":
            return { kind: "number_literal", value: operand.value, typeName: operand.typeName };
        case "text_literal":
            return {
                kind: "text_literal",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
        case "direct_function":
            return { kind: "direct_function", symbol: operand.symbol };
    }
}

function operandKey(operand: SsaOperand): string {
    switch (operand.kind) {
        case "local":
            return `local:${operand.name}`;
        case "number_literal":
            return `number:${operand.typeName}:${operand.value}`;
        case "text_literal":
            return `text:${operand.typeName}:${operand.referenceName}:${operand.content}`;
        case "direct_function":
            return `direct_function:${operand.symbol}`;
    }
}

function resolveOperand(operand: SsaOperand, substitutions: ReadonlyMap<string, SsaOperand>): SsaOperand {
    if (operand.kind !== "local") {
        return cloneOperand(operand);
    }
    let current: SsaOperand = operand;
    const visited = new Set<string>();
    while (current.kind === "local" && substitutions.has(current.name) && !visited.has(current.name)) {
        visited.add(current.name);
        current = substitutions.get(current.name) ?? current;
    }
    return cloneOperand(current);
}

function mapRvalueOperands(value: LinearRvalue, substitutions: ReadonlyMap<string, SsaOperand>): LinearRvalue {
    switch (value.kind) {
        case "copy":
            return { kind: "copy", value: resolveOperand(value.value, substitutions) };
        case "object_alloc":
            return { kind: "object_alloc", className: value.className };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: resolveOperand(value.receiver, substitutions),
                className: value.className,
                fieldName: value.fieldName
            };
        case "slot_load":
            return {
                kind: "slot_load",
                receiver: resolveOperand(value.receiver, substitutions),
                className: value.className,
                slotName: value.slotName
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId,
                value: resolveOperand(value.value, substitutions)
            };
        case "union_has_tag":
            return {
                kind: "union_has_tag",
                unionValue: resolveOperand(value.unionValue, substitutions),
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId
            };
        case "union_get_payload":
            return {
                kind: "union_get_payload",
                unionValue: resolveOperand(value.unionValue, substitutions),
                unionTypeTagId: value.unionTypeTagId,
                memberTypeTagId: value.memberTypeTagId
            };
        case "closure_create":
            return {
                kind: "closure_create",
                closureId: value.closureId,
                applySymbol: value.applySymbol,
                environmentLayout: value.environmentLayout,
                captures: value.captures.map((capture) => resolveOperand(capture, substitutions))
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: value.symbol,
                args: value.args.map((arg) => resolveOperand(arg, substitutions))
            };
        case "closure_call":
            return {
                kind: "closure_call",
                callee: resolveOperand(value.callee, substitutions),
                args: value.args.map((arg) => resolveOperand(arg, substitutions))
            };
    }
}

function canonicalizeStatement(statement: SsaStatement, substitutions: ReadonlyMap<string, SsaOperand>): SsaStatement {
    switch (statement.kind) {
        case "assign":
            return {
                kind: "assign",
                target: statement.target,
                value: mapRvalueOperands(statement.value, substitutions)
            };
        case "set_local":
            return {
                kind: "set_local",
                target: statement.target,
                value: resolveOperand(statement.value, substitutions)
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: resolveOperand(statement.receiver, substitutions),
                className: statement.className,
                fieldName: statement.fieldName,
                value: resolveOperand(statement.value, substitutions)
            };
        case "slot_store":
            return {
                kind: "slot_store",
                receiver: resolveOperand(statement.receiver, substitutions),
                className: statement.className,
                slotName: statement.slotName,
                value: resolveOperand(statement.value, substitutions)
            };
    }
}

function canonicalizeTerminator(terminator: SsaTerminator, substitutions: ReadonlyMap<string, SsaOperand>): SsaTerminator {
    switch (terminator.kind) {
        case "return":
            return { kind: "return", value: resolveOperand(terminator.value, substitutions) };
        case "jump":
            return { kind: "jump", target: terminator.target };
        case "branch":
            return {
                kind: "branch",
                cond: resolveOperand(terminator.cond, substitutions),
                trueTarget: terminator.trueTarget,
                falseTarget: terminator.falseTarget
            };
    }
}

function collectSubstitutions(body: SsaBody, globalSymbols: ReadonlySet<string>): Map<string, SsaOperand> {
    const substitutions = new Map<string, SsaOperand>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const block of body.blocks) {
            for (const phi of block.phiNodes) {
                const resolvedSources = phi.sources.map((source) => resolveOperand(source.value, substitutions));
                if (resolvedSources.length === 0) {
                    continue;
                }
                const firstKey = operandKey(resolvedSources[0]);
                if (resolvedSources.every((source) => operandKey(source) === firstKey)) {
                    const next = resolvedSources[0];
                    if (operandKey(resolveOperand({ kind: "local", name: phi.target }, substitutions)) !== operandKey(next)) {
                        substitutions.set(phi.target, next);
                        changed = true;
                    }
                }
            }
            for (const statement of block.statements) {
                if (statement.kind === "assign" && statement.value.kind === "copy") {
                    const resolved = resolveOperand(statement.value.value, substitutions);
                    if (operandKey(resolveOperand({ kind: "local", name: statement.target }, substitutions)) !== operandKey(resolved)) {
                        substitutions.set(statement.target, resolved);
                        changed = true;
                    }
                    continue;
                }
                if (statement.kind === "set_local") {
                    if (globalSymbols.has(baseName(statement.target))) {
                        continue;
                    }
                    const resolved = resolveOperand(statement.value, substitutions);
                    if (operandKey(resolveOperand({ kind: "local", name: statement.target }, substitutions)) !== operandKey(resolved)) {
                        substitutions.set(statement.target, resolved);
                        changed = true;
                    }
                }
            }
        }
    }
    return substitutions;
}

function canonicalizeBody(body: SsaBody, globalSymbols: ReadonlySet<string>): SsaBody {
    const substitutions = collectSubstitutions(body, globalSymbols);
    return {
        ...body,
        blocks: body.blocks.map((block) => {
            const keptStatements: SsaStatement[] = [];
            const keptSourceIndexes: number[] = [];
            block.statements.forEach((statement, index) => {
                const canonical = canonicalizeStatement(statement, substitutions);
                const isGlobalSetLocal = canonical.kind === "set_local" && globalSymbols.has(baseName(canonical.target));
                const shouldDrop =
                    (canonical.kind === "assign" && canonical.value.kind === "copy" && isSyntheticLocalName(canonical.target) && substitutions.has(canonical.target))
                    || (canonical.kind === "set_local" && !isGlobalSetLocal && isSyntheticLocalName(canonical.target) && substitutions.has(canonical.target));
                if (!shouldDrop) {
                    keptStatements.push(canonical);
                    keptSourceIndexes.push(block.statementSourceIndexes[index] ?? index);
                }
            });
            return {
                ...block,
                phiNodes: block.phiNodes
                    .map((phi): SsaPhiNode => ({
                        ...phi,
                        sources: phi.sources.map((source): SsaPhiInput => ({
                            predecessor: source.predecessor,
                            value: resolveOperand(source.value, substitutions)
                        }))
                    }))
                    .filter((phi) => !substitutions.has(phi.target)),
                statements: keptStatements,
                statementSourceIndexes: keptSourceIndexes,
                terminator: canonicalizeTerminator(block.terminator, substitutions)
            };
        })
    };
}

function canonicalizeFunction(fn: SsaFunctionDefinition, globalSymbols: ReadonlySet<string>): SsaFunctionDefinition {
    return {
        ...fn,
        body: canonicalizeBody(fn.body, globalSymbols)
    };
}

function successorLabels(terminator: SsaTerminator): readonly string[] {
    switch (terminator.kind) {
        case "return":
            return [];
        case "jump":
            return [terminator.target];
        case "branch":
            return [terminator.trueTarget, terminator.falseTarget];
    }
}

function collectUsedLocalsFromOperand(operand: LinearOperand): readonly string[] {
    return operand.kind === "local" ? [operand.name] : [];
}

function collectUsedLocalsFromRvalue(value: LinearRvalue): readonly string[] {
    switch (value.kind) {
        case "copy":
            return collectUsedLocalsFromOperand(value.value);
        case "object_alloc":
            return [];
        case "object_get_field":
        case "slot_load":
            return collectUsedLocalsFromOperand(value.receiver);
        case "union_inject":
            return collectUsedLocalsFromOperand(value.value);
        case "union_has_tag":
        case "union_get_payload":
            return collectUsedLocalsFromOperand(value.unionValue);
        case "closure_create":
            return value.captures.flatMap((capture) => collectUsedLocalsFromOperand(capture));
        case "direct_call":
            return value.args.flatMap((arg) => collectUsedLocalsFromOperand(arg));
        case "closure_call":
            return [
                ...collectUsedLocalsFromOperand(value.callee),
                ...value.args.flatMap((arg) => collectUsedLocalsFromOperand(arg))
            ];
    }
}

function validateUsedLocals(names: readonly string[], defined: ReadonlySet<string>, context: string): void {
    for (const name of names) {
        if (!name.includes("#")) {
            continue;
        }
        if (!defined.has(name)) {
            throw new Error(`SSA verification failed: use of undefined local '${name}' in ${context}`);
        }
    }
}

function validateBody(body: SsaBody, params: readonly { readonly name: string }[], context: string, allowedExternalNames: ReadonlySet<string>): void {
    const blockMap = new Map(body.blocks.map((block) => [block.label, block]));
    if (!blockMap.has(body.entryLabel)) {
        throw new Error(`SSA verification failed: missing entry block '${body.entryLabel}' in ${context}`);
    }
    if (blockMap.size !== body.blocks.length) {
        throw new Error(`SSA verification failed: duplicate block labels in ${context}`);
    }

    const predecessorMap = new Map<string, string[]>();
    for (const block of body.blocks) {
        predecessorMap.set(block.label, []);
    }
    for (const block of body.blocks) {
        for (const successor of successorLabels(block.terminator)) {
            const predecessors = predecessorMap.get(successor);
            if (!predecessors) {
                throw new Error(`SSA verification failed: block '${block.label}' jumps to unknown successor '${successor}' in ${context}`);
            }
            predecessors.push(block.label);
        }
    }

    const blockLabels = new Set(body.blocks.map((block) => block.label));
    const idomChildren = new Map<string, string[]>();
    for (const block of body.blocks) {
        idomChildren.set(block.label, []);
    }
    for (const block of body.blocks) {
        const expectedPredecessors = [...(predecessorMap.get(block.label) ?? [])].sort();
        const actualPredecessors = [...block.predecessors].sort();
        if (JSON.stringify(expectedPredecessors) !== JSON.stringify(actualPredecessors)) {
            throw new Error(`SSA verification failed: predecessor mismatch for block '${block.label}' in ${context}`);
        }
        if (block.statementSourceIndexes.length !== block.statements.length) {
            throw new Error(`SSA verification failed: statement source index count mismatch for block '${block.label}' in ${context}`);
        }
        const phiTargets = new Set<string>();
        const expectedPhiPredecessors = [...block.predecessors].sort();
        for (const phi of block.phiNodes) {
            if (phiTargets.has(phi.target)) {
                throw new Error(`SSA verification failed: duplicate phi target '${phi.target}' in block '${block.label}'`);
            }
            phiTargets.add(phi.target);
            const phiPreds = phi.sources.map((source) => source.predecessor).sort();
            if (JSON.stringify(phiPreds) !== JSON.stringify(expectedPhiPredecessors)) {
                throw new Error(`SSA verification failed: phi predecessor mismatch for '${phi.target}' in block '${block.label}'`);
            }
            for (const source of phi.sources) {
                if (!blockLabels.has(source.predecessor)) {
                    throw new Error(`SSA verification failed: phi source from unknown predecessor '${source.predecessor}' in block '${block.label}'`);
                }
            }
        }
        if (block.label === body.entryLabel) {
            if (block.immediateDominator !== null) {
                throw new Error(`SSA verification failed: entry block '${block.label}' must have null immediate dominator`);
            }
        } else {
            if (!block.immediateDominator || !blockLabels.has(block.immediateDominator)) {
                throw new Error(`SSA verification failed: block '${block.label}' has invalid immediate dominator in ${context}`);
            }
            idomChildren.get(block.immediateDominator)?.push(block.label);
        }
    }

    const entryBindingNames = new Set<string>();
    const definedAtEntry = new Set<string>();
    for (const binding of body.entryBindings) {
        if (entryBindingNames.has(binding.value)) {
            throw new Error(`SSA verification failed: duplicate entry binding value '${binding.value}' in ${context}`);
        }
        entryBindingNames.add(binding.value);
        definedAtEntry.add(binding.value);
    }
    const expectedVariables = new Set([...params.map((param) => param.name), ...body.locals]);
    const actualVariables = new Set(body.entryBindings.map((binding) => binding.variable));
    if (JSON.stringify([...expectedVariables].sort()) !== JSON.stringify([...actualVariables].sort())) {
        throw new Error(`SSA verification failed: entry bindings do not match params+locals in ${context}`);
    }
    const allDefinedNames = new Set<string>([...definedAtEntry, ...allowedExternalNames]);
    for (const block of body.blocks) {
        block.phiNodes.forEach((phi) => allDefinedNames.add(phi.target));
        block.statements.forEach((statement) => {
            if (statement.kind === "assign" || statement.kind === "set_local") {
                allDefinedNames.add(statement.target);
            }
        });
    }

    const visited = new Set<string>();
    function walk(label: string, inherited: ReadonlySet<string>): void {
        if (visited.has(label)) {
            return;
        }
        visited.add(label);
        const block = blockMap.get(label);
        if (!block) {
            throw new Error(`SSA verification failed: missing block '${label}' during dominator walk`);
        }
        const available = new Set(inherited);
        for (const phi of block.phiNodes) {
            for (const source of phi.sources) {
                validateUsedLocals(collectUsedLocalsFromOperand(source.value), allDefinedNames, `phi '${phi.target}' source in block '${label}'`);
            }
            available.add(phi.target);
        }
        const statementTargets = new Set<string>();
        for (const statement of block.statements) {
            switch (statement.kind) {
                case "assign":
                    validateUsedLocals(collectUsedLocalsFromRvalue(statement.value), available, `assign '${statement.target}' in block '${label}'`);
                    if (statementTargets.has(statement.target) || available.has(statement.target)) {
                        throw new Error(`SSA verification failed: duplicate SSA target '${statement.target}' in block '${label}'`);
                    }
                    statementTargets.add(statement.target);
                    available.add(statement.target);
                    break;
                case "set_local":
                    validateUsedLocals(collectUsedLocalsFromOperand(statement.value), available, `set_local '${statement.target}' in block '${label}'`);
                    if (statementTargets.has(statement.target) || available.has(statement.target)) {
                        throw new Error(`SSA verification failed: duplicate SSA target '${statement.target}' in block '${label}'`);
                    }
                    statementTargets.add(statement.target);
                    available.add(statement.target);
                    break;
                case "object_set_field":
                case "slot_store":
                    validateUsedLocals(
                        [
                            ...collectUsedLocalsFromOperand(statement.receiver),
                            ...collectUsedLocalsFromOperand(statement.value)
                        ],
                        available,
                        `${statement.kind} in block '${label}'`
                    );
                    break;
            }
        }
        switch (block.terminator.kind) {
            case "return":
                validateUsedLocals(collectUsedLocalsFromOperand(block.terminator.value), available, `return in block '${label}'`);
                break;
            case "jump":
                break;
            case "branch":
                validateUsedLocals(collectUsedLocalsFromOperand(block.terminator.cond), available, `branch in block '${label}'`);
                break;
        }
        for (const child of idomChildren.get(label) ?? []) {
            walk(child, available);
        }
    }

    walk(body.entryLabel, definedAtEntry);
    if (visited.size !== body.blocks.length) {
        throw new Error(`SSA verification failed: dominator walk did not cover all blocks in ${context}`);
    }
}

export function validateSsaProgram(program: SsaProgram): void {
    const allowedExternalNames = new Set(program.globals.map((globalDef) => globalDef.symbol));
    validateBody(program.entry, program.metadata.entryParams, "entry", allowedExternalNames);
    for (const fn of program.functions) {
        validateBody(fn.body, fn.params, `function '${fn.symbol}'`, allowedExternalNames);
    }
}

export function canonicalizeSsaPass(program: SsaProgram): SsaProgram {
    const globalSymbols = new Set(program.globals.map((globalDef) => globalDef.symbol));
    return {
        ...program,
        entry: canonicalizeBody(program.entry, globalSymbols),
        functions: program.functions.map((fn) => canonicalizeFunction(fn, globalSymbols))
    };
}
