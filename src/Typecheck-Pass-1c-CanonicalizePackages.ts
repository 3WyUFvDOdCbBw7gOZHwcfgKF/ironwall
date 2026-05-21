import {
    AngleParenListNode,
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    CurlyParenListNode,
    DeclaredDfunNode,
    DfunNode,
    DvarNode,
    ExportNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
    GenericNameNode,
    IdentifierNode,
    IfNode,
    ImportNode,
    LetNode,
    ListNode,
    MatchNode,
    NumberLiteralNode,
    ProgramNode,
    RoundParenListNode,
    SeqNode,
    SetNode,
    SquareParenListNode,
    TextDatabaseReferenceNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
    WhileNode
} from "./AstNode";
import {
    getVisibleClassInfo,
    getVisibleGenericClassInfo,
    getVisibleGenericFunctionInfo,
    getVisibleGlobalVarInfo
} from "./Typecheck-Definitions";
import { getVisibleResolvedFunctionOverloads } from "./Typecheck-Pass-2-ResolveHeaders";
import { getVisibleDatabaseReferenceCanonicalNames } from "./Typecheck-Modules";
import { builtinGenericTypeNames, primitiveTypeNames } from "./TypeSystem";

const SPECIAL_VALUE_IDENTIFIERS: ReadonlySet<string> = new Set<string>(["true", "false", "unit", "else"]);

class NameScope {
    private readonly names: Set<string>;
    public readonly parent?: NameScope;

    constructor(parent?: NameScope) {
        this.names = new Set<string>();
        this.parent = parent;
    }

    define(name: string): void {
        this.names.add(name);
    }

    has(name: string): boolean {
        if (this.names.has(name)) {
            return true;
        }
        if (this.parent !== undefined) {
            return this.parent.has(name);
        }
        return false;
    }

    extend(): NameScope {
        return new NameScope(this);
    }
}

class CanonicalizeContext {
    public readonly valueScope: NameScope;
    public readonly typeParamScope: NameScope;
    public readonly topLevel: boolean;

    constructor(valueScope: NameScope, typeParamScope: NameScope, topLevel: boolean) {
        this.valueScope = valueScope;
        this.typeParamScope = typeParamScope;
        this.topLevel = topLevel;
    }

    with(valueScope: NameScope, typeParamScope: NameScope, topLevel: boolean): CanonicalizeContext {
        return new CanonicalizeContext(valueScope, typeParamScope, topLevel);
    }
}

function createRootContext(): CanonicalizeContext {
    return new CanonicalizeContext(new NameScope(), new NameScope(), true);
}

function defineParamBindings(scope: NameScope, params: readonly TypeVarBindNode[]): void {
    for (const param of params) {
        scope.define(param.var.name);
    }
}

function defineGenericTypeParams(scope: NameScope, genericName: GenericNameNode): void {
    for (const typeParam of genericName.genericTypeArgs) {
        scope.define(typeParam.name);
    }
}

function canonicalizeFunctionIdentifier(node: IdentifierNode): void {
    const overloads = getVisibleResolvedFunctionOverloads(node, node.name);
    if (overloads.length > 0) {
        node.name = overloads[0].name;
    }
}

function canonicalizeGlobalIdentifier(node: IdentifierNode): boolean {
    const globalInfo = getVisibleGlobalVarInfo(node, node.name);
    if (globalInfo === undefined) {
        return false;
    }
    node.name = globalInfo.name;
    return true;
}

function canonicalizeClassIdentifier(node: IdentifierNode): void {
    if (primitiveTypeNames.has(node.name)) {
        return;
    }
    const classInfo = getVisibleClassInfo(node, node.name);
    if (classInfo !== undefined) {
        node.name = classInfo.name;
    }
}

function canonicalizeGenericClassIdentifier(node: IdentifierNode, arity: number): boolean {
    if (builtinGenericTypeNames.has(node.name)) {
        return true;
    }
    const classInfo = getVisibleGenericClassInfo(node, node.name, arity);
    if (classInfo === undefined) {
        return false;
    }
    node.name = classInfo.genericName;
    return true;
}

function canonicalizeGenericFunctionIdentifier(node: IdentifierNode, arity: number): boolean {
    const functionInfo = getVisibleGenericFunctionInfo(node, node.name, arity);
    if (functionInfo === undefined) {
        return false;
    }
    node.name = functionInfo.genericName;
    return true;
}

function canonicalizeTypeAst(node: AstNode, context: CanonicalizeContext): void {
    if (node instanceof IdentifierNode) {
        if (primitiveTypeNames.has(node.name) || context.typeParamScope.has(node.name)) {
            return;
        }
        canonicalizeClassIdentifier(node);
        return;
    }

    if (node instanceof GenericCallNode) {
        if (node.callee instanceof IdentifierNode) {
            canonicalizeGenericClassIdentifier(node.callee, node.typeArgs.length);
        } else {
            canonicalizeValueAst(node.callee, context);
        }
        for (const typeArg of node.typeArgs) {
            canonicalizeTypeAst(typeArg, context);
        }
        return;
    }

    if (node instanceof TypeToFromNode) {
        canonicalizeTypeAst(node.returnType, context);
        for (const paramType of node.paramTypes) {
            canonicalizeTypeAst(paramType, context);
        }
        return;
    }

    if (node instanceof TypeUnionNode) {
        for (const typeNode of node.types) {
            canonicalizeTypeAst(typeNode, context);
        }
        return;
    }

    if (node instanceof AngleParenListNode || node instanceof SquareParenListNode || node instanceof CurlyParenListNode || node instanceof RoundParenListNode || node instanceof ListNode) {
        for (const element of node.elements) {
            canonicalizeTypeAst(element, context);
        }
    }
}

function canonicalizeTextDatabaseReference(node: TextDatabaseReferenceNode): void {
    const canonicalNames = getVisibleDatabaseReferenceCanonicalNames(node, node.referenceName, `${node.entryName}^${node.typeName}`);
    if (canonicalNames.length === 1) {
        node.referenceName = canonicalNames[0];
    }
}

function canonicalizePlainIdentifier(node: IdentifierNode, context: CanonicalizeContext): void {
    if (SPECIAL_VALUE_IDENTIFIERS.has(node.name) || context.valueScope.has(node.name)) {
        return;
    }
    if (canonicalizeGlobalIdentifier(node)) {
        return;
    }
    canonicalizeFunctionIdentifier(node);
}

function canonicalizeFunctionCall(node: FunctionCallNode, context: CanonicalizeContext): void {
    if (node.callee instanceof IdentifierNode) {
        const calleeName = node.callee.name;
        if (calleeName === "class_new") {
            if (node.args.length > 0) {
                canonicalizeTypeAst(node.args[0], context);
            }
            for (let index = 1; index < node.args.length; index += 1) {
                canonicalizeValueAst(node.args[index], context);
            }
            return;
        }
        if (calleeName === "array_new") {
            if (node.args.length > 0) {
                canonicalizeTypeAst(node.args[0], context);
            }
            for (let index = 1; index < node.args.length; index += 1) {
                canonicalizeValueAst(node.args[index], context);
            }
            return;
        }
        if (calleeName === "cm_get") {
            if (node.args.length > 0) {
                canonicalizeValueAst(node.args[0], context);
            }
            return;
        }
        if (calleeName === "cm_set") {
            if (node.args.length > 0) {
                canonicalizeValueAst(node.args[0], context);
            }
            if (node.args.length > 2) {
                canonicalizeValueAst(node.args[2], context);
            }
            return;
        }
    }

    canonicalizeValueAst(node.callee, context);
    for (const arg of node.args) {
        canonicalizeValueAst(arg, context);
    }
}

function canonicalizeGenericCall(node: GenericCallNode, context: CanonicalizeContext): void {
    if (node.callee instanceof IdentifierNode) {
        if (node.callee.name === "class_new") {
            for (const typeArg of node.typeArgs) {
                canonicalizeTypeAst(typeArg, context);
            }
            return;
        }
        const renamedAsFunction = canonicalizeGenericFunctionIdentifier(node.callee, node.typeArgs.length);
        if (!renamedAsFunction) {
            canonicalizeGenericClassIdentifier(node.callee, node.typeArgs.length);
        }
    } else {
        canonicalizeValueAst(node.callee, context);
    }
    for (const typeArg of node.typeArgs) {
        canonicalizeTypeAst(typeArg, context);
    }
}

function canonicalizeBindingsInOrder(bindings: readonly { bind: AstNode; value: AstNode }[], context: CanonicalizeContext): void {
    const letScope = context.valueScope.extend();
    const prefixScope = context.valueScope.extend();

    for (const binding of bindings) {
        if (binding.bind instanceof TypeVarBindNode && binding.value instanceof FnNode) {
            letScope.define(binding.bind.var.name);
        }
    }

    for (const binding of bindings) {
        if (binding.bind instanceof TypeVarBindNode) {
            canonicalizeTypeAst(binding.bind.typeExp, context);
        }
        const bindingValueContext = binding.value instanceof FnNode
            ? context.with(letScope, context.typeParamScope, false)
            : context.with(prefixScope, context.typeParamScope, false);
        canonicalizeValueAst(binding.value, bindingValueContext);
        if (binding.bind instanceof TypeVarBindNode) {
            prefixScope.define(binding.bind.var.name);
            letScope.define(binding.bind.var.name);
        }
    }
}

function canonicalizeMatchBranches(node: MatchNode, context: CanonicalizeContext): void {
    canonicalizeValueAst(node.unionExpr, context);
    for (const branch of node.branches) {
        canonicalizeTypeAst(branch.bind.typeExp, context);
        const branchScope = context.valueScope.extend();
        branchScope.define(branch.bind.var.name);
        canonicalizeValueAst(branch.body, context.with(branchScope, context.typeParamScope, false));
    }
}

function canonicalizeMethodBody(method: ClassMethodNode, selfName: string, context: CanonicalizeContext): void {
    const methodScope = context.valueScope.extend();
    methodScope.define("self");
    defineParamBindings(methodScope, method.params);
    canonicalizeTypeAst(method.returnType, context);
    for (const param of method.params) {
        canonicalizeTypeAst(param.typeExp, context);
    }
    canonicalizeValueAst(method.body, context.with(methodScope, context.typeParamScope, false));
    void selfName;
}

function canonicalizeConstructorBody(constructorNode: ClassConstructorNode, context: CanonicalizeContext): void {
    const constructorScope = context.valueScope.extend();
    constructorScope.define("self");
    defineParamBindings(constructorScope, constructorNode.params);
    for (const param of constructorNode.params) {
        canonicalizeTypeAst(param.typeExp, context);
    }
    canonicalizeValueAst(constructorNode.body, context.with(constructorScope, context.typeParamScope, false));
}

function canonicalizeClassDefinition(node: ClassNode, context: CanonicalizeContext): void {
    canonicalizeClassIdentifier(node.name);
    for (const property of node.propertyNodeList) {
        canonicalizeTypeAst(property.bind.typeExp, context);
    }
    for (const method of node.methodNodeList) {
        canonicalizeMethodBody(method, node.name.name, context);
    }
    for (const constructorNode of node.constructorNodeList) {
        canonicalizeConstructorBody(constructorNode, context);
    }
}

function canonicalizeGenericClassDefinition(node: GenericClassNode, context: CanonicalizeContext): void {
    canonicalizeGenericClassIdentifier(node.genericName.name, node.genericName.genericTypeArgs.length);
    const genericTypeScope = context.typeParamScope.extend();
    defineGenericTypeParams(genericTypeScope, node.genericName);
    const genericContext = context.with(context.valueScope, genericTypeScope, true);
    for (const property of node.propertyNodeList) {
        canonicalizeTypeAst(property.bind.typeExp, genericContext);
    }
    for (const method of node.methodNodeList) {
        canonicalizeMethodBody(method, node.genericName.name.name, genericContext);
    }
    for (const constructorNode of node.constructorNodeList) {
        canonicalizeConstructorBody(constructorNode, genericContext);
    }
}

function canonicalizeFunctionDefinition(node: DfunNode, context: CanonicalizeContext): void {
    canonicalizeFunctionIdentifier(node.name);
    const functionScope = context.valueScope.extend();
    defineParamBindings(functionScope, node.params);
    for (const param of node.params) {
        canonicalizeTypeAst(param.typeExp, context);
    }
    canonicalizeTypeAst(node.returnType, context);
    canonicalizeValueAst(node.body, context.with(functionScope, context.typeParamScope, false));
}

function canonicalizeDeclaredFunctionDefinition(node: DeclaredDfunNode, context: CanonicalizeContext): void {
    canonicalizeFunctionIdentifier(node.name);
    for (const param of node.params) {
        canonicalizeTypeAst(param.typeExp, context);
    }
    canonicalizeTypeAst(node.returnType, context);
}

function canonicalizeGenericFunctionDefinition(node: GenericDfunNode, context: CanonicalizeContext): void {
    canonicalizeGenericFunctionIdentifier(node.genericName.name, node.genericName.genericTypeArgs.length);
    const genericTypeScope = context.typeParamScope.extend();
    defineGenericTypeParams(genericTypeScope, node.genericName);
    const functionScope = context.valueScope.extend();
    defineParamBindings(functionScope, node.params);
    const genericContext = context.with(functionScope, genericTypeScope, false);
    for (const param of node.params) {
        canonicalizeTypeAst(param.typeExp, context.with(context.valueScope, genericTypeScope, false));
    }
    canonicalizeTypeAst(node.returnType, context.with(context.valueScope, genericTypeScope, false));
    canonicalizeValueAst(node.body, genericContext);
}

function canonicalizeDvar(node: DvarNode, context: CanonicalizeContext): void {
    if (node.bind instanceof TypeVarBindNode) {
        canonicalizeTypeAst(node.bind.typeExp, context);
        if (context.topLevel) {
            const globalInfo = getVisibleGlobalVarInfo(node.bind.var, node.bind.var.name);
            if (globalInfo !== undefined) {
                node.bind.var.name = globalInfo.name;
            }
        }
    } else {
        canonicalizeValueAst(node.bind, context);
    }
    canonicalizeValueAst(node.value, context);
    if (!context.topLevel && node.bind instanceof TypeVarBindNode) {
        context.valueScope.define(node.bind.var.name);
    }
}

function canonicalizeValueAst(node: AstNode, context: CanonicalizeContext): void {
    if (node instanceof ProgramNode) {
        for (const expression of node.topLevelExpressions) {
            canonicalizeValueAst(expression, context.with(context.valueScope, context.typeParamScope, true));
        }
        return;
    }
    if (node instanceof ExportNode) {
        canonicalizeValueAst(node.inner, context.with(context.valueScope, context.typeParamScope, context.topLevel));
        return;
    }
    if (node instanceof IdentifierNode) {
        canonicalizePlainIdentifier(node, context);
        return;
    }
    if (node instanceof TextDatabaseReferenceNode) {
        canonicalizeTextDatabaseReference(node);
        return;
    }
    if (node instanceof NumberLiteralNode || node instanceof ImportNode) {
        return;
    }
    if (node instanceof FnNode) {
        const fnScope = context.valueScope.extend();
        defineParamBindings(fnScope, node.params);
        for (const param of node.params) {
            canonicalizeTypeAst(param.typeExp, context);
        }
        canonicalizeTypeAst(node.returnType, context);
        canonicalizeValueAst(node.body, context.with(fnScope, context.typeParamScope, false));
        return;
    }
    if (node instanceof LetNode) {
        canonicalizeBindingsInOrder(node.bindings, context);
        const bodyScope = context.valueScope.extend();
        for (const binding of node.bindings) {
            if (binding.bind instanceof TypeVarBindNode) {
                bodyScope.define(binding.bind.var.name);
            }
        }
        canonicalizeValueAst(node.body, context.with(bodyScope, context.typeParamScope, false));
        return;
    }
    if (node instanceof IfNode) {
        canonicalizeValueAst(node.condExpr, context);
        canonicalizeValueAst(node.trueBranchExpr, context);
        canonicalizeValueAst(node.falseBranchExpr, context);
        return;
    }
    if (node instanceof WhileNode) {
        canonicalizeValueAst(node.condExpr, context);
        canonicalizeValueAst(node.bodyExpr, context);
        return;
    }
    if (node instanceof CondNode) {
        for (const clause of node.clausesExprs) {
            canonicalizeValueAst(clause.cond, context);
            canonicalizeValueAst(clause.body, context);
        }
        return;
    }
    if (node instanceof DvarNode) {
        canonicalizeDvar(node, context);
        return;
    }
    if (node instanceof DfunNode) {
        canonicalizeFunctionDefinition(node, context.with(context.valueScope, context.typeParamScope, true));
        return;
    }
    if (node instanceof DeclaredDfunNode) {
        canonicalizeDeclaredFunctionDefinition(node, context.with(context.valueScope, context.typeParamScope, true));
        return;
    }
    if (node instanceof SetNode) {
        if (!context.valueScope.has(node.identifier.name)) {
            canonicalizeGlobalIdentifier(node.identifier);
        }
        canonicalizeValueAst(node.value, context);
        return;
    }
    if (node instanceof SeqNode) {
        for (const expression of node.expressions) {
            canonicalizeValueAst(expression, context.with(context.valueScope, context.typeParamScope, false));
        }
        return;
    }
    if (node instanceof TypeVarBindNode) {
        canonicalizeTypeAst(node.typeExp, context);
        return;
    }
    if (node instanceof TypeToFromNode || node instanceof TypeUnionNode) {
        canonicalizeTypeAst(node, context);
        return;
    }
    if (node instanceof ClassNode) {
        canonicalizeClassDefinition(node, context.with(context.valueScope, context.typeParamScope, true));
        return;
    }
    if (node instanceof ClassPropertyNode) {
        canonicalizeTypeAst(node.bind.typeExp, context);
        return;
    }
    if (node instanceof ClassMethodNode) {
        canonicalizeMethodBody(node, node.methodName.name, context);
        return;
    }
    if (node instanceof ClassConstructorNode) {
        canonicalizeConstructorBody(node, context);
        return;
    }
    if (node instanceof GenericClassNode) {
        canonicalizeGenericClassDefinition(node, context.with(context.valueScope, context.typeParamScope, true));
        return;
    }
    if (node instanceof GenericDfunNode) {
        canonicalizeGenericFunctionDefinition(node, context.with(context.valueScope, context.typeParamScope, true));
        return;
    }
    if (node instanceof GenericCallNode) {
        canonicalizeGenericCall(node, context);
        return;
    }
    if (node instanceof FunctionCallNode) {
        canonicalizeFunctionCall(node, context);
        return;
    }
    if (node instanceof MatchNode) {
        canonicalizeMatchBranches(node, context);
        return;
    }
    if (node instanceof GenericNameNode) {
        return;
    }
    if (node instanceof AngleParenListNode || node instanceof SquareParenListNode || node instanceof CurlyParenListNode || node instanceof RoundParenListNode || node instanceof ListNode) {
        for (const element of node.elements) {
            canonicalizeValueAst(element, context);
        }
    }
}

export function canonicalizePackageNamesPass(ast: AstNode): void {
    canonicalizeValueAst(ast, createRootContext());
}