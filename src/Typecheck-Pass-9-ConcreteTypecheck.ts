import {
    AstNode,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    DeclaredDfunNode,
    DfunNode,
    DvarNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
    IdentifierNode,
    IfNode,
    ImportNode,
    LetNode,
    MatchNode,
    NumberLiteralNode,
    ProgramNode,
    SeqNode,
    SetNode,
    TextDatabaseReferenceNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
    WhileNode
} from "./AstNode";
import {
    createDiagnostic,
    getActiveConcreteTypecheckNode,
    IronwallDiagnosticError,
    withActiveConcreteTypecheckNode,
    wrapErrorAsDiagnostic
} from "./Diagnostics";
import {
    ClassTypeValue,
    FunctionTypeValue,
    GenericClassInstanceTypeValue,
    PrimitiveTypeValue,
    TypeValue,
    UnionTypeValue,
    builtinGenericTypeNames,
    isAssignable,
    typeEqual
} from "./TypeSystem";
import {
    getInstalledPrecompiledConcreteDefinitions,
    type InstalledPrecompiledConcreteClassDefinition,
    type InstalledPrecompiledConcreteFunctionDefinition,
    type InstalledPrecompiledConcreteGlobalDefinition
} from "./PrecompiledLib";

class ConcreteClassInfo {
    public readonly name: string;
    public readonly aliases: readonly string[];
    public readonly properties: ReadonlyMap<string, TypeValue>;
    public readonly methods: ReadonlyMap<string, FunctionTypeValue>;
    public readonly propertyNodes: readonly ClassPropertyNode[];
    public readonly methodNodes: readonly ClassMethodNode[];
    public readonly constructorNodes: readonly ClassConstructorNode[];
    public readonly constructorParamTypes: readonly (readonly TypeValue[])[];

    constructor(
        name: string,
        aliases: readonly string[],
        properties: ReadonlyMap<string, TypeValue>,
        methods: ReadonlyMap<string, FunctionTypeValue>,
        propertyNodes: readonly ClassPropertyNode[],
        methodNodes: readonly ClassMethodNode[],
        constructorNodes: readonly ClassConstructorNode[],
        constructorParamTypes: readonly (readonly TypeValue[])[]
    ) {
        this.name = name;
        this.aliases = aliases;
        this.properties = properties;
        this.methods = methods;
        this.propertyNodes = propertyNodes;
        this.methodNodes = methodNodes;
        this.constructorNodes = constructorNodes;
        this.constructorParamTypes = constructorParamTypes;
    }
}

class ConcreteFunctionInfo {
    public readonly name: string;
    public readonly functionType: FunctionTypeValue;
    public readonly params: readonly TypeVarBindNode[];
    public readonly returnTypeAst: AstNode;
    public readonly body: AstNode | null;
    public readonly isDeclared: boolean;

    constructor(name: string, functionType: FunctionTypeValue, params: readonly TypeVarBindNode[], returnTypeAst: AstNode, body: AstNode | null, isDeclared: boolean) {
        this.name = name;
        this.functionType = functionType;
        this.params = params;
        this.returnTypeAst = returnTypeAst;
        this.body = body;
        this.isDeclared = isDeclared;
    }
}

class ConcreteGlobalInfo {
    public readonly name: string;
    public readonly bind: TypeVarBindNode;
    public readonly initializer: AstNode;
    public readonly type: TypeValue;

    constructor(name: string, bind: TypeVarBindNode, initializer: AstNode, type: TypeValue) {
        this.name = name;
        this.bind = bind;
        this.initializer = initializer;
        this.type = type;
    }
}

class ConcreteVarEnv {
    private readonly env: Map<string, TypeValue>;
    private readonly immutableBindings: Set<string>;
    public readonly parent?: ConcreteVarEnv;

    constructor(parent?: ConcreteVarEnv) {
        this.env = new Map<string, TypeValue>();
        this.immutableBindings = new Set<string>();
        this.parent = parent;
    }

    get(name: string): TypeValue | undefined {
        if (this.env.has(name)) {
            return this.env.get(name);
        }
        if (this.parent !== undefined) {
            return this.parent.get(name);
        }
        return undefined;
    }

    has(name: string): boolean {
        return this.get(name) !== undefined;
    }

    set(name: string, value: TypeValue): void {
        this.env.set(name, value);
    }

    setImmutable(name: string, value: TypeValue): void {
        this.env.set(name, value);
        this.immutableBindings.add(name);
    }

    isImmutable(name: string): boolean {
        if (this.env.has(name)) {
            return this.immutableBindings.has(name);
        }
        if (this.parent !== undefined) {
            return this.parent.isImmutable(name);
        }
        return false;
    }

    extend(): ConcreteVarEnv {
        return new ConcreteVarEnv(this);
    }
}

class ConcreteProgramContext {
    private readonly classNames: Set<string>;
    private readonly classAliases: Map<string, string>;
    private readonly classInfoTable: Map<string, ConcreteClassInfo>;
    private readonly functionTable: Map<string, ConcreteFunctionInfo[]>;
    private readonly globalTable: Map<string, ConcreteGlobalInfo>;

    constructor(program: ProgramNode) {
        this.classNames = new Set<string>();
        this.classAliases = new Map<string, string>();
        this.classInfoTable = new Map<string, ConcreteClassInfo>();
        this.functionTable = new Map<string, ConcreteFunctionInfo[]>();
        this.globalTable = new Map<string, ConcreteGlobalInfo>();
        this.collectInstalledPrecompiledInfo();
        this.collectClassNames(program);
        this.collectConcreteTopLevelInfo(program);
    }

    private collectInstalledPrecompiledInfo(): void {
        const installedDefinitions = getInstalledPrecompiledConcreteDefinitions();
        for (const classInfo of installedDefinitions.classes) {
            this.registerExternalClassInfo(classInfo);
        }
        for (const functionInfo of installedDefinitions.functions) {
            this.registerExternalFunctionInfo(functionInfo);
        }
        for (const globalInfo of installedDefinitions.globals) {
            this.registerExternalGlobalInfo(globalInfo);
        }
    }

    private collectClassNames(program: ProgramNode): void {
        for (const expression of program.topLevelExpressions) {
            if (expression instanceof ClassNode) {
                this.classNames.add(expression.name.name);
                this.classAliases.set(expression.name.name, expression.name.name);
            }
        }
    }

    private collectConcreteTopLevelInfo(program: ProgramNode): void {
        for (const expression of program.topLevelExpressions) {
            if (expression instanceof ImportNode) {
                continue;
            }
            if (expression instanceof GenericClassNode || expression instanceof GenericDfunNode) {
                throw new Error("Concrete typecheck received generic top-level definitions");
            }
            if (expression instanceof ClassNode) {
                this.registerClassInfo(expression);
                continue;
            }
            if (expression instanceof DfunNode) {
                this.registerFunctionInfo(expression, false);
                continue;
            }
            if (expression instanceof DeclaredDfunNode) {
                this.registerFunctionInfo(expression, true);
                continue;
            }
            if (expression instanceof DvarNode) {
                this.registerGlobalInfo(expression);
            }
        }
    }

    private registerClassInfo(node: ClassNode): void {
        const propertyTypes = new Map<string, TypeValue>();
        for (const property of node.propertyNodeList) {
            propertyTypes.set(property.bind.var.name, this.typeAstToTypeValue(property.bind.typeExp));
        }
        const methodTypes = new Map<string, FunctionTypeValue>();
        for (const method of node.methodNodeList) {
            methodTypes.set(
                method.methodName.name,
                new FunctionTypeValue(
                    method.params.map((param) => this.typeAstToTypeValue(param.typeExp)),
                    this.typeAstToTypeValue(method.returnType)
                )
            );
        }
        const constructorParamTypes: TypeValue[][] = [];
        for (const constructor of node.constructorNodeList) {
            const paramTypes: TypeValue[] = [];
            for (const param of constructor.params) {
                paramTypes.push(this.typeAstToTypeValue(param.typeExp));
            }
            constructorParamTypes.push(paramTypes);
        }
        this.classInfoTable.set(
            node.name.name,
            new ConcreteClassInfo(
                node.name.name,
                [node.name.name],
                propertyTypes,
                methodTypes,
                node.propertyNodeList,
                node.methodNodeList,
                node.constructorNodeList,
                constructorParamTypes
            )
        );
    }

    private registerExternalClassInfo(info: InstalledPrecompiledConcreteClassDefinition): void {
        this.classNames.add(info.concreteName);
        for (const alias of info.aliases) {
            this.classAliases.set(alias, info.concreteName);
        }
        this.classInfoTable.set(
            info.concreteName,
            new ConcreteClassInfo(
                info.concreteName,
                info.aliases,
                info.propertyTypes,
                info.methodTypes,
                [],
                [],
                [],
                info.constructorParamTypes
            )
        );
    }

    private registerFunctionInfo(node: DfunNode | DeclaredDfunNode, isDeclared: boolean): void {
        const functionType = new FunctionTypeValue(
            node.params.map((param) => this.typeAstToTypeValue(param.typeExp)),
            this.typeAstToTypeValue(node.returnType)
        );
        const overloads = this.functionTable.get(node.name.name) ?? [];
        overloads.push(new ConcreteFunctionInfo(node.name.name, functionType, node.params, node.returnType, node instanceof DfunNode ? node.body : null, isDeclared));
        this.functionTable.set(node.name.name, overloads);
    }

    private registerExternalFunctionInfo(info: InstalledPrecompiledConcreteFunctionDefinition): void {
        for (const alias of info.aliases) {
            const overloads = this.functionTable.get(alias) ?? [];
            if (overloads.some((existing) => typeEqual(existing.functionType, info.functionType))) {
                this.functionTable.set(alias, overloads);
                continue;
            }
            overloads.push(new ConcreteFunctionInfo(alias, info.functionType, [], new IdentifierNode("unit"), null, true));
            this.functionTable.set(alias, overloads);
        }
    }

    private registerGlobalInfo(node: DvarNode): void {
        if (!(node.bind instanceof TypeVarBindNode)) {
            throw new Error("Concrete top-level var requires type binding");
        }
        this.globalTable.set(node.bind.var.name, new ConcreteGlobalInfo(node.bind.var.name, node.bind, node.value, this.typeAstToTypeValue(node.bind.typeExp)));
    }

    private registerExternalGlobalInfo(info: InstalledPrecompiledConcreteGlobalDefinition): void {
        for (const alias of info.aliases) {
            this.globalTable.set(
                alias,
                new ConcreteGlobalInfo(
                    alias,
                    new TypeVarBindNode(new IdentifierNode(alias), new IdentifierNode("unit")),
                    new IdentifierNode("unit"),
                    info.type
                )
            );
        }
    }

    public typeAstToTypeValue(astNode: AstNode): TypeValue {
        if (astNode instanceof IdentifierNode) {
            if (isPrimitiveTypeName(astNode.name)) {
                return new PrimitiveTypeValue(astNode.name);
            }
            const concreteClassName = this.classAliases.get(astNode.name);
            if (concreteClassName !== undefined && this.classNames.has(concreteClassName)) {
                return new ClassTypeValue(concreteClassName);
            }
            throw new Error(`Unknown concrete type identifier: ${astNode.name}`);
        }
        if (astNode instanceof TypeToFromNode) {
            return new FunctionTypeValue(
                astNode.paramTypes.map((paramType) => this.typeAstToTypeValue(paramType)),
                this.typeAstToTypeValue(astNode.returnType)
            );
        }
        if (astNode instanceof TypeUnionNode) {
            return new UnionTypeValue(astNode.types.map((typeNode) => this.typeAstToTypeValue(typeNode)));
        }
        if (astNode instanceof GenericCallNode && astNode.callee instanceof IdentifierNode && builtinGenericTypeNames.has(astNode.callee.name) && astNode.callee.name === "array" && astNode.typeArgs.length === 1) {
            return new GenericClassInstanceTypeValue("array", [this.typeAstToTypeValue(astNode.typeArgs[0])]);
        }
        throw new Error(`Invalid concrete type expression: ${formatAst(astNode)}`);
    }

    public getClassInfo(name: string): ConcreteClassInfo | undefined {
        const concreteClassName = this.classAliases.get(name) ?? name;
        return this.classInfoTable.get(concreteClassName);
    }

    public getFunctionOverloads(name: string): readonly ConcreteFunctionInfo[] {
        return this.functionTable.get(name) ?? [];
    }

    public getGlobalInfo(name: string): ConcreteGlobalInfo | undefined {
        return this.globalTable.get(name);
    }
}

export class ConcreteTypeCheckError extends IronwallDiagnosticError {
    constructor(message: string) {
        super(createDiagnostic("concrete-typecheck", "CONCRETE_TYPECHECK_ERROR", `[ConcreteTypeCheck Error] ${message}`, {
            ast: getActiveConcreteTypecheckNode(),
        }));
        this.name = "ConcreteTypeCheckError";
    }
}

function isPrimitiveTypeName(name: string): boolean {
    return [
        "i5", "i6", "i7",
        "u5", "u6", "u7",
        "f5", "f6", "f7",
        "z5", "z6", "z7",
        "c3", "c4", "c5",
        "s3", "s4", "s5",
        "bool", "unit"
    ].includes(name);
}

function formatType(type: TypeValue): string {
    if (type instanceof PrimitiveTypeValue) {
        return type.name;
    }
    if (type instanceof ClassTypeValue) {
        return type.className;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return `<${type.genericName} ${type.typeArgs.map((typeArg) => formatType(typeArg)).join(" ")}>`;
    }
    if (type instanceof FunctionTypeValue) {
        return `<to ${formatType(type.returnType)} from ${type.paramTypes.map((paramType) => formatType(paramType)).join(" ")}>`;
    }
    if (type instanceof UnionTypeValue) {
        return `<union ${type.types.map((member) => formatType(member)).join(" ")}>`;
    }
    return "<unexpected-type>";
}

function formatAst(ast: AstNode): string {
    if (ast instanceof IdentifierNode) {
        return ast.name;
    }
    if (ast instanceof TextDatabaseReferenceNode) {
        return ast.referenceName;
    }
    if (ast instanceof NumberLiteralNode) {
        return ast.raw;
    }
    if (ast instanceof GenericCallNode) {
        return `<${formatAst(ast.callee)} ${ast.typeArgs.map((typeArg) => formatAst(typeArg)).join(" ")}>`;
    }
    if (ast instanceof TypeToFromNode) {
        return `<to ${formatAst(ast.returnType)} from ${ast.paramTypes.map((paramType) => formatAst(paramType)).join(" ")}>`;
    }
    if (ast instanceof TypeUnionNode) {
        return `<union ${ast.types.map((typeNode) => formatAst(typeNode)).join(" ")}>`;
    }
    return `<${String(ast.kind)}>`;
}

function isMatchUnreachableCall(ast: AstNode): ast is FunctionCallNode {
    return ast instanceof FunctionCallNode
        && ast.callee instanceof IdentifierNode
        && ast.callee.name === "iw_match_unreachable";
}

function buildBuiltinCallCandidates(funcName: string): readonly FunctionTypeValue[] {
    const boolType = new PrimitiveTypeValue("bool");
    const i5Type = new PrimitiveTypeValue("i5");
    const integerTypes = ["i5", "i6", "i7", "u5", "u6", "u7"].map((name) => new PrimitiveTypeValue(name));
    const floatTypes = ["f5", "f6", "f7"].map((name) => new PrimitiveTypeValue(name));
    const charTypes = ["c3", "c4", "c5"].map((name) => new PrimitiveTypeValue(name));
    const stringFamilies = [
        { stringType: new PrimitiveTypeValue("s3"), charType: new PrimitiveTypeValue("c3") },
        { stringType: new PrimitiveTypeValue("s4"), charType: new PrimitiveTypeValue("c4") },
        { stringType: new PrimitiveTypeValue("s5"), charType: new PrimitiveTypeValue("c5") }
    ];
    const complexFamilies = [
        { complexType: new PrimitiveTypeValue("z5"), floatType: new PrimitiveTypeValue("f5") },
        { complexType: new PrimitiveTypeValue("z6"), floatType: new PrimitiveTypeValue("f6") },
        { complexType: new PrimitiveTypeValue("z7"), floatType: new PrimitiveTypeValue("f7") }
    ];

    const valueConversionMatch: RegExpMatchArray | null = funcName.match(/^val_to_([a-z0-9]+)$/);
    if (valueConversionMatch !== null) {
        const targetTypeName = valueConversionMatch[1];
        if (["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"].includes(targetTypeName)) {
            const targetType = new PrimitiveTypeValue(targetTypeName);
            const sourceTypes = [
                ...integerTypes,
                ...floatTypes,
                ...((targetTypeName === "i5" || targetTypeName === "u5") ? charTypes : [])
            ];
            return sourceTypes.map((sourceType) => new FunctionTypeValue([sourceType], targetType));
        }
        return [];
    }

    const binaryConversionMatch: RegExpMatchArray | null = funcName.match(/^bin_to_([a-z0-9]+)$/);
    if (binaryConversionMatch !== null) {
        const targetTypeName = binaryConversionMatch[1];
        if (["i5", "i6", "i7", "u5", "u6", "u7", "f5", "f6", "f7"].includes(targetTypeName)) {
            const targetType = new PrimitiveTypeValue(targetTypeName);
            const sourceTypes = [
                ...integerTypes,
                ...floatTypes,
                ...((targetTypeName === "i5" || targetTypeName === "u5") ? charTypes : [])
            ];
            return sourceTypes.map((sourceType) => new FunctionTypeValue([sourceType], targetType));
        }
        return [];
    }

    if (["add", "sub", "mul", "div", "mod"].includes(funcName)) {
        return [
            ...integerTypes.map((type) => new FunctionTypeValue([type, type], type)),
            ...floatTypes.map((type) => new FunctionTypeValue([type, type], type))
        ];
    }
    if (["le", "lt", "ge", "gt", "eq", "neq"].includes(funcName)) {
        return [
            ...integerTypes.map((type) => new FunctionTypeValue([type, type], boolType)),
            ...floatTypes.map((type) => new FunctionTypeValue([type, type], boolType)),
            ...charTypes.map((type) => new FunctionTypeValue([type, type], boolType))
        ];
    }
    if (["and", "or", "xor"].includes(funcName)) {
        return [new FunctionTypeValue([boolType, boolType], boolType)];
    }
    if (funcName === "not") {
        return [new FunctionTypeValue([boolType], boolType)];
    }
    if (["bwand", "bwor", "bwxor", "ls", "rs"].includes(funcName)) {
        return integerTypes.map((type) => new FunctionTypeValue([type, type], type));
    }
    for (const family of stringFamilies) {
        const prefix = family.stringType.name;
        if (funcName === `${prefix}_new`) {
            return [
                new FunctionTypeValue([], family.stringType),
                new FunctionTypeValue([family.stringType], family.stringType),
                new FunctionTypeValue([i5Type, family.charType], family.stringType)
            ];
        }
        if (funcName === `${prefix}_get`) {
            return [new FunctionTypeValue([family.stringType, i5Type], family.charType)];
        }
        if (funcName === `${prefix}_set`) {
            return [new FunctionTypeValue([family.stringType, i5Type, family.charType], new PrimitiveTypeValue("unit"))];
        }
        if (funcName === `${prefix}_length`) {
            return [new FunctionTypeValue([family.stringType], i5Type)];
        }
    }
    for (const family of complexFamilies) {
        const prefix = family.complexType.name;
        if (funcName === `${prefix}_new`) {
            return [
                new FunctionTypeValue([], family.complexType),
                new FunctionTypeValue([family.complexType], family.complexType)
            ];
        }
        if (funcName === `${prefix}_set`) {
            return [
                new FunctionTypeValue([family.complexType, family.complexType], new PrimitiveTypeValue("unit")),
                new FunctionTypeValue([family.complexType, family.floatType, family.floatType], new PrimitiveTypeValue("unit"))
            ];
        }
        if (funcName === `${prefix}_real` || funcName === `${prefix}_img`) {
            return [new FunctionTypeValue([family.complexType], family.floatType)];
        }
    }
    return [];
}

function materializeExpectedType(type: TypeValue): TypeValue {
    if (type instanceof FunctionTypeValue) {
        return new FunctionTypeValue(
            type.paramTypes.map((paramType) => materializeExpectedType(paramType)),
            materializeExpectedType(type.returnType)
        );
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return new GenericClassInstanceTypeValue(type.genericName, type.typeArgs.map((typeArg) => materializeExpectedType(typeArg)));
    }
    if (type instanceof UnionTypeValue) {
        return new UnionTypeValue(type.types.map((member) => materializeExpectedType(member)));
    }
    return type;
}

function resolveOverloadByExpectedType(context: ConcreteProgramContext, name: string, expectedType: TypeValue): FunctionTypeValue | undefined {
    const matches = context.getFunctionOverloads(name).filter((overload) => isAssignable(overload.functionType, materializeExpectedType(expectedType)));
    if (matches.length === 1) {
        return matches[0].functionType;
    }
    if (matches.length > 1) {
        throw new ConcreteTypeCheckError(`Ambiguous overloaded function value: ${name}`);
    }
    const builtinMatches = buildBuiltinCallCandidates(name).filter((candidate) => isAssignable(candidate, materializeExpectedType(expectedType)));
    if (builtinMatches.length === 1) {
        return builtinMatches[0];
    }
    if (builtinMatches.length > 1) {
        throw new ConcreteTypeCheckError(`Ambiguous builtin function value: ${name}`);
    }
    return undefined;
}

function getNamedFunctionType(context: ConcreteProgramContext, name: string, expectedType?: TypeValue): FunctionTypeValue | undefined {
    const overloads = context.getFunctionOverloads(name);
    if (overloads.length === 1) {
        return overloads[0].functionType;
    }
    if (overloads.length > 1 && expectedType !== undefined) {
        return resolveOverloadByExpectedType(context, name, expectedType);
    }
    const builtinCandidates = buildBuiltinCallCandidates(name);
    if (builtinCandidates.length === 1) {
        return builtinCandidates[0];
    }
    if (builtinCandidates.length > 1 && expectedType !== undefined) {
        return resolveOverloadByExpectedType(context, name, expectedType);
    }
    return undefined;
}

function resolveNamedCallByArguments(context: ConcreteProgramContext, name: string, args: readonly AstNode[], varEnv: ConcreteVarEnv): FunctionTypeValue | undefined {
    const overloads = context.getFunctionOverloads(name).filter((overload) => overload.functionType.paramTypes.length === args.length);
    const matches: FunctionTypeValue[] = [];
    for (const overload of overloads) {
        let compatible = true;
        try {
            overload.functionType.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(context, args[index], paramType, varEnv);
            });
        } catch {
            compatible = false;
        }
        if (compatible) {
            matches.push(overload.functionType);
        }
    }
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheckConcreteAst(context, arg, varEnv));
        const exactMatches = matches.filter((candidate) => candidate.paramTypes.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new ConcreteTypeCheckError(`Ambiguous overloaded call to ${name}`);
    }
    return undefined;
}

function resolveBuiltinCallByArguments(context: ConcreteProgramContext, funcName: string, args: readonly AstNode[], varEnv: ConcreteVarEnv): FunctionTypeValue | undefined {
    const matches: FunctionTypeValue[] = [];
    for (const candidate of buildBuiltinCallCandidates(funcName).filter((candidate) => candidate.paramTypes.length === args.length)) {
        let compatible = true;
        try {
            candidate.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(context, args[index], paramType, varEnv);
            });
        } catch {
            compatible = false;
        }
        if (compatible) {
            matches.push(candidate);
        }
    }
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheckConcreteAst(context, arg, varEnv));
        const exactMatches = matches.filter((candidate) => candidate.paramTypes.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new ConcreteTypeCheckError(`Ambiguous builtin call to ${funcName}`);
    }
    return undefined;
}

interface ConcreteConstructorOverloadCandidate {
    readonly paramTypes: readonly TypeValue[];
}

function resolveConcreteConstructorOverloadByArguments(
    className: string,
    constructors: readonly ConcreteConstructorOverloadCandidate[],
    args: readonly AstNode[],
    context: ConcreteProgramContext,
    varEnv: ConcreteVarEnv
): readonly TypeValue[] {
    const arityMatches = constructors.filter((constructor) => constructor.paramTypes.length === args.length);
    const matches: (readonly TypeValue[])[] = [];

    for (const constructor of arityMatches) {
        let compatible = true;
        try {
            constructor.paramTypes.forEach((paramType, index) => {
                typecheckAgainstExpectedType(context, args[index], paramType, varEnv);
            });
        } catch {
            compatible = false;
        }
        if (compatible) {
            matches.push(constructor.paramTypes);
        }
    }

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        const actualArgTypes = args.map((arg) => typecheckConcreteAst(context, arg, varEnv));
        const exactMatches = matches.filter((candidate) => candidate.every((paramType, index) => typeEqual(paramType, actualArgTypes[index])));
        if (exactMatches.length === 1) {
            return exactMatches[0];
        }
        throw new ConcreteTypeCheckError(`Ambiguous constructor call to ${className}`);
    }

    const actualArgTypes = args.map((arg) => typecheckConcreteAst(context, arg, varEnv));
    throw new ConcreteTypeCheckError(`No constructor overload of ${className} matches argument types (${actualArgTypes.map((type) => formatType(type)).join(", ")})`);
}

function hasZeroArgConcreteConstructor(constructors: readonly ConcreteConstructorOverloadCandidate[]): boolean {
    return constructors.some((constructor) => constructor.paramTypes.length === 0);
}

function typecheckAgainstExpectedType(context: ConcreteProgramContext, ast: AstNode, expectedType: TypeValue, varEnv: ConcreteVarEnv): TypeValue {
    return withActiveConcreteTypecheckNode(ast, (): TypeValue => {
        const concreteExpectedType = materializeExpectedType(expectedType);
        if (isMatchUnreachableCall(ast)) {
            if (ast.args.length !== 0) {
                throw new ConcreteTypeCheckError("iw_match_unreachable expects exactly 0 arguments");
            }
            return concreteExpectedType;
        }
        if (ast instanceof SeqNode) {
            if (ast.expressions.length === 0) {
                throw new ConcreteTypeCheckError("Seq requires at least one expression");
            }
            for (let index = 0; index < ast.expressions.length - 1; index += 1) {
                typecheckConcreteAst(context, ast.expressions[index], varEnv);
            }
            return typecheckAgainstExpectedType(context, ast.expressions[ast.expressions.length - 1], concreteExpectedType, varEnv);
        }
        if (ast instanceof ProgramNode) {
            if (ast.topLevelExpressions.length === 0) {
                throw new ConcreteTypeCheckError("Program requires at least one top-level expression");
            }
            ast.topLevelExpressions.forEach((expression) => typecheckConcreteAst(context, expression, varEnv));
            const unitType = new PrimitiveTypeValue("unit");
            if (!isAssignable(unitType, concreteExpectedType)) {
                throw new ConcreteTypeCheckError(`Type mismatch: expected ${formatType(concreteExpectedType)}, got ${formatType(unitType)}`);
            }
            return unitType;
        }
        if (ast instanceof IfNode) {
            const condType = typecheckConcreteAst(context, ast.condExpr, varEnv);
            const boolType = new PrimitiveTypeValue("bool");
            if (!typeEqual(condType, boolType)) {
                throw new ConcreteTypeCheckError(`If condition must be bool, got ${formatType(condType)}`);
            }
            typecheckAgainstExpectedType(context, ast.trueBranchExpr, concreteExpectedType, varEnv);
            typecheckAgainstExpectedType(context, ast.falseBranchExpr, concreteExpectedType, varEnv);
            return concreteExpectedType;
        }
        if (ast instanceof CondNode) {
            const boolType = new PrimitiveTypeValue("bool");
            ast.clausesExprs.forEach((clause, index) => {
                const isElseClause = clause.cond instanceof IdentifierNode && clause.cond.name === "else";
                if (isElseClause) {
                    if (index !== ast.clausesExprs.length - 1) {
                        throw new ConcreteTypeCheckError("Cond else clause must be the last clause");
                    }
                } else {
                    const condType = typecheckConcreteAst(context, clause.cond, varEnv);
                    if (!typeEqual(condType, boolType)) {
                        throw new ConcreteTypeCheckError(`Cond condition must be bool, got ${formatType(condType)}`);
                    }
                }
                typecheckAgainstExpectedType(context, clause.body, concreteExpectedType, varEnv);
            });
            return concreteExpectedType;
        }
        if (ast instanceof MatchNode) {
            const unionType = typecheckConcreteAst(context, ast.unionExpr, varEnv);
            if (!(unionType instanceof UnionTypeValue)) {
                throw new ConcreteTypeCheckError(`Match expression must be union type, got ${formatType(unionType)}`);
            }
        const coveredTypes = new Set<string>();
        for (const branch of ast.branches) {
            const branchType = context.typeAstToTypeValue(branch.bind.typeExp);
            const branchKey = formatType(branchType);
            if (!unionType.types.some((member) => typeEqual(member, branchType))) {
                throw new ConcreteTypeCheckError(`Match branch type ${branchKey} is not a member of union type`);
            }
            if (coveredTypes.has(branchKey)) {
                throw new ConcreteTypeCheckError(`Duplicate match branch for type ${branchKey}`);
            }
            coveredTypes.add(branchKey);
            const branchVarEnv = varEnv.extend();
            branchVarEnv.set(branch.bind.var.name, branchType);
            typecheckAgainstExpectedType(context, branch.body, concreteExpectedType, branchVarEnv);
        }
        if (coveredTypes.size !== unionType.types.length) {
            throw new ConcreteTypeCheckError("Match must cover all union type members");
        }
        return concreteExpectedType;
    }
        if (ast instanceof IdentifierNode && !varEnv.has(ast.name)) {
            const overloadType = resolveOverloadByExpectedType(context, ast.name, concreteExpectedType);
            if (overloadType !== undefined) {
                return overloadType;
            }
        }
        const actualType = typecheckConcreteAst(context, ast, varEnv);
        const concreteActualType = materializeExpectedType(actualType);
        if (!isAssignable(concreteActualType, concreteExpectedType)) {
            throw new ConcreteTypeCheckError(`Type mismatch: expected ${formatType(concreteExpectedType)}, got ${formatType(concreteActualType)}`);
        }
        return concreteActualType;
    });
}

function validateArrayElementConstructorConstraint(context: ConcreteProgramContext, elementType: TypeValue): void {
    if (elementType instanceof ClassTypeValue) {
        const classInfo = context.getClassInfo(elementType.className);
        if (classInfo !== undefined) {
            const constructorOverloads = classInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes }));
            if (!hasZeroArgConcreteConstructor(constructorOverloads)) {
                throw new ConcreteTypeCheckError(`array_new requires class ${elementType.className} to have a zero-arg constructor when used as an array element type`);
            }
        }
    }
}

function typeHasBuiltinZeroArgInitializer(type: TypeValue): boolean {
    if (type instanceof PrimitiveTypeValue) {
        return type.name === "s3"
            || type.name === "s4"
            || type.name === "s5"
            || type.name === "z5"
            || type.name === "z6"
            || type.name === "z7";
    }
    return false;
}

function typeSupportsZeroArgInitialization(type: TypeValue, context: ConcreteProgramContext | null): boolean {
    if (typeHasBuiltinZeroArgInitializer(type)) {
        return true;
    }
    if (type instanceof GenericClassInstanceTypeValue) {
        return type.genericName === "array"
            && type.typeArgs.length === 1
            && typeSupportsZeroArgInitialization(type.typeArgs[0], context);
    }
    if (context !== null && type instanceof ClassTypeValue) {
        const classInfo = context.getClassInfo(type.className);
        return classInfo !== undefined
            && hasZeroArgConcreteConstructor(classInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes })));
    }
    return false;
}

function validateZeroArgInitializationSupport(context: ConcreteProgramContext, type: TypeValue, usageContext: string): void {
    if (!typeSupportsZeroArgInitialization(type, context)) {
        throw new ConcreteTypeCheckError(`${usageContext} requires type ${formatType(type)} to support a zero-arg constructor or builtin default initializer`);
    }
}

function typecheckArrayNew(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 1 && args.length !== 3) {
        throw new ConcreteTypeCheckError("array_new requires either 1 argument (array type) or 3 arguments (array type, length, and initial value)");
    }
    const arrayType = context.typeAstToTypeValue(args[0]);
    if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
        throw new ConcreteTypeCheckError("array_new requires a concrete array type as its first argument");
    }
    if (args.length === 1) {
        validateZeroArgInitializationSupport(context, arrayType.typeArgs[0], "array_new with zero runtime arguments");
        return arrayType;
    }
    validateArrayElementConstructorConstraint(context, arrayType.typeArgs[0]);
    typecheckAgainstExpectedType(context, args[1], new PrimitiveTypeValue("i5"), varEnv);
    typecheckAgainstExpectedType(context, args[2], arrayType.typeArgs[0], varEnv);
    return arrayType;
}

function typecheckArrayGet(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 2) {
        throw new ConcreteTypeCheckError("array_get requires exactly 2 arguments: array and index");
    }
    const arrayType = typecheckConcreteAst(context, args[0], varEnv);
    if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
        throw new ConcreteTypeCheckError("array_get requires value of type <array T>");
    }
    typecheckAgainstExpectedType(context, args[1], new PrimitiveTypeValue("i5"), varEnv);
    return arrayType.typeArgs[0];
}

function typecheckArraySet(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 3) {
        throw new ConcreteTypeCheckError("array_set requires exactly 3 arguments: array, index, and value");
    }
    const arrayType = typecheckConcreteAst(context, args[0], varEnv);
    if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array" || arrayType.typeArgs.length !== 1) {
        throw new ConcreteTypeCheckError("array_set requires value of type <array T>");
    }
    typecheckAgainstExpectedType(context, args[1], new PrimitiveTypeValue("i5"), varEnv);
    typecheckAgainstExpectedType(context, args[2], arrayType.typeArgs[0], varEnv);
    return new PrimitiveTypeValue("unit");
}

function typecheckArrayLength(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 1) {
        throw new ConcreteTypeCheckError("array_length requires exactly 1 argument");
    }
    const arrayType = typecheckConcreteAst(context, args[0], varEnv);
    if (!(arrayType instanceof GenericClassInstanceTypeValue) || arrayType.genericName !== "array") {
        throw new ConcreteTypeCheckError("array_length requires value of type <array T>");
    }
    return new PrimitiveTypeValue("i5");
}

function typecheckNew(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length === 0) {
        throw new ConcreteTypeCheckError("class_new requires class name");
    }
    if (!(args[0] instanceof IdentifierNode)) {
        throw new ConcreteTypeCheckError(`Concrete class_new expects an identifier class name, got ${formatAst(args[0])}`);
    }
    const classInfo = context.getClassInfo(args[0].name);
    if (classInfo === undefined) {
        throw new ConcreteTypeCheckError(`Unknown class: ${args[0].name}`);
    }
    const constructorParamTypes = resolveConcreteConstructorOverloadByArguments(
        classInfo.name,
        classInfo.constructorParamTypes.map((paramTypes) => ({ paramTypes })),
        args.slice(1),
        context,
        varEnv
    );
    for (let index = 0; index < constructorParamTypes.length; index += 1) {
        typecheckAgainstExpectedType(context, args[index + 1], constructorParamTypes[index], varEnv);
    }
    return new ClassTypeValue(classInfo.name);
}

function typecheckGetClassMember(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 2 || !(args[1] instanceof IdentifierNode)) {
        throw new ConcreteTypeCheckError("cm_get requires exactly 2 arguments: object and member name identifier");
    }
    const objectType = typecheckConcreteAst(context, args[0], varEnv);
    if (!(objectType instanceof ClassTypeValue)) {
        throw new ConcreteTypeCheckError(`cm_get requires class instance, got ${formatType(objectType)}`);
    }
    const classInfo = context.getClassInfo(objectType.className);
    if (classInfo === undefined) {
        throw new ConcreteTypeCheckError(`Unknown class: ${objectType.className}`);
    }
    const propertyType = classInfo.properties.get(args[1].name);
    if (propertyType !== undefined) {
        return propertyType;
    }
    const methodType = classInfo.methods.get(args[1].name);
    if (methodType !== undefined) {
        return methodType;
    }
    throw new ConcreteTypeCheckError(`Member ${args[1].name} not found in class ${objectType.className}`);
}

function typecheckSetClassMember(context: ConcreteProgramContext, args: readonly AstNode[], varEnv: ConcreteVarEnv): TypeValue {
    if (args.length !== 3 || !(args[1] instanceof IdentifierNode)) {
        throw new ConcreteTypeCheckError("cm_set requires exactly 3 arguments: object, member name identifier, and value");
    }
    const objectType = typecheckConcreteAst(context, args[0], varEnv);
    if (!(objectType instanceof ClassTypeValue)) {
        throw new ConcreteTypeCheckError(`cm_set requires class instance, got ${formatType(objectType)}`);
    }
    const classInfo = context.getClassInfo(objectType.className);
    if (classInfo === undefined) {
        throw new ConcreteTypeCheckError(`Unknown class: ${objectType.className}`);
    }
    const propertyType = classInfo.properties.get(args[1].name);
    if (propertyType === undefined) {
        throw new ConcreteTypeCheckError(`Property ${args[1].name} not found in class ${objectType.className}`);
    }
    typecheckAgainstExpectedType(context, args[2], propertyType, varEnv);
    return new PrimitiveTypeValue("unit");
}

function typecheckFunctionCall(context: ConcreteProgramContext, node: FunctionCallNode, varEnv: ConcreteVarEnv): TypeValue {
    if (node.callee instanceof GenericCallNode
        && node.callee.callee instanceof IdentifierNode
        && node.callee.callee.name === "class_new"
        && node.callee.typeArgs.length === 1
        && node.callee.typeArgs[0] instanceof IdentifierNode) {
        return typecheckNew(context, [node.callee.typeArgs[0], ...node.args], varEnv);
    }
    if (node.callee instanceof IdentifierNode) {
        if (node.callee.name === "iw_match_unreachable") {
            if (node.args.length !== 0) {
                throw new ConcreteTypeCheckError("iw_match_unreachable expects exactly 0 arguments");
            }
            return new PrimitiveTypeValue("unit");
        }
        if (node.callee.name === "class_new") {
            return typecheckNew(context, node.args, varEnv);
        }
        if (node.callee.name === "cm_get") {
            return typecheckGetClassMember(context, node.args, varEnv);
        }
        if (node.callee.name === "cm_set") {
            return typecheckSetClassMember(context, node.args, varEnv);
        }
        if (node.callee.name === "array_new") {
            return typecheckArrayNew(context, node.args, varEnv);
        }
        if (node.callee.name === "array_get") {
            return typecheckArrayGet(context, node.args, varEnv);
        }
        if (node.callee.name === "array_set") {
            return typecheckArraySet(context, node.args, varEnv);
        }
        if (node.callee.name === "array_length") {
            return typecheckArrayLength(context, node.args, varEnv);
        }
        const builtinType = resolveBuiltinCallByArguments(context, node.callee.name, node.args, varEnv);
        if (builtinType !== undefined) {
            return builtinType.returnType;
        }
        const overloadType = resolveNamedCallByArguments(context, node.callee.name, node.args, varEnv);
        if (overloadType !== undefined) {
            return overloadType.returnType;
        }
        if (context.getFunctionOverloads(node.callee.name).length > 0 || buildBuiltinCallCandidates(node.callee.name).length > 0) {
            const argTypes = node.args.map((arg) => typecheckConcreteAst(context, arg, varEnv));
            throw new ConcreteTypeCheckError(`No overload of ${node.callee.name} matches argument types (${argTypes.map((type) => formatType(type)).join(", ")})`);
        }
    }
    const calleeType = materializeExpectedType(typecheckConcreteAst(context, node.callee, varEnv));
    if (!(calleeType instanceof FunctionTypeValue)) {
        throw new ConcreteTypeCheckError(`Cannot call non-function type: ${formatType(calleeType)}`);
    }
    if (calleeType.paramTypes.length !== node.args.length) {
        throw new ConcreteTypeCheckError(`Function call expects ${calleeType.paramTypes.length} arguments, got ${node.args.length}`);
    }
    for (let index = 0; index < calleeType.paramTypes.length; index += 1) {
        typecheckAgainstExpectedType(context, node.args[index], calleeType.paramTypes[index], varEnv);
    }
    return calleeType.returnType;
}

function typecheckClassDefinition(context: ConcreteProgramContext, node: ClassNode, varEnv: ConcreteVarEnv): void {
    const selfType = new ClassTypeValue(node.name.name);
    for (const method of node.methodNodeList) {
        const methodVarEnv = varEnv.extend();
        methodVarEnv.setImmutable("self", selfType);
        for (const param of method.params) {
            methodVarEnv.setImmutable(param.var.name, context.typeAstToTypeValue(param.typeExp));
        }
        typecheckAgainstExpectedType(context, method.body, context.typeAstToTypeValue(method.returnType), methodVarEnv);
    }
    for (const ctor of node.constructorNodeList) {
        const ctorVarEnv = varEnv.extend();
        ctorVarEnv.setImmutable("self", selfType);
        for (const param of ctor.params) {
            ctorVarEnv.setImmutable(param.var.name, context.typeAstToTypeValue(param.typeExp));
        }
        typecheckConcreteAst(context, ctor.body, ctorVarEnv);
    }
}

function typecheckConcreteAst(context: ConcreteProgramContext, ast: AstNode, varEnv: ConcreteVarEnv): TypeValue {
    return withActiveConcreteTypecheckNode(ast, (): TypeValue => {
    if (ast instanceof IdentifierNode) {
        if (ast.name === "true" || ast.name === "false") {
            return new PrimitiveTypeValue("bool");
        }
        if (ast.name === "unit") {
            return new PrimitiveTypeValue("unit");
        }
        const localType = varEnv.get(ast.name);
        if (localType !== undefined) {
            return localType;
        }
        const globalInfo = context.getGlobalInfo(ast.name);
        if (globalInfo !== undefined) {
            return globalInfo.type;
        }
        const namedFunctionType = getNamedFunctionType(context, ast.name);
        if (namedFunctionType !== undefined) {
            return namedFunctionType;
        }
        throw new ConcreteTypeCheckError(`Undefined variable: ${ast.name}`);
    }
    if (ast instanceof TextDatabaseReferenceNode) {
        return new PrimitiveTypeValue(ast.typeName);
    }
    if (ast instanceof NumberLiteralNode) {
        return new PrimitiveTypeValue(ast.typeName);
    }
    if (ast instanceof DvarNode) {
        if (!(ast.bind instanceof TypeVarBindNode)) {
            throw new ConcreteTypeCheckError("var requires type binding");
        }
        const declaredType = context.typeAstToTypeValue(ast.bind.typeExp);
        typecheckAgainstExpectedType(context, ast.value, declaredType, varEnv);
        varEnv.set(ast.bind.var.name, declaredType);
        return declaredType;
    }
    if (ast instanceof SetNode) {
        const targetType = varEnv.get(ast.identifier.name) ?? context.getGlobalInfo(ast.identifier.name)?.type;
        if (targetType === undefined) {
            throw new ConcreteTypeCheckError(`Undefined variable in var_set: ${ast.identifier.name}`);
        }
        if (varEnv.isImmutable(ast.identifier.name)) {
            throw new ConcreteTypeCheckError(`Cannot var_set to immutable binding: ${ast.identifier.name}`);
        }
        typecheckAgainstExpectedType(context, ast.value, targetType, varEnv);
        return new PrimitiveTypeValue("unit");
    }
    if (ast instanceof FnNode) {
        const fnVarEnv = varEnv.extend();
        const paramTypes: TypeValue[] = [];
        for (const param of ast.params) {
            const paramType = context.typeAstToTypeValue(param.typeExp);
            paramTypes.push(paramType);
            fnVarEnv.setImmutable(param.var.name, paramType);
        }
        const returnType = context.typeAstToTypeValue(ast.returnType);
        typecheckAgainstExpectedType(context, ast.body, returnType, fnVarEnv);
        return new FunctionTypeValue(paramTypes, returnType);
    }
    if (ast instanceof LetNode) {
        const letVarEnv = varEnv.extend();
        for (const binding of ast.bindings) {
            if (!(binding.bind instanceof TypeVarBindNode)) {
                throw new ConcreteTypeCheckError("let requires type bindings");
            }
            const declaredType = context.typeAstToTypeValue(binding.bind.typeExp);
            typecheckAgainstExpectedType(context, binding.value, declaredType, letVarEnv);
            letVarEnv.set(binding.bind.var.name, declaredType);
        }
        return typecheckConcreteAst(context, ast.body, letVarEnv);
    }
    if (ast instanceof IfNode) {
        typecheckAgainstExpectedType(context, ast.condExpr, new PrimitiveTypeValue("bool"), varEnv);
        const trueType = typecheckConcreteAst(context, ast.trueBranchExpr, varEnv);
        const falseType = typecheckConcreteAst(context, ast.falseBranchExpr, varEnv);
        if (!typeEqual(trueType, falseType)) {
            throw new ConcreteTypeCheckError(`If branches must have same type: true branch ${formatType(trueType)}, false branch ${formatType(falseType)}`);
        }
        return trueType;
    }
    if (ast instanceof WhileNode) {
        typecheckAgainstExpectedType(context, ast.condExpr, new PrimitiveTypeValue("bool"), varEnv);
        typecheckConcreteAst(context, ast.bodyExpr, varEnv);
        return new PrimitiveTypeValue("unit");
    }
    if (ast instanceof CondNode) {
        let resultType: TypeValue | null = null;
        for (let index = 0; index < ast.clausesExprs.length; index += 1) {
            const clause = ast.clausesExprs[index];
            const isElseClause = clause.cond instanceof IdentifierNode && clause.cond.name === "else";
            if (!isElseClause) {
                typecheckAgainstExpectedType(context, clause.cond, new PrimitiveTypeValue("bool"), varEnv);
            } else if (index !== ast.clausesExprs.length - 1) {
                throw new ConcreteTypeCheckError("Cond else clause must be the last clause");
            }
            const clauseType = typecheckConcreteAst(context, clause.body, varEnv);
            if (resultType === null) {
                resultType = clauseType;
            } else if (!typeEqual(resultType, clauseType)) {
                throw new ConcreteTypeCheckError(`All cond branches must have same type: expected ${formatType(resultType)}, got ${formatType(clauseType)}`);
            }
        }
        if (resultType === null) {
            throw new ConcreteTypeCheckError("Cond must have at least one clause");
        }
        return resultType;
    }
    if (ast instanceof SeqNode) {
        if (ast.expressions.length === 0) {
            throw new ConcreteTypeCheckError("Seq must have at least one expression");
        }
        let lastType: TypeValue = new PrimitiveTypeValue("unit");
        for (const expression of ast.expressions) {
            lastType = typecheckConcreteAst(context, expression, varEnv);
        }
        return lastType;
    }
    if (ast instanceof ProgramNode) {
        for (const expression of ast.topLevelExpressions) {
            typecheckConcreteAst(context, expression, varEnv);
        }
        return new PrimitiveTypeValue("unit");
    }
    if (ast instanceof MatchNode) {
        const unionType = typecheckConcreteAst(context, ast.unionExpr, varEnv);
        if (!(unionType instanceof UnionTypeValue)) {
            throw new ConcreteTypeCheckError(`Match expression must be union type, got ${formatType(unionType)}`);
        }
        let resultType: TypeValue | null = null;
        const coveredTypes = new Set<string>();
        for (const branch of ast.branches) {
            const branchType = context.typeAstToTypeValue(branch.bind.typeExp);
            if (!unionType.types.some((member) => typeEqual(member, branchType))) {
                throw new ConcreteTypeCheckError(`Match branch type ${formatType(branchType)} is not a member of union type`);
            }
            const branchKey = formatType(branchType);
            if (coveredTypes.has(branchKey)) {
                throw new ConcreteTypeCheckError(`Duplicate match branch for type ${branchKey}`);
            }
            coveredTypes.add(branchKey);
            const branchVarEnv = varEnv.extend();
            branchVarEnv.set(branch.bind.var.name, branchType);
            const branchBodyType = typecheckConcreteAst(context, branch.body, branchVarEnv);
            if (resultType === null) {
                resultType = branchBodyType;
            } else if (!typeEqual(resultType, branchBodyType)) {
                throw new ConcreteTypeCheckError(`All match branches must have same type: expected ${formatType(resultType)}, got ${formatType(branchBodyType)}`);
            }
        }
        if (resultType === null || coveredTypes.size !== unionType.types.length) {
            throw new ConcreteTypeCheckError("Match must cover all union type members");
        }
        return resultType;
    }
    if (ast instanceof FunctionCallNode) {
        return typecheckFunctionCall(context, ast, varEnv);
    }
    if (ast instanceof GenericCallNode) {
        if (ast.callee instanceof IdentifierNode && ast.callee.name === "class_new" && ast.typeArgs.length === 1 && ast.typeArgs[0] instanceof IdentifierNode) {
            return typecheckNew(context, [ast.typeArgs[0]], varEnv);
        }
        throw new ConcreteTypeCheckError(`Unexpected generic expression after monomorphization: ${formatAst(ast)}`);
    }
    if (ast instanceof ClassNode) {
        typecheckClassDefinition(context, ast, varEnv);
        return new ClassTypeValue(ast.name.name);
    }
    if (ast instanceof ClassPropertyNode || ast instanceof ClassMethodNode || ast instanceof ClassConstructorNode) {
        return new PrimitiveTypeValue("unit");
    }
    if (ast instanceof DfunNode) {
        const fnVarEnv = varEnv.extend();
        for (const param of ast.params) {
            fnVarEnv.setImmutable(param.var.name, context.typeAstToTypeValue(param.typeExp));
        }
        const returnType = context.typeAstToTypeValue(ast.returnType);
        typecheckAgainstExpectedType(context, ast.body, returnType, fnVarEnv);
        return new FunctionTypeValue(ast.params.map((param) => context.typeAstToTypeValue(param.typeExp)), returnType);
    }
    if (ast instanceof DeclaredDfunNode || ast instanceof ImportNode) {
        return new PrimitiveTypeValue("unit");
    }
    if (ast instanceof GenericClassNode || ast instanceof GenericDfunNode) {
        throw new ConcreteTypeCheckError("Concrete typecheck received generic definitions");
    }
    throw new ConcreteTypeCheckError(`Unhandled AST node type: ${formatAst(ast)}`);
    });
}

export function performConcreteTypeChecking(programAst: AstNode): TypeValue {
    try {
        const program = programAst instanceof ProgramNode ? programAst : new ProgramNode([programAst]);
        const context = new ConcreteProgramContext(program);
        return typecheckConcreteAst(context, program, new ConcreteVarEnv());
    } catch (error) {
        throw wrapErrorAsDiagnostic(error, "concrete-typecheck", "CONCRETE_TYPECHECK_PIPELINE_ERROR", {
            ast: getActiveConcreteTypecheckNode() ?? programAst,
        });
    }
}
