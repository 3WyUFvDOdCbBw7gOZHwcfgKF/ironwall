import { GenericCallNode, IdentifierNode, TypeToFromNode, TypeUnionNode } from "./AstNode";
import type {
    ClosureHelperDefinition,
    ClosureConvertedFunctionDefinition,
    ClosureExpr,
    ClosureLetBinding,
    FoldedTypedPrimitiveProgram,
    LoweredBinding,
    LoweringClassLayout,
    ScalarReplacedFreshProgram,
    ScalarReplacedFreshProgramStats
} from "./Lowering-Frontend-Shared";
import { getMonomorphizedClassName, getMonomorphizedFunctionName } from "./Typecheck-Pass-8-Monomorphize";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    GenericFunctionInstanceTypeValue,
    PrimitiveTypeValue,
    UnionTypeValue
} from "./Typecheck-TypeAst";
import type { TypeValue } from "./Typecheck-Core";
import { builtinGenericTypeNames } from "./TypeSystem";

interface ScalarReplaceState {
    tempCounter: number;
    scalarizedObjects: number;
    replacedSlotStores: number;
    replacedSlotLoads: number;
    scalarizedClosures: number;
    rewrittenClosureCalls: number;
    specializedHelpers: Map<string, string>;
    synthesizedFunctions: ClosureConvertedFunctionDefinition[];
}

interface SlotLocalInfo {
    readonly localName: string;
    readonly typeExp: import("./AstNode").AstNode;
    initialized: boolean;
}

interface ConstructorSummary {
    readonly className: string;
    readonly slotToParamIndex: ReadonlyMap<string, number>;
}

interface ObjectFactorySummary {
    readonly paramNames: readonly string[];
    readonly className: string;
    readonly slotTemplates: ReadonlyMap<string, ClosureExpr>;
}

interface ScalarHelperSummary {
    readonly paramNames: readonly string[];
    readonly template: ClosureExpr;
}

interface FreshObjectProducer {
    readonly className: string;
    readonly initialSlotValues: ReadonlyMap<string, ClosureExpr>;
}

interface ClosureSpecializationContext {
    readonly helperByClosureId: ReadonlyMap<string, ClosureHelperDefinition>;
    readonly functionBySymbol: ReadonlyMap<string, ClosureConvertedFunctionDefinition>;
}

interface TemplateEnv {
    readonly scalarValues: ReadonlyMap<string, ClosureExpr>;
    readonly objectValues: ReadonlyMap<string, ClosureExpr>;
}

function typeValueToTypeAst(type: TypeValue): import("./AstNode").AstNode {
    if (type instanceof PrimitiveTypeValue) {
        return new IdentifierNode(type.name);
    }
    if (type instanceof ClassTypeValue) {
        return new IdentifierNode(type.className);
    }
    if (type instanceof FunctionTypeValue) {
        return new TypeToFromNode(
            typeValueToTypeAst(type.returnType),
            type.paramTypes.map((paramType) => typeValueToTypeAst(paramType))
        );
    }
    if (type instanceof UnionTypeValue) {
        return new TypeUnionNode(type.types.map((member) => typeValueToTypeAst(member)));
    }
    if (type instanceof GenericClassInstanceTypeValue && builtinGenericTypeNames.has(type.genericName)) {
        return new GenericCallNode(
            new IdentifierNode(type.genericName),
            type.typeArgs.map((typeArg) => typeValueToTypeAst(typeArg))
        );
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new IdentifierNode(getMonomorphizedClassName(type));
    }
    if (type instanceof GenericFunctionInstanceTypeValue) {
        return new IdentifierNode(getMonomorphizedFunctionName(type));
    }
    throw new Error("Pass 8c scalar replacement failed: unsupported slot type");
}

function containsIdentifier(expr: ClosureExpr, name: string): boolean {
    switch (expr.kind) {
        case "identifier":
            return expr.name === name;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return false;
        case "let":
            return expr.bindings.some((binding) => containsIdentifier(binding.value, name)) || containsIdentifier(expr.body, name);
        case "if":
            return containsIdentifier(expr.condExpr, name) || containsIdentifier(expr.trueBranchExpr, name) || containsIdentifier(expr.falseBranchExpr, name);
        case "while":
            return containsIdentifier(expr.condExpr, name) || containsIdentifier(expr.bodyExpr, name);
        case "seq":
            return expr.expressions.some((inner) => containsIdentifier(inner, name));
        case "set_local":
            return expr.identifier === name || containsIdentifier(expr.value, name);
        case "direct_call":
            return expr.args.some((arg) => containsIdentifier(arg, name));
        case "object_get_field":
            return containsIdentifier(expr.receiver, name);
        case "object_set_field":
            return containsIdentifier(expr.receiver, name) || containsIdentifier(expr.value, name);
        case "slot_load":
            return containsIdentifier(expr.receiver, name);
        case "slot_store":
            return containsIdentifier(expr.receiver, name) || containsIdentifier(expr.value, name);
        case "union_inject":
            return containsIdentifier(expr.value, name);
        case "closure_create":
            return expr.captures.some((capture) => containsIdentifier(capture, name));
        case "closure_call":
            return containsIdentifier(expr.callee, name) || expr.args.some((arg) => containsIdentifier(arg, name));
        case "match":
            return containsIdentifier(expr.unionExpr, name) || expr.branches.some((branch) => containsIdentifier(branch.body, name));
    }
}

function isScalarizableReceiver(expr: ClosureExpr, objectName: string, className: string): boolean {
    return expr.kind === "identifier" && expr.name === objectName && className.length > 0;
}

interface ProducerRewriteResult {
    readonly expr: ClosureExpr;
    readonly changed: boolean;
}

function substituteKnownScalarExpr(expr: ClosureExpr, env: ReadonlyMap<string, ClosureExpr>): ClosureExpr | undefined {
    switch (expr.kind) {
        case "identifier":
            return env.get(expr.name) ?? expr;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return expr;
        case "let": {
            const localEnv = new Map(env);
            for (const binding of expr.bindings) {
                const value = substituteKnownScalarExpr(binding.value, localEnv);
                if (!value) {
                    return undefined;
                }
                localEnv.set(binding.bind.name, value);
            }
            return substituteKnownScalarExpr(expr.body, localEnv);
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const rewritten = substituteKnownScalarExpr(arg, env);
                if (!rewritten) {
                    return undefined;
                }
                args.push(rewritten);
            }
            return { kind: "direct_call", symbol: expr.symbol, args };
        }
        case "object_get_field": {
            const receiver = substituteKnownScalarExpr(expr.receiver, env);
            return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
        }
        case "slot_load": {
            const receiver = substituteKnownScalarExpr(expr.receiver, env);
            return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
        }
        case "union_inject": {
            const value = substituteKnownScalarExpr(expr.value, env);
            return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
        }
        case "object_alloc":
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            return undefined;
    }
}

function rewriteKnownProducerExpr(expr: ClosureExpr, env: ReadonlyMap<string, ClosureExpr>): ProducerRewriteResult | undefined {
    switch (expr.kind) {
        case "identifier": {
            const substituted = env.get(expr.name);
            return { expr: substituted ?? expr, changed: substituted !== undefined };
        }
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return { expr, changed: false };
        case "let": {
            const localEnv = new Map(env);
            const preservedBindings: ClosureLetBinding[] = [];
            let changed = false;
            for (const binding of expr.bindings) {
                const scalarValue = substituteKnownScalarExpr(binding.value, localEnv);
                if (scalarValue) {
                    localEnv.set(binding.bind.name, scalarValue);
                    changed = true;
                    continue;
                }
                const rewrittenValue = rewriteKnownProducerExpr(binding.value, localEnv);
                if (!rewrittenValue) {
                    return undefined;
                }
                preservedBindings.push({
                    bind: binding.bind,
                    value: rewrittenValue.expr
                });
                changed = changed || rewrittenValue.changed;
            }
            const body = rewriteKnownProducerExpr(expr.body, localEnv);
            if (!body) {
                return undefined;
            }
            return {
                expr: preservedBindings.length > 0 ? { kind: "let", bindings: preservedBindings, body: body.expr } : body.expr,
                changed: changed || body.changed || preservedBindings.length !== expr.bindings.length
            };
        }
        case "seq": {
            const expressions: ClosureExpr[] = [];
            let changed = false;
            for (const inner of expr.expressions) {
                const rewritten = rewriteKnownProducerExpr(inner, env);
                if (!rewritten) {
                    return undefined;
                }
                expressions.push(rewritten.expr);
                changed = changed || rewritten.changed;
            }
            return { expr: { kind: "seq", expressions }, changed };
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            let changed = false;
            for (const arg of expr.args) {
                const rewritten = rewriteKnownProducerExpr(arg, env);
                if (!rewritten) {
                    return undefined;
                }
                args.push(rewritten.expr);
                changed = changed || rewritten.changed;
            }
            return { expr: { kind: "direct_call", symbol: expr.symbol, args }, changed };
        }
        case "object_get_field": {
            const receiver = rewriteKnownProducerExpr(expr.receiver, env);
            return receiver ? { expr: { kind: "object_get_field", receiver: receiver.expr, className: expr.className, fieldName: expr.fieldName }, changed: receiver.changed } : undefined;
        }
        case "slot_load": {
            const receiver = rewriteKnownProducerExpr(expr.receiver, env);
            return receiver ? { expr: { kind: "slot_load", receiver: receiver.expr, className: expr.className, slotName: expr.slotName }, changed: receiver.changed } : undefined;
        }
        case "slot_store": {
            const receiver = rewriteKnownProducerExpr(expr.receiver, env);
            const value = rewriteKnownProducerExpr(expr.value, env);
            return receiver && value
                ? {
                    expr: { kind: "slot_store", receiver: receiver.expr, className: expr.className, slotName: expr.slotName, value: value.expr },
                    changed: receiver.changed || value.changed
                }
                : undefined;
        }
        case "union_inject": {
            const value = rewriteKnownProducerExpr(expr.value, env);
            return value
                ? {
                    expr: { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value: value.expr },
                    changed: value.changed
                }
                : undefined;
        }
        case "if":
        case "while":
        case "set_local":
        case "object_set_field":
        case "closure_create":
        case "closure_call":
        case "match":
            return undefined;
    }
}

function summarizeConstructor(fn: ClosureConvertedFunctionDefinition): ConstructorSummary | undefined {
    if (fn.origin.kind !== "constructor" || fn.params.length === 0) {
        return undefined;
    }
    const selfName = fn.params[0].name;
    const paramIndices = new Map(fn.params.map((param, index) => [param.name, index] as const));
    const summaryEntries: [string, number][] = [];
    const pushStore = (expr: ClosureExpr): boolean => {
        if (expr.kind !== "slot_store") {
            return false;
        }
        if (expr.receiver.kind !== "identifier" || expr.receiver.name !== selfName || expr.value.kind !== "identifier") {
            return false;
        }
        const paramIndex = paramIndices.get(expr.value.name);
        if (paramIndex === undefined || paramIndex === 0) {
            return false;
        }
        summaryEntries.push([expr.slotName, paramIndex]);
        return true;
    };
    if (fn.body.kind === "slot_store") {
        if (!pushStore(fn.body)) {
            return undefined;
        }
    } else if (fn.body.kind === "seq") {
        for (const expr of fn.body.expressions) {
            if (!pushStore(expr)) {
                return undefined;
            }
        }
    } else {
        return undefined;
    }
    return {
        className: fn.origin.className ?? "",
        slotToParamIndex: new Map(summaryEntries)
    };
}

function analyzeFreshObjectProducer(
    expr: ClosureExpr,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): FreshObjectProducer | undefined {
    if (expr.kind === "object_alloc") {
        return {
            className: expr.className,
            initialSlotValues: new Map()
        };
    }
    if (expr.kind === "direct_call") {
        const summary = objectFactorySummaries.get(expr.symbol);
        if (!summary) {
            return undefined;
        }
        const initialSlotValues = instantiateTemplateMap(summary.paramNames, summary.slotTemplates, expr.args);
        if (!initialSlotValues) {
            return undefined;
        }
        const foldedSlotValues = new Map<string, ClosureExpr>();
        initialSlotValues.forEach((value, slotName) => {
            foldedSlotValues.set(slotName, foldObjectProducerSlotLoads(value, constructorSummaries, objectFactorySummaries));
        });
        return { className: summary.className, initialSlotValues: foldedSlotValues };
    }
    if (expr.kind === "let") {
        const rewritten = rewriteKnownProducerExpr(expr, new Map());
        if (rewritten && rewritten.changed) {
            return analyzeFreshObjectProducer(rewritten.expr, constructorSummaries, objectFactorySummaries);
        }
    }
    if (expr.kind !== "let" || expr.bindings.length !== 1 || expr.bindings[0].value.kind !== "object_alloc") {
        return undefined;
    }
    const tempName = expr.bindings[0].bind.name;
    const className = expr.bindings[0].value.className;
    if (expr.body.kind !== "seq" || expr.body.expressions.length < 2) {
        return undefined;
    }
    const finalExpr = expr.body.expressions[expr.body.expressions.length - 1];
    if (finalExpr.kind !== "identifier" || finalExpr.name !== tempName) {
        return undefined;
    }
    const initialSlotValues = new Map<string, ClosureExpr>();
    for (const step of expr.body.expressions.slice(0, -1)) {
        if (step.kind === "direct_call" && step.args.length > 0) {
            const receiverArg = step.args[0];
            if (receiverArg.kind !== "identifier" || receiverArg.name !== tempName) {
                return undefined;
            }
            const summary = constructorSummaries.get(step.symbol);
            if (!summary || summary.className !== className) {
                return undefined;
            }
            summary.slotToParamIndex.forEach((paramIndex, slotName) => {
                const argValue = step.args[paramIndex];
                if (!argValue || containsIdentifier(argValue, tempName)) {
                    throw new Error("Pass 8c scalar replacement failed: invalid constructor summary application");
                }
                initialSlotValues.set(slotName, argValue);
            });
            continue;
        }
        if (step.kind === "slot_store") {
            if (step.receiver.kind !== "identifier" || step.receiver.name !== tempName || step.className !== className || containsIdentifier(step.value, tempName)) {
                return undefined;
            }
            initialSlotValues.set(step.slotName, step.value);
            continue;
        }
        return undefined;
    }
    return {
        className,
        initialSlotValues
    };
}

function foldObjectProducerSlotLoads(
    expr: ClosureExpr,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => foldObjectProducerSlotLoads(arg, constructorSummaries, objectFactorySummaries))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: foldObjectProducerSlotLoads(expr.receiver, constructorSummaries, objectFactorySummaries),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "slot_load": {
            const receiver = foldObjectProducerSlotLoads(expr.receiver, constructorSummaries, objectFactorySummaries);
            const producer = analyzeFreshObjectProducer(receiver, constructorSummaries, objectFactorySummaries);
            if (producer && producer.className === expr.className) {
                const slotValue = producer.initialSlotValues.get(expr.slotName);
                if (slotValue) {
                    return foldObjectProducerSlotLoads(slotValue, constructorSummaries, objectFactorySummaries);
                }
            }
            return { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName };
        }
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: foldObjectProducerSlotLoads(expr.value, constructorSummaries, objectFactorySummaries)
            };
        case "let":
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            return expr;
    }
}

function instantiateTemplateMap(
    paramNames: readonly string[],
    templateMap: ReadonlyMap<string, ClosureExpr>,
    args: readonly ClosureExpr[]
): Map<string, ClosureExpr> | undefined {
    if (paramNames.length !== args.length) {
        return undefined;
    }
    const argMap = new Map<string, ClosureExpr>();
    for (let index = 0; index < paramNames.length; index += 1) {
        argMap.set(paramNames[index], args[index]);
    }
    const instantiated = new Map<string, ClosureExpr>();
    templateMap.forEach((template, name) => {
        instantiated.set(name, instantiateTemplateExpr(template, argMap));
    });
    return instantiated;
}

function isTemplateSafeExpr(expr: ClosureExpr, allowedNames: ReadonlySet<string>): boolean {
    switch (expr.kind) {
        case "identifier":
            return allowedNames.has(expr.name);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return true;
        case "direct_call":
            return !expr.symbol.includes("_clang_") && expr.args.every((arg) => isTemplateSafeExpr(arg, allowedNames));
        case "object_get_field":
            return isTemplateSafeExpr(expr.receiver, allowedNames);
        case "slot_load":
            return isTemplateSafeExpr(expr.receiver, allowedNames);
        case "union_inject":
            return isTemplateSafeExpr(expr.value, allowedNames);
        case "object_alloc":
        case "let":
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            return false;
    }
}

function isPureTemplateDirectCallSymbol(symbol: string): boolean {
    return symbol.startsWith("__iw_builtin_")
        || symbol === "iw_i5_to_f5"
        || symbol === "iw_sin_f5"
        || symbol === "iw_cos_f5"
        || symbol === "iw_sqrt_f5"
        || symbol === "iw_atan2_f5";
}

function normalizePureTemplateExpr(
    expr: ClosureExpr,
    env: TemplateEnv,
    allowedNames: ReadonlySet<string>,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    switch (expr.kind) {
        case "identifier":
            return env.scalarValues.get(expr.name) ?? env.objectValues.get(expr.name) ?? (allowedNames.has(expr.name) ? expr : undefined);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
            return expr;
        case "let": {
            const localScalars = new Map(env.scalarValues);
            const localObjects = new Map(env.objectValues);
            for (const binding of expr.bindings) {
                const value = normalizePureTemplateExpr(binding.value, { scalarValues: localScalars, objectValues: localObjects }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                if (value) {
                    localScalars.set(binding.bind.name, value);
                    continue;
                }
                const producerExpr = substituteProducerExpr(binding.value, { scalarValues: localScalars, objectValues: localObjects }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                const producer = producerExpr ? analyzeFreshObjectProducer(producerExpr, constructorSummaries, objectFactorySummaries) : undefined;
                if (!producer) {
                    return undefined;
                }
                localObjects.set(binding.bind.name, producerExpr!);
            }
            return normalizePureTemplateExpr(expr.body, { scalarValues: localScalars, objectValues: localObjects }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const normalized = normalizePureTemplateExpr(arg, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                if (!normalized) {
                    return undefined;
                }
                args.push(normalized);
            }
            if (isPureTemplateDirectCallSymbol(expr.symbol)) {
                return { kind: "direct_call", symbol: expr.symbol, args };
            }
            const scalarSummary = scalarHelperSummaries.get(expr.symbol);
            if (!scalarSummary) {
                return undefined;
            }
            const instantiated = instantiateTemplateMap(scalarSummary.paramNames, new Map([["$result", scalarSummary.template]]), args)?.get("$result");
            return instantiated ? normalizePureTemplateExpr(instantiated, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
        }
        case "object_get_field": {
            const receiver = normalizePureTemplateExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
        }
        case "slot_load": {
            if (expr.receiver.kind === "identifier") {
                const producerExpr = env.objectValues.get(expr.receiver.name);
                const producer = producerExpr ? analyzeFreshObjectProducer(producerExpr, constructorSummaries, objectFactorySummaries) : undefined;
                if (producer && producer.className === expr.className) {
                    const slotValue = producer.initialSlotValues.get(expr.slotName);
                    return slotValue ? normalizePureTemplateExpr(slotValue, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
                }
            }
            const producerReceiver = substituteProducerExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            if (producerReceiver) {
                const producer = analyzeFreshObjectProducer(producerReceiver, constructorSummaries, objectFactorySummaries);
                if (producer && producer.className === expr.className) {
                    const slotValue = producer.initialSlotValues.get(expr.slotName);
                    return slotValue ? normalizePureTemplateExpr(slotValue, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
                }
            }
            const receiver = normalizePureTemplateExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            if (receiver) {
                const producer = analyzeFreshObjectProducer(receiver, constructorSummaries, objectFactorySummaries);
                if (producer && producer.className === expr.className) {
                    const slotValue = producer.initialSlotValues.get(expr.slotName);
                    return slotValue ? normalizePureTemplateExpr(slotValue, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
                }
            }
            return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
        }
        case "union_inject": {
            const value = normalizePureTemplateExpr(expr.value, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
        }
        case "object_alloc":
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            return undefined;
    }
}

function substituteProducerExpr(
    expr: ClosureExpr,
    env: TemplateEnv,
    allowedNames: ReadonlySet<string>,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    switch (expr.kind) {
        case "identifier":
            return env.scalarValues.get(expr.name) ?? env.objectValues.get(expr.name) ?? (allowedNames.has(expr.name) ? expr : undefined);
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let": {
            const localScalars = new Map(env.scalarValues);
            const localObjects = new Map(env.objectValues);
            const preservedBindings: ClosureLetBinding[] = [];
            const preservedNames = new Set<string>();
            for (const binding of expr.bindings) {
                if (binding.value.kind === "object_alloc") {
                    preservedBindings.push(binding);
                    preservedNames.add(binding.bind.name);
                    continue;
                }
                const value = normalizePureTemplateExpr(binding.value, { scalarValues: localScalars, objectValues: localObjects }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                if (value) {
                    localScalars.set(binding.bind.name, value);
                    continue;
                }
                const producerExpr = substituteProducerExpr(binding.value, { scalarValues: localScalars, objectValues: localObjects }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                const producer = producerExpr ? analyzeFreshObjectProducer(producerExpr, constructorSummaries, objectFactorySummaries) : undefined;
                if (!producer) {
                    return undefined;
                }
                localObjects.set(binding.bind.name, producerExpr!);
            }
            const body = substituteProducerExpr(expr.body, { scalarValues: localScalars, objectValues: localObjects }, new Set([...allowedNames, ...preservedNames]), constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            if (!body) {
                return undefined;
            }
            return preservedBindings.length > 0 ? { kind: "let", bindings: preservedBindings, body } : body;
        }
        case "seq": {
            const expressions: ClosureExpr[] = [];
            for (const inner of expr.expressions) {
                const rewritten = substituteProducerExpr(inner, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                if (!rewritten) {
                    return undefined;
                }
                expressions.push(rewritten);
            }
            return { kind: "seq", expressions };
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const normalized = normalizePureTemplateExpr(arg, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
                if (!normalized) {
                    return undefined;
                }
                args.push(normalized);
            }
            return { kind: "direct_call", symbol: expr.symbol, args };
        }
        case "slot_store": {
            const receiver = substituteProducerExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            const value = normalizePureTemplateExpr(expr.value, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return receiver && value ? { kind: "slot_store", receiver, className: expr.className, slotName: expr.slotName, value } : undefined;
        }
        case "object_get_field": {
            const receiver = normalizePureTemplateExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
        }
        case "slot_load": {
            if (expr.receiver.kind === "identifier") {
                const producerExpr = env.objectValues.get(expr.receiver.name);
                const producer = producerExpr ? analyzeFreshObjectProducer(producerExpr, constructorSummaries, objectFactorySummaries) : undefined;
                if (producer && producer.className === expr.className) {
                    const slotValue = producer.initialSlotValues.get(expr.slotName);
                    return slotValue ? normalizePureTemplateExpr(slotValue, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
                }
            }
            const producerReceiver = substituteProducerExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            if (producerReceiver) {
                const producer = analyzeFreshObjectProducer(producerReceiver, constructorSummaries, objectFactorySummaries);
                if (producer && producer.className === expr.className) {
                    const slotValue = producer.initialSlotValues.get(expr.slotName);
                    return slotValue ? normalizePureTemplateExpr(slotValue, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
                }
            }
            const receiver = normalizePureTemplateExpr(expr.receiver, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
        }
        case "union_inject": {
            const value = normalizePureTemplateExpr(expr.value, env, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
        }
        case "if":
        case "while":
        case "set_local":
        case "object_set_field":
        case "closure_create":
        case "closure_call":
        case "match":
            return undefined;
    }
}

function instantiateTemplateExpr(expr: ClosureExpr, argMap: ReadonlyMap<string, ClosureExpr>): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
            return argMap.get(expr.name) ?? expr;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => instantiateTemplateExpr(arg, argMap))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: instantiateTemplateExpr(expr.receiver, argMap),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "slot_load":
            return {
                kind: "slot_load",
                receiver: instantiateTemplateExpr(expr.receiver, argMap),
                className: expr.className,
                slotName: expr.slotName
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: instantiateTemplateExpr(expr.value, argMap)
            };
        case "let":
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            throw new Error("Pass 8c scalar replacement failed: unsupported object factory template");
    }
}

function summarizeObjectFactory(
    fn: ClosureConvertedFunctionDefinition,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>
): ObjectFactorySummary | undefined {
    if (fn.origin.kind === "constructor") {
        return undefined;
    }
    const allowedNames = new Set(fn.params.map((param) => param.name));
    const rewrittenBody = substituteProducerExpr(fn.body, { scalarValues: new Map(), objectValues: new Map() }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
    if (!rewrittenBody) {
        return undefined;
    }
    const producer = analyzeFreshObjectProducer(rewrittenBody, constructorSummaries, objectFactorySummaries);
    if (!producer) {
        return undefined;
    }
    for (const value of producer.initialSlotValues.values()) {
        if (!isTemplateSafeExpr(value, allowedNames)) {
            return undefined;
        }
    }
    return {
        paramNames: fn.params.map((param) => param.name),
        className: producer.className,
        slotTemplates: new Map(producer.initialSlotValues)
    };
}

function summarizeScalarHelper(
    fn: ClosureConvertedFunctionDefinition,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ScalarHelperSummary | undefined {
    if (fn.origin.kind === "constructor") {
        return undefined;
    }
    const allowedNames = new Set(fn.params.map((param) => param.name));
    const template = normalizePureTemplateExpr(fn.body, { scalarValues: new Map(), objectValues: new Map() }, allowedNames, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
    if (!template) {
        return undefined;
    }
    return {
        paramNames: fn.params.map((param) => param.name),
        template
    };
}

function instantiateObjectFactoryProducer(
    summary: ObjectFactorySummary,
    args: readonly ClosureExpr[],
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): FreshObjectProducer | undefined {
    const initialSlotValues = instantiateTemplateMap(summary.paramNames, summary.slotTemplates, args);
    if (!initialSlotValues) {
        return undefined;
    }
    const foldedSlotValues = new Map<string, ClosureExpr>();
    initialSlotValues.forEach((value, slotName) => {
        foldedSlotValues.set(slotName, foldObjectProducerSlotLoads(value, constructorSummaries, objectFactorySummaries));
    });
    return {
        className: summary.className,
        initialSlotValues: foldedSlotValues
    };
}

function substituteProducerIntoExpr(
    expr: ClosureExpr,
    objectName: string,
    producer: FreshObjectProducer,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    switch (expr.kind) {
        case "identifier":
            return expr.name === objectName ? undefined : expr;
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let": {
            const bindings: ClosureLetBinding[] = [];
            for (const binding of expr.bindings) {
                if (binding.bind.name === objectName) {
                    return undefined;
                }
                const value = substituteProducerIntoExpr(binding.value, objectName, producer, constructorSummaries, objectFactorySummaries);
                if (!value) {
                    return undefined;
                }
                bindings.push({ bind: binding.bind, value });
            }
            const body = substituteProducerIntoExpr(expr.body, objectName, producer, constructorSummaries, objectFactorySummaries);
            return body ? { kind: "let", bindings, body } : undefined;
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const rewritten = substituteProducerIntoExpr(arg, objectName, producer, constructorSummaries, objectFactorySummaries);
                if (!rewritten) {
                    return undefined;
                }
                args.push(rewritten);
            }
            return { kind: "direct_call", symbol: expr.symbol, args };
        }
        case "object_get_field": {
            const receiver = substituteProducerIntoExpr(expr.receiver, objectName, producer, constructorSummaries, objectFactorySummaries);
            return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
        }
        case "slot_load":
            if (expr.receiver.kind === "identifier" && expr.receiver.name === objectName && expr.className === producer.className) {
                const slotValue = producer.initialSlotValues.get(expr.slotName);
                return slotValue ? foldObjectProducerSlotLoads(slotValue, constructorSummaries, objectFactorySummaries) : undefined;
            } else {
                const receiver = substituteProducerIntoExpr(expr.receiver, objectName, producer, constructorSummaries, objectFactorySummaries);
                return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
            }
        case "union_inject": {
            const value = substituteProducerIntoExpr(expr.value, objectName, producer, constructorSummaries, objectFactorySummaries);
            return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
        }
        case "if":
        case "while":
        case "seq":
        case "set_local":
        case "object_set_field":
        case "slot_store":
        case "closure_create":
        case "closure_call":
        case "match":
            return undefined;
    }
}

function materializeFreshObjectProducer(
    producer: FreshObjectProducer,
    state: ScalarReplaceState
): ClosureExpr {
    const tempName = `__iw_scalarized_object_${state.tempCounter}`;
    state.tempCounter += 1;
    const expressions: ClosureExpr[] = Array.from(producer.initialSlotValues.entries()).map(([slotName, value]) => ({
        kind: "slot_store",
        receiver: { kind: "identifier", name: tempName },
        className: producer.className,
        slotName,
        value
    }));
    expressions.push({ kind: "identifier", name: tempName });
    return {
        kind: "let",
        bindings: [{
            bind: {
                name: tempName,
                typeExp: new IdentifierNode(producer.className)
            },
            value: { kind: "object_alloc", className: producer.className }
        }],
        body: {
            kind: "seq",
            expressions
        }
    };
}

function rewriteDirectCallUsingScalarizedObject(
    expr: Extract<ClosureExpr, { kind: "direct_call" }>,
    objectName: string,
    producer: FreshObjectProducer,
    state: ScalarReplaceState,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    const scalarSummary = scalarHelperSummaries.get(expr.symbol);
    if (scalarSummary) {
        const instantiated = instantiateTemplateMap(scalarSummary.paramNames, new Map([["$result", scalarSummary.template]]), expr.args)?.get("$result");
        if (!instantiated) {
            return undefined;
        }
        return substituteProducerIntoExpr(instantiated, objectName, producer, constructorSummaries, objectFactorySummaries);
    }
    const objectSummary = objectFactorySummaries.get(expr.symbol);
    if (!objectSummary) {
        return undefined;
    }
    const initialSlotValues = instantiateTemplateMap(objectSummary.paramNames, objectSummary.slotTemplates, expr.args);
    if (!initialSlotValues) {
        return undefined;
    }
    const rewrittenSlotValues = new Map<string, ClosureExpr>();
    for (const [slotName, value] of initialSlotValues.entries()) {
        const rewritten = substituteProducerIntoExpr(value, objectName, producer, constructorSummaries, objectFactorySummaries);
        if (!rewritten) {
            return undefined;
        }
        rewrittenSlotValues.set(slotName, foldObjectProducerSlotLoads(rewritten, constructorSummaries, objectFactorySummaries));
    }
    return materializeFreshObjectProducer({
        className: objectSummary.className,
        initialSlotValues: rewrittenSlotValues
    }, state);
}

function getOrCreateSlotLocal(
    infos: Map<string, SlotLocalInfo>,
    createdBindings: ClosureLetBinding[],
    layout: LoweringClassLayout,
    objectName: string,
    slotName: string,
    initialValue: ClosureExpr,
    state: ScalarReplaceState
): SlotLocalInfo | undefined {
    const existing = infos.get(slotName);
    if (existing) {
        return existing;
    }
    const slotType = layout.propertyTypes.get(slotName);
    if (!slotType) {
        return undefined;
    }
    const localName = `__iw_sroa_${objectName}_${slotName}_${state.tempCounter}`;
    state.tempCounter += 1;
    const info: SlotLocalInfo = {
        localName,
        typeExp: typeValueToTypeAst(slotType),
        initialized: true
    };
    infos.set(slotName, info);
    createdBindings.push({
        bind: {
            name: localName,
            typeExp: info.typeExp
        },
        value: initialValue
    });
    return info;
}

function tryScalarizeFreshObject(
    binding: LoweredBinding,
    producer: FreshObjectProducer,
    body: ClosureExpr,
    layouts: ReadonlyMap<string, LoweringClassLayout>,
    state: ScalarReplaceState,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    const layout = layouts.get(producer.className);
    if (!layout) {
        return undefined;
    }
    const createdBindings: ClosureLetBinding[] = [];
    const slotInfos = new Map<string, SlotLocalInfo>();
    let localReplacedSlotStores = 0;
    let localReplacedSlotLoads = 0;

    for (const slotName of layout.propertyOrder) {
        const initialValue = producer.initialSlotValues.get(slotName);
        if (!initialValue) {
            continue;
        }
        const created = getOrCreateSlotLocal(slotInfos, createdBindings, layout, binding.name, slotName, initialValue, state);
        if (!created) {
            return undefined;
        }
    }

    const rewriteObjectUse = (expr: ClosureExpr, allowElideStore: boolean): ClosureExpr | null | undefined => {
        switch (expr.kind) {
            case "identifier":
                return expr.name === binding.name ? undefined : expr;
            case "number_literal":
            case "text_literal":
            case "direct_function_ref":
            case "object_alloc":
                return expr;
            case "let": {
                const bindings: ClosureLetBinding[] = [];
                for (const innerBinding of expr.bindings) {
                    const value = rewriteObjectUse(innerBinding.value, false);
                    if (!value) {
                        return undefined;
                    }
                    bindings.push({ bind: innerBinding.bind, value });
                }
                const rewrittenBody = rewriteObjectUse(expr.body, false);
                return rewrittenBody ? { kind: "let", bindings, body: rewrittenBody } : undefined;
            }
            case "seq": {
                const expressions: ClosureExpr[] = [];
                for (const inner of expr.expressions) {
                    const rewritten = rewriteObjectUse(inner, true);
                    if (rewritten === undefined) {
                        return undefined;
                    }
                    if (rewritten !== null) {
                        expressions.push(rewritten);
                    }
                }
                return { kind: "seq", expressions };
            }
            case "set_local": {
                const value = rewriteObjectUse(expr.value, false);
                return value ? { kind: "set_local", identifier: expr.identifier, value } : undefined;
            }
            case "direct_call": {
                if (expr.args.some((arg) => arg.kind === "identifier" && arg.name === binding.name)) {
                    const rewrittenViaSummary = rewriteDirectCallUsingScalarizedObject(
                        expr,
                        binding.name,
                        producer,
                        state,
                        constructorSummaries,
                        scalarHelperSummaries,
                        objectFactorySummaries
                    );
                    if (!rewrittenViaSummary) {
                        return undefined;
                    }
                    return rewriteObjectUse(rewrittenViaSummary, false);
                }
                const args: ClosureExpr[] = [];
                for (const arg of expr.args) {
                    const rewritten = rewriteObjectUse(arg, false);
                    if (!rewritten) {
                        return undefined;
                    }
                    args.push(rewritten);
                }
                return { kind: "direct_call", symbol: expr.symbol, args };
            }
            case "object_get_field": {
                const receiver = rewriteObjectUse(expr.receiver, false);
                return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
            }
            case "object_set_field": {
                const receiver = rewriteObjectUse(expr.receiver, false);
                const value = rewriteObjectUse(expr.value, false);
                return receiver && value ? { kind: "object_set_field", receiver, className: expr.className, fieldName: expr.fieldName, value } : undefined;
            }
            case "slot_load": {
                if (isScalarizableReceiver(expr.receiver, binding.name, expr.className)) {
                    const slotInfo = slotInfos.get(expr.slotName);
                    if (!slotInfo || !slotInfo.initialized) {
                        return undefined;
                    }
                    localReplacedSlotLoads += 1;
                    return { kind: "identifier", name: slotInfo.localName };
                }
                const receiver = rewriteObjectUse(expr.receiver, false);
                return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
            }
            case "slot_store": {
                if (isScalarizableReceiver(expr.receiver, binding.name, expr.className)) {
                    if (containsIdentifier(expr.value, binding.name)) {
                        return undefined;
                    }
                    const slotInfo = getOrCreateSlotLocal(slotInfos, createdBindings, layout, binding.name, expr.slotName, expr.value, state);
                    if (!slotInfo) {
                        return undefined;
                    }
                    localReplacedSlotStores += 1;
                    if (createdBindings[createdBindings.length - 1]?.bind.name === slotInfo.localName) {
                        return allowElideStore ? null : undefined;
                    }
                    return {
                        kind: "set_local",
                        identifier: slotInfo.localName,
                        value: expr.value
                    };
                }
                const receiver = rewriteObjectUse(expr.receiver, false);
                const value = rewriteObjectUse(expr.value, false);
                return receiver && value ? { kind: "slot_store", receiver, className: expr.className, slotName: expr.slotName, value } : undefined;
            }
            case "union_inject": {
                const value = rewriteObjectUse(expr.value, false);
                return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
            }
            case "closure_create": {
                const captures: ClosureExpr[] = [];
                for (const capture of expr.captures) {
                    const rewritten = rewriteObjectUse(capture, false);
                    if (!rewritten) {
                        return undefined;
                    }
                    captures.push(rewritten);
                }
                return {
                    kind: "closure_create",
                    closureId: expr.closureId,
                    applySymbol: expr.applySymbol,
                    environmentLayout: expr.environmentLayout,
                    captures
                };
            }
            case "closure_call": {
                const callee = rewriteObjectUse(expr.callee, false);
                const args: ClosureExpr[] = [];
                for (const arg of expr.args) {
                    const rewritten = rewriteObjectUse(arg, false);
                    if (!rewritten) {
                        return undefined;
                    }
                    args.push(rewritten);
                }
                return callee ? { kind: "closure_call", callee, args } : undefined;
            }
            case "if":
            case "while":
            case "match":
                return containsIdentifier(expr, binding.name) ? undefined : expr;
        }
    };

    const rewrittenBody = rewriteObjectUse(body, false);
    if (!rewrittenBody || createdBindings.length === 0) {
        return undefined;
    }

    state.scalarizedObjects += 1;
    state.replacedSlotStores += localReplacedSlotStores;
    state.replacedSlotLoads += localReplacedSlotLoads;
    return {
        kind: "let",
        bindings: createdBindings,
        body: rewrittenBody
    };
}

function rewriteSpecializedClosureBody(expr: ClosureExpr, envParamName: string, environmentLayout: string, captureNames: ReadonlySet<string>): ClosureExpr | undefined {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let": {
            const bindings: ClosureLetBinding[] = [];
            for (const binding of expr.bindings) {
                const value = rewriteSpecializedClosureBody(binding.value, envParamName, environmentLayout, captureNames);
                if (!value) {
                    return undefined;
                }
                bindings.push({ bind: binding.bind, value });
            }
            const body = rewriteSpecializedClosureBody(expr.body, envParamName, environmentLayout, captureNames);
            return body ? { kind: "let", bindings, body } : undefined;
        }
        case "if": {
            const condExpr = rewriteSpecializedClosureBody(expr.condExpr, envParamName, environmentLayout, captureNames);
            const trueBranchExpr = rewriteSpecializedClosureBody(expr.trueBranchExpr, envParamName, environmentLayout, captureNames);
            const falseBranchExpr = rewriteSpecializedClosureBody(expr.falseBranchExpr, envParamName, environmentLayout, captureNames);
            return condExpr && trueBranchExpr && falseBranchExpr ? { kind: "if", condExpr, trueBranchExpr, falseBranchExpr } : undefined;
        }
        case "while": {
            const condExpr = rewriteSpecializedClosureBody(expr.condExpr, envParamName, environmentLayout, captureNames);
            const bodyExpr = rewriteSpecializedClosureBody(expr.bodyExpr, envParamName, environmentLayout, captureNames);
            return condExpr && bodyExpr ? { kind: "while", condExpr, bodyExpr } : undefined;
        }
        case "seq": {
            const expressions: ClosureExpr[] = [];
            for (const inner of expr.expressions) {
                const rewritten = rewriteSpecializedClosureBody(inner, envParamName, environmentLayout, captureNames);
                if (!rewritten) {
                    return undefined;
                }
                expressions.push(rewritten);
            }
            return { kind: "seq", expressions };
        }
        case "set_local": {
            const value = rewriteSpecializedClosureBody(expr.value, envParamName, environmentLayout, captureNames);
            return value ? { kind: "set_local", identifier: expr.identifier, value } : undefined;
        }
        case "direct_call": {
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const rewritten = rewriteSpecializedClosureBody(arg, envParamName, environmentLayout, captureNames);
                if (!rewritten) {
                    return undefined;
                }
                args.push(rewritten);
            }
            return { kind: "direct_call", symbol: expr.symbol, args };
        }
        case "object_get_field": {
            const receiver = rewriteSpecializedClosureBody(expr.receiver, envParamName, environmentLayout, captureNames);
            return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
        }
        case "object_set_field": {
            const receiver = rewriteSpecializedClosureBody(expr.receiver, envParamName, environmentLayout, captureNames);
            const value = rewriteSpecializedClosureBody(expr.value, envParamName, environmentLayout, captureNames);
            return receiver && value ? { kind: "object_set_field", receiver, className: expr.className, fieldName: expr.fieldName, value } : undefined;
        }
        case "slot_load":
            if (expr.receiver.kind === "identifier" && expr.receiver.name === envParamName && expr.className === environmentLayout && captureNames.has(expr.slotName)) {
                return { kind: "identifier", name: expr.slotName };
            }
            return {
                kind: "slot_load",
                receiver: rewriteSpecializedClosureBody(expr.receiver, envParamName, environmentLayout, captureNames) ?? expr.receiver,
                className: expr.className,
                slotName: expr.slotName
            };
        case "slot_store": {
            const receiver = rewriteSpecializedClosureBody(expr.receiver, envParamName, environmentLayout, captureNames);
            const value = rewriteSpecializedClosureBody(expr.value, envParamName, environmentLayout, captureNames);
            return receiver && value ? { kind: "slot_store", receiver, className: expr.className, slotName: expr.slotName, value } : undefined;
        }
        case "union_inject": {
            const value = rewriteSpecializedClosureBody(expr.value, envParamName, environmentLayout, captureNames);
            return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
        }
        case "closure_create": {
            const captures: ClosureExpr[] = [];
            for (const capture of expr.captures) {
                const rewritten = rewriteSpecializedClosureBody(capture, envParamName, environmentLayout, captureNames);
                if (!rewritten) {
                    return undefined;
                }
                captures.push(rewritten);
            }
            return { kind: "closure_create", closureId: expr.closureId, applySymbol: expr.applySymbol, environmentLayout: expr.environmentLayout, captures };
        }
        case "closure_call": {
            const callee = rewriteSpecializedClosureBody(expr.callee, envParamName, environmentLayout, captureNames);
            const args: ClosureExpr[] = [];
            for (const arg of expr.args) {
                const rewritten = rewriteSpecializedClosureBody(arg, envParamName, environmentLayout, captureNames);
                if (!rewritten) {
                    return undefined;
                }
                args.push(rewritten);
            }
            return callee ? { kind: "closure_call", callee, args } : undefined;
        }
        case "match": {
            const unionExpr = rewriteSpecializedClosureBody(expr.unionExpr, envParamName, environmentLayout, captureNames);
            if (!unionExpr) {
                return undefined;
            }
            const branches = [];
            for (const branch of expr.branches) {
                const body = rewriteSpecializedClosureBody(branch.body, envParamName, environmentLayout, captureNames);
                if (!body) {
                    return undefined;
                }
                branches.push({ bind: branch.bind, memberTypeTagId: branch.memberTypeTagId, body });
            }
            return { kind: "match", unionTypeTagId: expr.unionTypeTagId, unionExpr, branches };
        }
    }
}

function ensureSpecializedClosureHelper(
    closureExpr: Extract<ClosureExpr, { kind: "closure_create" }>,
    context: ClosureSpecializationContext,
    state: ScalarReplaceState
): string | undefined {
    const existing = state.specializedHelpers.get(closureExpr.applySymbol);
    if (existing) {
        return existing;
    }
    const helper = context.helperByClosureId.get(closureExpr.closureId);
    const applyFn = context.functionBySymbol.get(closureExpr.applySymbol);
    if (!helper || !applyFn || applyFn.params.length === 0) {
        return undefined;
    }
    const captureNames = new Set(helper.captureOrder);
    const specializedBody = rewriteSpecializedClosureBody(applyFn.body, applyFn.params[0].name, helper.environmentLayout, captureNames);
    if (!specializedBody) {
        return undefined;
    }
    const specializedSymbol = `${closureExpr.applySymbol}__scalar`;
    const params = helper.captureOrder.map((captureName) => ({
        name: captureName,
        typeExp: typeValueToTypeAst(helper.captureTypes.get(captureName)!)
    })).concat(applyFn.params.slice(1));
    state.specializedHelpers.set(closureExpr.applySymbol, specializedSymbol);
    state.synthesizedFunctions.push({
        symbol: specializedSymbol,
        params,
        returnType: applyFn.returnType,
        body: specializedBody,
        origin: {
            kind: "closure_shrink",
            closureId: closureExpr.closureId
        }
    });
    return specializedSymbol;
}

function tryScalarizeLocalClosureUse(
    binding: LoweredBinding,
    closureExpr: Extract<ClosureExpr, { kind: "closure_create" }>,
    body: ClosureExpr,
    context: ClosureSpecializationContext,
    state: ScalarReplaceState
): ClosureExpr | undefined {
    const specializedSymbol = ensureSpecializedClosureHelper(closureExpr, context, state);
    if (!specializedSymbol) {
        return undefined;
    }
    let rewrittenCalls = 0;
    const rewriteUse = (expr: ClosureExpr): ClosureExpr | undefined => {
        switch (expr.kind) {
            case "identifier":
                return expr.name === binding.name ? undefined : expr;
            case "number_literal":
            case "text_literal":
            case "direct_function_ref":
            case "object_alloc":
                return expr;
            case "let": {
                const bindings: ClosureLetBinding[] = [];
                for (const innerBinding of expr.bindings) {
                    const value = rewriteUse(innerBinding.value);
                    if (!value) {
                        return undefined;
                    }
                    bindings.push({ bind: innerBinding.bind, value });
                }
                const rewrittenBody = rewriteUse(expr.body);
                return rewrittenBody ? { kind: "let", bindings, body: rewrittenBody } : undefined;
            }
            case "seq": {
                const expressions: ClosureExpr[] = [];
                for (const inner of expr.expressions) {
                    const rewritten = rewriteUse(inner);
                    if (!rewritten) {
                        return undefined;
                    }
                    expressions.push(rewritten);
                }
                return { kind: "seq", expressions };
            }
            case "set_local": {
                const value = rewriteUse(expr.value);
                return value ? { kind: "set_local", identifier: expr.identifier, value } : undefined;
            }
            case "direct_call": {
                const args: ClosureExpr[] = [];
                for (const arg of expr.args) {
                    const rewritten = rewriteUse(arg);
                    if (!rewritten) {
                        return undefined;
                    }
                    args.push(rewritten);
                }
                return { kind: "direct_call", symbol: expr.symbol, args };
            }
            case "object_get_field": {
                const receiver = rewriteUse(expr.receiver);
                return receiver ? { kind: "object_get_field", receiver, className: expr.className, fieldName: expr.fieldName } : undefined;
            }
            case "object_set_field": {
                const receiver = rewriteUse(expr.receiver);
                const value = rewriteUse(expr.value);
                return receiver && value ? { kind: "object_set_field", receiver, className: expr.className, fieldName: expr.fieldName, value } : undefined;
            }
            case "slot_load": {
                const receiver = rewriteUse(expr.receiver);
                return receiver ? { kind: "slot_load", receiver, className: expr.className, slotName: expr.slotName } : undefined;
            }
            case "slot_store": {
                const receiver = rewriteUse(expr.receiver);
                const value = rewriteUse(expr.value);
                return receiver && value ? { kind: "slot_store", receiver, className: expr.className, slotName: expr.slotName, value } : undefined;
            }
            case "union_inject": {
                const value = rewriteUse(expr.value);
                return value ? { kind: "union_inject", unionTypeTagId: expr.unionTypeTagId, memberTypeTagId: expr.memberTypeTagId, value } : undefined;
            }
            case "closure_create": {
                const captures: ClosureExpr[] = [];
                for (const capture of expr.captures) {
                    const rewritten = rewriteUse(capture);
                    if (!rewritten) {
                        return undefined;
                    }
                    captures.push(rewritten);
                }
                return {
                    kind: "closure_create",
                    closureId: expr.closureId,
                    applySymbol: expr.applySymbol,
                    environmentLayout: expr.environmentLayout,
                    captures
                };
            }
            case "closure_call": {
                if (expr.callee.kind === "identifier" && expr.callee.name === binding.name) {
                    const args: ClosureExpr[] = [];
                    for (const arg of expr.args) {
                        const rewritten = rewriteUse(arg);
                        if (!rewritten) {
                            return undefined;
                        }
                        args.push(rewritten);
                    }
                    rewrittenCalls += 1;
                    return {
                        kind: "direct_call",
                        symbol: specializedSymbol,
                        args: [...closureExpr.captures, ...args]
                    };
                }
                const callee = rewriteUse(expr.callee);
                const args: ClosureExpr[] = [];
                for (const arg of expr.args) {
                    const rewritten = rewriteUse(arg);
                    if (!rewritten) {
                        return undefined;
                    }
                    args.push(rewritten);
                }
                return callee ? { kind: "closure_call", callee, args } : undefined;
            }
            case "if":
            case "while":
            case "match":
                return containsIdentifier(expr, binding.name) ? undefined : expr;
        }
    };

    const rewrittenBody = rewriteUse(body);
    if (!rewrittenBody || rewrittenCalls < 1) {
        return undefined;
    }
    state.scalarizedClosures += 1;
    state.rewrittenClosureCalls += rewrittenCalls;
    return rewrittenBody;
}

function tryScalarizeConditionalFreshObject(
    binding: LoweredBinding,
    expr: Extract<ClosureExpr, { kind: "if" }>,
    body: ClosureExpr,
    layouts: ReadonlyMap<string, LoweringClassLayout>,
    state: ScalarReplaceState,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>
): ClosureExpr | undefined {
    const trueProducer = analyzeFreshObjectProducer(expr.trueBranchExpr, constructorSummaries, objectFactorySummaries);
    const falseProducer = analyzeFreshObjectProducer(expr.falseBranchExpr, constructorSummaries, objectFactorySummaries);
    if (!trueProducer || !falseProducer || trueProducer.className !== falseProducer.className) {
        return undefined;
    }
    const trueBranchExpr = tryScalarizeFreshObject(binding, trueProducer, body, layouts, state, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
    const falseBranchExpr = tryScalarizeFreshObject(binding, falseProducer, body, layouts, state, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
    if (!trueBranchExpr || !falseBranchExpr) {
        return undefined;
    }
    return {
        kind: "if",
        condExpr: expr.condExpr,
        trueBranchExpr,
        falseBranchExpr
    };
}

function rewriteSingleBindingLet(
    binding: ClosureLetBinding,
    body: ClosureExpr,
    state: ScalarReplaceState,
    layouts: ReadonlyMap<string, LoweringClassLayout>,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>,
    closureContext: ClosureSpecializationContext
): ClosureExpr {
    let producer = analyzeFreshObjectProducer(binding.value, constructorSummaries, objectFactorySummaries);
    if (!producer && binding.value.kind === "direct_call") {
        const summary = objectFactorySummaries.get(binding.value.symbol);
        producer = summary ? instantiateObjectFactoryProducer(summary, binding.value.args, constructorSummaries, objectFactorySummaries) : undefined;
    }
    const scalarized = producer ? tryScalarizeFreshObject(binding.bind, producer, body, layouts, state, constructorSummaries, scalarHelperSummaries, objectFactorySummaries) : undefined;
    if (scalarized) {
        return scalarized;
    }
    if (binding.value.kind === "if") {
        const scalarizedConditional = tryScalarizeConditionalFreshObject(
            binding.bind,
            binding.value,
            body,
            layouts,
            state,
            constructorSummaries,
            scalarHelperSummaries,
            objectFactorySummaries
        );
        if (scalarizedConditional) {
            return scalarizedConditional;
        }
    }
    if (binding.value.kind === "closure_create") {
        const scalarizedClosure = tryScalarizeLocalClosureUse(binding.bind, binding.value, body, closureContext, state);
        if (scalarizedClosure) {
            return scalarizedClosure;
        }
    }
    return {
        kind: "let",
        bindings: [binding],
        body
    };
}

function rewriteExpr(
    expr: ClosureExpr,
    state: ScalarReplaceState,
    layouts: ReadonlyMap<string, LoweringClassLayout>,
    constructorSummaries: ReadonlyMap<string, ConstructorSummary>,
    scalarHelperSummaries: ReadonlyMap<string, ScalarHelperSummary>,
    objectFactorySummaries: ReadonlyMap<string, ObjectFactorySummary>,
    closureContext: ClosureSpecializationContext
): ClosureExpr {
    switch (expr.kind) {
        case "identifier":
        case "number_literal":
        case "text_literal":
        case "direct_function_ref":
        case "object_alloc":
            return expr;
        case "let": {
            const bindings = expr.bindings.map((binding) => ({
                bind: binding.bind,
                value: rewriteExpr(binding.value, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            }));
            let body = rewriteExpr(expr.body, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext);
            for (let index = bindings.length - 1; index >= 0; index -= 1) {
                body = rewriteSingleBindingLet(bindings[index], body, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext);
            }
            return bindings.length > 1
                ? rewriteExpr(body, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
                : body;
        }
        case "if":
            return {
                kind: "if",
                condExpr: rewriteExpr(expr.condExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                trueBranchExpr: rewriteExpr(expr.trueBranchExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                falseBranchExpr: rewriteExpr(expr.falseBranchExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "while":
            return {
                kind: "while",
                condExpr: rewriteExpr(expr.condExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                bodyExpr: rewriteExpr(expr.bodyExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "seq":
            return {
                kind: "seq",
                expressions: expr.expressions.map((inner) => rewriteExpr(inner, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext))
            };
        case "set_local":
            return {
                kind: "set_local",
                identifier: expr.identifier,
                value: rewriteExpr(expr.value, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "direct_call":
            return {
                kind: "direct_call",
                symbol: expr.symbol,
                args: expr.args.map((arg) => rewriteExpr(arg, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext))
            };
        case "object_get_field":
            return {
                kind: "object_get_field",
                receiver: rewriteExpr(expr.receiver, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                className: expr.className,
                fieldName: expr.fieldName
            };
        case "object_set_field":
            return {
                kind: "object_set_field",
                receiver: rewriteExpr(expr.receiver, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                className: expr.className,
                fieldName: expr.fieldName,
                value: rewriteExpr(expr.value, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "slot_load":
            return {
                kind: "slot_load",
                receiver: rewriteExpr(expr.receiver, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                className: expr.className,
                slotName: expr.slotName
            };
        case "slot_store":
            return {
                kind: "slot_store",
                receiver: rewriteExpr(expr.receiver, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                className: expr.className,
                slotName: expr.slotName,
                value: rewriteExpr(expr.value, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "union_inject":
            return {
                kind: "union_inject",
                unionTypeTagId: expr.unionTypeTagId,
                memberTypeTagId: expr.memberTypeTagId,
                value: rewriteExpr(expr.value, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
            };
        case "closure_create":
            return {
                kind: "closure_create",
                closureId: expr.closureId,
                applySymbol: expr.applySymbol,
                environmentLayout: expr.environmentLayout,
                captures: expr.captures.map((capture) => rewriteExpr(capture, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext))
            };
        case "closure_call":
            return {
                kind: "closure_call",
                callee: rewriteExpr(expr.callee, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                args: expr.args.map((arg) => rewriteExpr(arg, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext))
            };
        case "match":
            return {
                kind: "match",
                unionTypeTagId: expr.unionTypeTagId,
                unionExpr: rewriteExpr(expr.unionExpr, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext),
                branches: expr.branches.map((branch) => ({
                    bind: branch.bind,
                    memberTypeTagId: branch.memberTypeTagId,
                    body: rewriteExpr(branch.body, state, layouts, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
                }))
            };
    }
}

export function scalarReplaceFreshPass(program: FoldedTypedPrimitiveProgram): ScalarReplacedFreshProgram {
    const constructorSummaries = new Map<string, ConstructorSummary>();
    for (const fn of program.functions) {
        const summary = summarizeConstructor(fn);
        if (summary) {
            constructorSummaries.set(fn.symbol, summary);
        }
    }
    const scalarHelperSummaries = new Map<string, ScalarHelperSummary>();
    const objectFactorySummaries = new Map<string, ObjectFactorySummary>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const fn of program.functions) {
            if (scalarHelperSummaries.has(fn.symbol)) {
                continue;
            }
            const summary = summarizeScalarHelper(fn, constructorSummaries, scalarHelperSummaries, objectFactorySummaries);
            if (summary) {
                scalarHelperSummaries.set(fn.symbol, summary);
                changed = true;
            }
        }
        for (const fn of program.functions) {
            if (objectFactorySummaries.has(fn.symbol)) {
                continue;
            }
            const summary = summarizeObjectFactory(fn, constructorSummaries, objectFactorySummaries, scalarHelperSummaries);
            if (summary) {
                objectFactorySummaries.set(fn.symbol, summary);
                changed = true;
            }
        }
    }
    const closureContext: ClosureSpecializationContext = {
        helperByClosureId: new Map(program.closureHelpers.map((helper) => [helper.closureId, helper] as const)),
        functionBySymbol: new Map(program.functions.map((fn) => [fn.symbol, fn] as const))
    };
    const state: ScalarReplaceState = {
        tempCounter: 0,
        scalarizedObjects: 0,
        replacedSlotStores: 0,
        replacedSlotLoads: 0
        ,scalarizedClosures: 0,
        rewrittenClosureCalls: 0,
        specializedHelpers: new Map(),
        synthesizedFunctions: []
    };
    const functions: ClosureConvertedFunctionDefinition[] = program.functions.map((fn) => ({
        ...fn,
        body: rewriteExpr(fn.body, state, program.layouts.classes, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)
    })).concat(state.synthesizedFunctions);
    const stats: ScalarReplacedFreshProgramStats = {
        scalarizedObjects: state.scalarizedObjects,
        replacedSlotStores: state.replacedSlotStores,
        replacedSlotLoads: state.replacedSlotLoads,
        scalarizedClosures: state.scalarizedClosures,
        rewrittenClosureCalls: state.rewrittenClosureCalls
    };
    return {
        kind: "scalar_replaced_fresh_program",
        topLevelStatements: program.topLevelStatements.map((statement) => rewriteExpr(statement, state, program.layouts.classes, constructorSummaries, scalarHelperSummaries, objectFactorySummaries, closureContext)),
        globals: program.globals,
        functions,
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata,
        stats
    };
}
