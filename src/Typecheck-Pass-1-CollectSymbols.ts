import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    DeclaredDfunNode,
    CurlyParenListNode,
    DfunNode,
    DvarNode,
    ExportNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
    GenericNameNode,
    ImportNode,
    IdentifierNode,
    IfNode,
    WhileNode,
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
    isExportableTopLevelAstNode
} from "./AstNode";
import {
    ClassInfo,
    FunctionInfo,
    GenericClassInfo,
    GenericFunctionInfo,
    GlobalVarInfo,
    registerClassInfo,
    registerFunctionInfo,
    registerGenericClassInfo,
    registerGenericFunctionInfo,
    registerGlobalVarInfo
} from "./Typecheck-Definitions";
import { getCompilationUnitMetadata } from "./ModuleMetadata";
import { registerPackageSymbol } from "./Typecheck-Modules";

interface DefinitionCollectionContext {
    readonly topLevel: boolean;
    readonly exported: boolean;
    readonly packageName: string | null;
    readonly unitId: string | null;
    readonly filePath: string | null;
}

function buildCanonicalName(exportedName: string, packageName: string | null): string {
    return packageName === null ? exportedName : `${packageName}@${exportedName}`;
}

function buildFunctionCanonicalName(exportedName: string, context: DefinitionCollectionContext): string {
    if (context.packageName !== null && exportedName === "main" && context.unitId !== null) {
        return context.unitId;
    }
    return buildCanonicalName(exportedName, context.packageName);
}

function buildGenericOverloadCanonicalName(baseName: string, arity: number): string {
    return `${baseName}#arity${arity}`;
}

function recordFunctionInfo(info: FunctionInfo): void {
    registerFunctionInfo(info);
}

function topLevelContextFor(node: AstNode, fallback: DefinitionCollectionContext): DefinitionCollectionContext {
    const metadata = getCompilationUnitMetadata(node);
    if (metadata === undefined) {
        return fallback;
    }
    return {
        topLevel: true,
        exported: false,
        packageName: metadata.packageName,
        unitId: metadata.unitId,
        filePath: metadata.filePath
    };
}

function registerSymbol(kind: "class" | "generic_class" | "function" | "generic_function" | "global", exportedName: string, canonicalName: string, context: DefinitionCollectionContext, genericArity?: number, isExported = false): void {
    registerPackageSymbol({
        kind,
        exportedName,
        canonicalName,
        genericArity,
        isExported,
        packageName: context.packageName,
        unitId: context.unitId,
        filePath: context.filePath
    });
}

function isTopLevelSymbolExported(context: DefinitionCollectionContext): boolean {
    return context.packageName === null || context.exported;
}

function isTopLevelFunctionExported(exportedName: string, context: DefinitionCollectionContext): boolean {
    return isTopLevelSymbolExported(context)
        && !(context.packageName !== null && exportedName === "main");
}

export function collectClassInfoPass(ast: AstNode, context: DefinitionCollectionContext = { topLevel: true, exported: true, packageName: null, unitId: null, filePath: null }): void {
    if (ast instanceof ExportNode) {
        if (context.topLevel && isExportableTopLevelAstNode(ast.inner)) {
            collectClassInfoPass(ast.inner, { ...context, exported: true });
            return;
        }
        collectClassInfoPass(ast.inner, { ...context, topLevel: false });
        return;
    }

    if (ast instanceof ClassNode && context.topLevel) {
        const canonicalName = buildCanonicalName(ast.name.name, context.packageName);
        const info = new ClassInfo(canonicalName, ast.constructorNodeList, ast.methodNodeList, ast.propertyNodeList, context.packageName, context.unitId, ast.name.name, context.filePath);
        registerClassInfo(info);
        registerSymbol("class", ast.name.name, canonicalName, context, undefined, isTopLevelSymbolExported(context));
        return;
    }
    if (ast instanceof GenericClassNode && context.topLevel) {
        const baseCanonicalName = buildCanonicalName(ast.genericName.name.name, context.packageName);
        const canonicalName = buildGenericOverloadCanonicalName(baseCanonicalName, ast.genericName.genericTypeArgs.length);
        const info = new GenericClassInfo(
            canonicalName,
            baseCanonicalName,
            ast.genericName.genericTypeArgs.map((arg) => arg.name),
            ast.constructorNodeList,
            ast.methodNodeList,
            ast.propertyNodeList,
            context.packageName,
            context.unitId,
            ast.genericName.name.name,
            context.filePath
        );
        registerGenericClassInfo(info);
        registerSymbol("generic_class", ast.genericName.name.name, canonicalName, context, ast.genericName.genericTypeArgs.length, isTopLevelSymbolExported(context));
        return;
    }
    if (ast instanceof DfunNode && context.topLevel) {
        const canonicalName = buildFunctionCanonicalName(ast.name.name, context);
        const isExported = isTopLevelFunctionExported(ast.name.name, context);
        recordFunctionInfo(new FunctionInfo(canonicalName, ast.params, ast.returnType, false, context.packageName, context.unitId, ast.name.name, ast.body, context.filePath, isExported));
        registerSymbol("function", ast.name.name, canonicalName, context, undefined, isExported);
        return;
    }
    if (ast instanceof DeclaredDfunNode && context.topLevel) {
        const canonicalName = buildFunctionCanonicalName(ast.name.name, context);
        const isExported = isTopLevelFunctionExported(ast.name.name, context);
        recordFunctionInfo(new FunctionInfo(canonicalName, ast.params, ast.returnType, true, context.packageName, context.unitId, ast.name.name, null, context.filePath, isExported));
        registerSymbol("function", ast.name.name, canonicalName, context, undefined, isExported);
        return;
    }
    if (ast instanceof GenericDfunNode && context.topLevel) {
        const baseCanonicalName = buildFunctionCanonicalName(ast.genericName.name.name, context);
        const canonicalName = buildGenericOverloadCanonicalName(baseCanonicalName, ast.genericName.genericTypeArgs.length);
        const info = new GenericFunctionInfo(
            canonicalName,
            baseCanonicalName,
            ast.genericName.genericTypeArgs.map((arg) => arg.name),
            ast.params,
            ast.returnType,
            ast.body,
            context.packageName,
            context.unitId,
            ast.genericName.name.name,
            context.filePath
        );
        registerGenericFunctionInfo(info);
        registerSymbol("generic_function", ast.genericName.name.name, canonicalName, context, ast.genericName.genericTypeArgs.length, isTopLevelFunctionExported(ast.genericName.name.name, context));
        return;
    }
    if (ast instanceof DvarNode && context.topLevel) {
        if (!(ast.bind instanceof TypeVarBindNode)) {
            throw new Error("top-level var requires type binding");
        }
        const canonicalName = buildCanonicalName(ast.bind.var.name, context.packageName);
        registerGlobalVarInfo(new GlobalVarInfo(canonicalName, ast.bind, ast.value, context.packageName, context.unitId, ast.bind.var.name, context.filePath));
        registerSymbol("global", ast.bind.var.name, canonicalName, context, undefined, isTopLevelSymbolExported(context));
        return;
    }

    if (ast instanceof ListNode || ast instanceof SquareParenListNode || ast instanceof CurlyParenListNode || ast instanceof RoundParenListNode) {
        for (const element of ast.elements) {
            collectClassInfoPass(element, { ...context, topLevel: false });
        }
        return;
    }
    if (ast instanceof FnNode) {
        ast.params.forEach((param) => collectClassInfoPass(param, { ...context, topLevel: false }));
        collectClassInfoPass(ast.returnType, { ...context, topLevel: false });
        collectClassInfoPass(ast.body, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof LetNode) {
        for (const binding of ast.bindings) {
            collectClassInfoPass(binding.bind, { ...context, topLevel: false });
            collectClassInfoPass(binding.value, { ...context, topLevel: false });
        }
        collectClassInfoPass(ast.body, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof IfNode) {
        collectClassInfoPass(ast.condExpr, { ...context, topLevel: false });
        collectClassInfoPass(ast.trueBranchExpr, { ...context, topLevel: false });
        collectClassInfoPass(ast.falseBranchExpr, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof WhileNode) {
        collectClassInfoPass(ast.condExpr, { ...context, topLevel: false });
        collectClassInfoPass(ast.bodyExpr, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof CondNode) {
        ast.clausesExprs.forEach((clause) => {
            collectClassInfoPass(clause.cond, { ...context, topLevel: false });
            collectClassInfoPass(clause.body, { ...context, topLevel: false });
        });
        return;
    }
    if (ast instanceof DvarNode) {
        collectClassInfoPass(ast.bind, { ...context, topLevel: false });
        collectClassInfoPass(ast.value, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof DeclaredDfunNode) {
        ast.params.forEach((param) => collectClassInfoPass(param, { ...context, topLevel: false }));
        collectClassInfoPass(ast.returnType, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof SetNode) {
        collectClassInfoPass(ast.identifier, { ...context, topLevel: false });
        collectClassInfoPass(ast.value, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof ProgramNode) {
        ast.topLevelExpressions.forEach((expression) => collectClassInfoPass(expression, topLevelContextFor(expression, context)));
        return;
    }
    if (ast instanceof SeqNode) {
        ast.expressions.forEach((expression) => collectClassInfoPass(expression, { ...context, topLevel: context.topLevel }));
        return;
    }
    if (ast instanceof TypeVarBindNode) {
        collectClassInfoPass(ast.var, { ...context, topLevel: false });
        collectClassInfoPass(ast.typeExp, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof TypeToFromNode) {
        collectClassInfoPass(ast.returnType, { ...context, topLevel: false });
        ast.paramTypes.forEach((param) => collectClassInfoPass(param, { ...context, topLevel: false }));
        return;
    }
    if (ast instanceof TypeUnionNode) {
        ast.types.forEach((typeNode) => collectClassInfoPass(typeNode, { ...context, topLevel: false }));
        return;
    }
    if (ast instanceof FunctionCallNode) {
        collectClassInfoPass(ast.callee, { ...context, topLevel: false });
        ast.args.forEach((arg) => collectClassInfoPass(arg, { ...context, topLevel: false }));
        return;
    }
    if (ast instanceof GenericCallNode) {
        collectClassInfoPass(ast.callee, { ...context, topLevel: false });
        ast.typeArgs.forEach((typeArg) => collectClassInfoPass(typeArg, { ...context, topLevel: false }));
        return;
    }
    if (ast instanceof MatchNode) {
        collectClassInfoPass(ast.unionExpr, { ...context, topLevel: false });
        ast.branches.forEach((branch) => {
            collectClassInfoPass(branch.bind, { ...context, topLevel: false });
            collectClassInfoPass(branch.body, { ...context, topLevel: false });
        });
        return;
    }
    if (ast instanceof ImportNode) {
        return;
    }
    if (ast instanceof ClassPropertyNode) {
        collectClassInfoPass(ast.bind, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof ClassMethodNode) {
        ast.params.forEach((param) => collectClassInfoPass(param, { ...context, topLevel: false }));
        collectClassInfoPass(ast.returnType, { ...context, topLevel: false });
        collectClassInfoPass(ast.body, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof ClassConstructorNode) {
        ast.params.forEach((param) => collectClassInfoPass(param, { ...context, topLevel: false }));
        collectClassInfoPass(ast.body, { ...context, topLevel: false });
        return;
    }
    if (ast instanceof GenericNameNode || ast instanceof IdentifierNode || ast instanceof TextDatabaseReferenceNode || ast instanceof NumberLiteralNode) {
        return;
    }
}
