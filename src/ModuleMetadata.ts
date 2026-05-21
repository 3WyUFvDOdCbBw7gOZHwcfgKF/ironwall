import { AstNode, ProgramNode } from "./AstNode";

export interface CompilationUnitMetadata {
    readonly unitId: string;
    readonly packageName: string;
    readonly unitName: string;
    readonly filePath: string | null;
}

const MODULE_UNIT_ID_PATTERN: RegExp = /^([a-zA-Z][a-zA-Z0-9_]*(?:~[a-zA-Z][a-zA-Z0-9_]*)*)@([a-zA-Z][a-zA-Z0-9_]*)$/;
const nodeUnitMetadata: WeakMap<AstNode, CompilationUnitMetadata> = new WeakMap();

function annotateNode(node: AstNode, metadata: CompilationUnitMetadata): void {
    nodeUnitMetadata.set(node, metadata);

    if (node instanceof ProgramNode) {
        for (const expression of node.topLevelExpressions) {
            annotateNode(expression, metadata);
        }
        return;
    }

    if ("elements" in node && Array.isArray((node as { elements?: AstNode[] }).elements)) {
        for (const element of (node as { elements: AstNode[] }).elements) {
            annotateNode(element, metadata);
        }
    }

    if ("expressions" in node && Array.isArray((node as { expressions?: AstNode[] }).expressions)) {
        for (const expression of (node as { expressions: AstNode[] }).expressions) {
            annotateNode(expression, metadata);
        }
    }

    if ("params" in node && Array.isArray((node as { params?: AstNode[] }).params)) {
        for (const param of (node as { params: AstNode[] }).params) {
            annotateNode(param, metadata);
        }
    }

    if ("args" in node && Array.isArray((node as { args?: AstNode[] }).args)) {
        for (const arg of (node as { args: AstNode[] }).args) {
            annotateNode(arg, metadata);
        }
    }

    if ("typeArgs" in node && Array.isArray((node as { typeArgs?: AstNode[] }).typeArgs)) {
        for (const typeArg of (node as { typeArgs: AstNode[] }).typeArgs) {
            annotateNode(typeArg, metadata);
        }
    }

    if ("types" in node && Array.isArray((node as { types?: AstNode[] }).types)) {
        for (const typeNode of (node as { types: AstNode[] }).types) {
            annotateNode(typeNode, metadata);
        }
    }

    if ("paramTypes" in node && Array.isArray((node as { paramTypes?: AstNode[] }).paramTypes)) {
        for (const paramType of (node as { paramTypes: AstNode[] }).paramTypes) {
            annotateNode(paramType, metadata);
        }
    }

    if ("bindings" in node && Array.isArray((node as { bindings?: { bind: AstNode; value: AstNode }[] }).bindings)) {
        for (const binding of (node as { bindings: { bind: AstNode; value: AstNode }[] }).bindings) {
            annotateNode(binding.bind, metadata);
            annotateNode(binding.value, metadata);
        }
    }

    if ("clausesExprs" in node && Array.isArray((node as { clausesExprs?: { cond: AstNode; body: AstNode }[] }).clausesExprs)) {
        for (const clause of (node as { clausesExprs: { cond: AstNode; body: AstNode }[] }).clausesExprs) {
            annotateNode(clause.cond, metadata);
            annotateNode(clause.body, metadata);
        }
    }

    if ("branches" in node && Array.isArray((node as { branches?: { bind: AstNode; body: AstNode }[] }).branches)) {
        for (const branch of (node as { branches: { bind: AstNode; body: AstNode }[] }).branches) {
            annotateNode(branch.bind, metadata);
            annotateNode(branch.body, metadata);
        }
    }

    if ("propertyNodeList" in node && Array.isArray((node as { propertyNodeList?: AstNode[] }).propertyNodeList)) {
        for (const property of (node as { propertyNodeList: AstNode[] }).propertyNodeList) {
            annotateNode(property, metadata);
        }
    }

    if ("methodNodeList" in node && Array.isArray((node as { methodNodeList?: AstNode[] }).methodNodeList)) {
        for (const method of (node as { methodNodeList: AstNode[] }).methodNodeList) {
            annotateNode(method, metadata);
        }
    }

    if ("constructorNodeList" in node && Array.isArray((node as { constructorNodeList?: AstNode[] }).constructorNodeList)) {
        for (const ctor of (node as { constructorNodeList: AstNode[] }).constructorNodeList) {
            annotateNode(ctor, metadata);
        }
    }

    if ("genericTypeArgs" in node && Array.isArray((node as { genericTypeArgs?: AstNode[] }).genericTypeArgs)) {
        for (const typeArg of (node as { genericTypeArgs: AstNode[] }).genericTypeArgs) {
            annotateNode(typeArg, metadata);
        }
    }

    for (const key of ["unitId", "packagePath", "bind", "value", "body", "bodyExpr", "condExpr", "trueBranchExpr", "falseBranchExpr", "returnType", "callee", "unionExpr", "identifier", "var", "typeExp", "name", "methodName", "genericName", "inner"]) {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (child && typeof child === "object" && "kind" in (child as Record<string, unknown>)) {
            annotateNode(child as AstNode, metadata);
        }
    }
}

export function parseCompilationUnitId(unitId: string): CompilationUnitMetadata | null {
    const match = unitId.match(MODULE_UNIT_ID_PATTERN);
    if (match === null) {
        return null;
    }
    return {
        unitId,
        packageName: match[1],
        unitName: match[2],
        filePath: null
    };
}

export function annotateCompilationUnitExpressions(program: ProgramNode, metadata: CompilationUnitMetadata): void {
    for (const expression of program.topLevelExpressions) {
        annotateNode(expression, metadata);
    }
}

export function annotateAstWithCompilationUnitMetadata(node: AstNode, metadata: CompilationUnitMetadata): void {
    annotateNode(node, metadata);
}

export function ensureProgramCompilationUnitMetadata(program: ProgramNode): void {
    if (program.unitId !== null) {
        const parsedMetadata = parseCompilationUnitId(program.unitId.name);
        if (parsedMetadata === null) {
            throw new Error(`Program header must use a canonical compilation unit id '<package-path>@<unit-name>', got '${program.unitId.name}'`);
        }
        const existingFilePath = program.topLevelExpressions
            .map((expression) => getCompilationUnitMetadata(expression)?.filePath)
            .find((filePath): filePath is string => filePath !== null && filePath !== undefined)
            ?? null;
        annotateCompilationUnitExpressions(program, {
            ...parsedMetadata,
            filePath: existingFilePath
        });
        return;
    }

    const hasAnnotatedUnitExpressions = program.topLevelExpressions.some((expression) => getCompilationUnitMetadata(expression) !== undefined);
    if (!hasAnnotatedUnitExpressions) {
        throw new Error("Program must declare its compilation unit id in the program header");
    }
}

export function getCompilationUnitMetadata(node: AstNode): CompilationUnitMetadata | undefined {
    return nodeUnitMetadata.get(node);
}

export function copyCompilationUnitMetadata(source: AstNode, target: AstNode): void {
    const metadata = getCompilationUnitMetadata(source);
    if (metadata !== undefined) {
        annotateNode(target, metadata);
    }
}
