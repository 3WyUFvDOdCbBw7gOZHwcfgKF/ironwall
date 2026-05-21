// 作者: GitHub Copilot
// 日期: 2026-04-28
// 说明: TS/C++ 前端共享的 token/AST JSON 序列化边界
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
    AbstractToken,
    BracketKind,
    buildNumberTokenFromRaw,
    IdentifierToken,
    LParenToken,
    NumberToken,
    RParenToken
} from "./lexer";

type JsonPrimitive = string | number | boolean | null;

interface JsonObject {
    readonly [key: string]: JsonValue;
}

type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export class FrontendJsonBundle {
    readonly tokens: AbstractToken[];
    readonly ast: AstNode;

    constructor(tokens: AbstractToken[], ast: AstNode) {
        this.tokens = tokens;
        this.ast = ast;
    }
}

function parseJsonText(jsonText: string): JsonValue {
    return JSON.parse(jsonText) as JsonValue;
}

function expectJsonObject(value: JsonValue, context: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context} must be a JSON object`);
    }
    return value;
}

function expectJsonArray(value: JsonValue, context: string): JsonArray {
    if (!Array.isArray(value)) {
        throw new Error(`${context} must be a JSON array`);
    }
    return value;
}

function readRequiredJsonValue(source: JsonObject, fieldName: string, context: string): JsonValue {
    if (!(fieldName in source)) {
        throw new Error(`${context} is missing required field '${fieldName}'`);
    }
    return source[fieldName];
}

function readStringField(source: JsonObject, fieldName: string, context: string): string {
    const value: JsonValue = readRequiredJsonValue(source, fieldName, context);
    if (typeof value !== "string") {
        throw new Error(`${context}.${fieldName} must be a string`);
    }
    return value;
}

function readNullableStringOrNumberField(source: JsonObject, fieldName: string, context: string): string | number | null {
    const value: JsonValue = readRequiredJsonValue(source, fieldName, context);
    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }
    throw new Error(`${context}.${fieldName} must be null, string, or number`);
}

function serializeToken(token: AbstractToken): JsonObject {
    if (token instanceof LParenToken) {
        return {
            kind: "LParenToken",
            bracketKind: token.bracketKind
        };
    }
    if (token instanceof RParenToken) {
        return {
            kind: "RParenToken",
            bracketKind: token.bracketKind
        };
    }
    if (token instanceof NumberToken) {
        return {
            kind: "NumberToken",
            typeName: token.typeName,
            raw: token.raw
        };
    }
    return {
        kind: "IdentifierToken",
        name: token.name
    };
}

function deserializeToken(value: JsonValue, context: string): AbstractToken {
    const object: JsonObject = expectJsonObject(value, context);
    const kind: string = readStringField(object, "kind", context);

    if (kind === "LParenToken") {
        return new LParenToken(readBracketKindField(object, "bracketKind", context));
    }
    if (kind === "RParenToken") {
        return new RParenToken(readBracketKindField(object, "bracketKind", context));
    }
    if (kind === "NumberToken") {
        const raw: string = readStringField(object, "raw", context);
        const token: NumberToken = buildNumberTokenFromRaw(raw);
        const expectedTypeName: string = readStringField(object, "typeName", context);
        if (token.typeName !== expectedTypeName) {
            throw new Error(`${context}.typeName mismatch: expected '${expectedTypeName}', got '${token.typeName}'`);
        }
        return token;
    }
    if (kind === "IdentifierToken") {
        return new IdentifierToken(readStringField(object, "name", context));
    }

    throw new Error(`${context} has unsupported token kind '${kind}'`);
}

function readBracketKindField(source: JsonObject, fieldName: string, context: string): BracketKind {
    const value: string = readStringField(source, fieldName, context);
    if (value === BracketKind.ROUND || value === BracketKind.SQUARE || value === BracketKind.CURLY || value === BracketKind.ANGLE) {
        return value;
    }
    throw new Error(`${context}.${fieldName} has unsupported bracket kind '${value}'`);
}

function serializeAstNode(node: AstNode): JsonObject {
    if (node instanceof IdentifierNode) {
        return {
            kind: "IdentifierNode",
            name: node.name
        };
    }
    if (node instanceof TextDatabaseReferenceNode) {
        return {
            kind: "TextDatabaseReferenceNode",
            typeName: node.typeName,
            entryName: node.entryName,
            referenceName: node.referenceName,
            content: node.content
        };
    }
    if (node instanceof NumberLiteralNode) {
        return {
            kind: "NumberLiteralNode",
            typeName: node.typeName,
            raw: node.raw
        };
    }
    if (node instanceof ListNode) {
        return {
            kind: "ListNode",
            elements: node.elements.map((element: AstNode): JsonObject => serializeAstNode(element))
        };
    }
    if (node instanceof RoundParenListNode) {
        return {
            kind: "RoundParenListNode",
            elements: node.elements.map((element: AstNode): JsonObject => serializeAstNode(element))
        };
    }
    if (node instanceof SquareParenListNode) {
        return {
            kind: "SquareParenListNode",
            elements: node.elements.map((element: AstNode): JsonObject => serializeAstNode(element))
        };
    }
    if (node instanceof CurlyParenListNode) {
        return {
            kind: "CurlyParenListNode",
            elements: node.elements.map((element: AstNode): JsonObject => serializeAstNode(element))
        };
    }
    if (node instanceof AngleParenListNode) {
        return {
            kind: "AngleParenListNode",
            elements: node.elements.map((element: AstNode): JsonObject => serializeAstNode(element))
        };
    }
    if (node instanceof FnNode) {
        return {
            kind: "FnNode",
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            returnType: serializeAstNode(node.returnType),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof LetNode) {
        return {
            kind: "LetNode",
            bindings: node.bindings.map((binding: { bind: AstNode; value: AstNode }): JsonObject => ({
                bind: serializeAstNode(binding.bind),
                value: serializeAstNode(binding.value)
            })),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof IfNode) {
        return {
            kind: "IfNode",
            condExpr: serializeAstNode(node.condExpr),
            trueBranchExpr: serializeAstNode(node.trueBranchExpr),
            falseBranchExpr: serializeAstNode(node.falseBranchExpr)
        };
    }
    if (node instanceof WhileNode) {
        return {
            kind: "WhileNode",
            condExpr: serializeAstNode(node.condExpr),
            bodyExpr: serializeAstNode(node.bodyExpr)
        };
    }
    if (node instanceof CondNode) {
        return {
            kind: "CondNode",
            clausesExprs: node.clausesExprs.map((clause: { cond: AstNode; body: AstNode }): JsonObject => ({
                cond: serializeAstNode(clause.cond),
                body: serializeAstNode(clause.body)
            }))
        };
    }
    if (node instanceof TypeVarBindNode) {
        return {
            kind: "TypeVarBindNode",
            var: serializeAstNode(node.var),
            typeExp: serializeAstNode(node.typeExp)
        };
    }
    if (node instanceof TypeToFromNode) {
        return {
            kind: "TypeToFromNode",
            returnType: serializeAstNode(node.returnType),
            paramTypes: node.paramTypes.map((paramType: AstNode): JsonObject => serializeAstNode(paramType))
        };
    }
    if (node instanceof TypeUnionNode) {
        return {
            kind: "TypeUnionNode",
            types: node.types.map((typeNode: AstNode): JsonObject => serializeAstNode(typeNode))
        };
    }
    if (node instanceof ProgramNode) {
        return {
            kind: "ProgramNode",
            unitId: node.unitId === null ? null : serializeAstNode(node.unitId),
            topLevelExpressions: node.topLevelExpressions.map((expression: AstNode): JsonObject => serializeAstNode(expression))
        };
    }
    if (node instanceof ImportNode) {
        return {
            kind: "ImportNode",
            packagePath: serializeAstNode(node.packagePath)
        };
    }
    if (node instanceof ExportNode) {
        return {
            kind: "ExportNode",
            inner: serializeAstNode(node.inner)
        };
    }
    if (node instanceof DvarNode) {
        return {
            kind: "DvarNode",
            bind: serializeAstNode(node.bind),
            value: serializeAstNode(node.value)
        };
    }
    if (node instanceof DfunNode) {
        return {
            kind: "DfunNode",
            name: serializeAstNode(node.name),
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            returnType: serializeAstNode(node.returnType),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof DeclaredDfunNode) {
        return {
            kind: "DeclaredDfunNode",
            name: serializeAstNode(node.name),
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            returnType: serializeAstNode(node.returnType)
        };
    }
    if (node instanceof SetNode) {
        return {
            kind: "SetNode",
            identifier: serializeAstNode(node.identifier),
            value: serializeAstNode(node.value)
        };
    }
    if (node instanceof SeqNode) {
        return {
            kind: "SeqNode",
            expressions: node.expressions.map((expression: AstNode): JsonObject => serializeAstNode(expression))
        };
    }
    if (node instanceof ClassNode) {
        return {
            kind: "ClassNode",
            name: serializeAstNode(node.name),
            constructorNodeList: node.constructorNodeList.map((constructorNode: ClassConstructorNode): JsonObject => serializeAstNode(constructorNode)),
            methodNodeList: node.methodNodeList.map((methodNode: ClassMethodNode): JsonObject => serializeAstNode(methodNode)),
            propertyNodeList: node.propertyNodeList.map((propertyNode: ClassPropertyNode): JsonObject => serializeAstNode(propertyNode))
        };
    }
    if (node instanceof ClassPropertyNode) {
        return {
            kind: "ClassPropertyNode",
            bind: serializeAstNode(node.bind)
        };
    }
    if (node instanceof ClassMethodNode) {
        return {
            kind: "ClassMethodNode",
            methodName: serializeAstNode(node.methodName),
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            returnType: serializeAstNode(node.returnType),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof ClassConstructorNode) {
        return {
            kind: "ClassConstructorNode",
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof GenericNameNode) {
        return {
            kind: "GenericNameNode",
            name: serializeAstNode(node.name),
            genericTypeArgs: node.genericTypeArgs.map((typeArg: IdentifierNode): JsonObject => serializeAstNode(typeArg))
        };
    }
    if (node instanceof GenericClassNode) {
        return {
            kind: "GenericClassNode",
            genericName: serializeAstNode(node.genericName),
            constructorNodeList: node.constructorNodeList.map((constructorNode: ClassConstructorNode): JsonObject => serializeAstNode(constructorNode)),
            methodNodeList: node.methodNodeList.map((methodNode: ClassMethodNode): JsonObject => serializeAstNode(methodNode)),
            propertyNodeList: node.propertyNodeList.map((propertyNode: ClassPropertyNode): JsonObject => serializeAstNode(propertyNode))
        };
    }
    if (node instanceof GenericDfunNode) {
        return {
            kind: "GenericDfunNode",
            genericName: serializeAstNode(node.genericName),
            params: node.params.map((param: TypeVarBindNode): JsonObject => serializeAstNode(param)),
            returnType: serializeAstNode(node.returnType),
            body: serializeAstNode(node.body)
        };
    }
    if (node instanceof FunctionCallNode) {
        return {
            kind: "FunctionCallNode",
            callee: serializeAstNode(node.callee),
            args: node.args.map((arg: AstNode): JsonObject => serializeAstNode(arg))
        };
    }
    if (node instanceof GenericCallNode) {
        return {
            kind: "GenericCallNode",
            callee: serializeAstNode(node.callee),
            typeArgs: node.typeArgs.map((typeArg: AstNode): JsonObject => serializeAstNode(typeArg))
        };
    }
    return {
        kind: "MatchNode",
        unionExpr: serializeAstNode(node.unionExpr),
        branches: node.branches.map((branch: { bind: TypeVarBindNode; body: AstNode }): JsonObject => ({
            bind: serializeAstNode(branch.bind),
            body: serializeAstNode(branch.body)
        }))
    };
}

function deserializeAstNode(value: JsonValue, context: string): AstNode {
    const object: JsonObject = expectJsonObject(value, context);
    const kind: string = readStringField(object, "kind", context);

    if (kind === "IdentifierNode") {
        return new IdentifierNode(readStringField(object, "name", context));
    }
    if (kind === "TextDatabaseReferenceNode") {
        const typeName: string = readStringField(object, "typeName", context);
        const entryName: string = readStringField(object, "entryName", context);
        const referenceName: string = readStringField(object, "referenceName", context);
        const content: string | number | null = readNullableStringOrNumberField(object, "content", context);
        return new TextDatabaseReferenceNode(typeName, entryName, referenceName, content);
    }
    if (kind === "NumberLiteralNode") {
        const raw: string = readStringField(object, "raw", context);
        const token: NumberToken = buildNumberTokenFromRaw(raw);
        const expectedTypeName: string = readStringField(object, "typeName", context);
        if (token.typeName !== expectedTypeName) {
            throw new Error(`${context}.typeName mismatch: expected '${expectedTypeName}', got '${token.typeName}'`);
        }
        return new NumberLiteralNode(token.typeName, token.value, token.raw);
    }
    if (kind === "ListNode") {
        return new ListNode(readAstNodeArrayField(object, "elements", context));
    }
    if (kind === "RoundParenListNode") {
        return new RoundParenListNode(readAstNodeArrayField(object, "elements", context));
    }
    if (kind === "SquareParenListNode") {
        return new SquareParenListNode(readAstNodeArrayField(object, "elements", context));
    }
    if (kind === "CurlyParenListNode") {
        return new CurlyParenListNode(readAstNodeArrayField(object, "elements", context));
    }
    if (kind === "AngleParenListNode") {
        return new AngleParenListNode(readAstNodeArrayField(object, "elements", context));
    }
    if (kind === "FnNode") {
        return new FnNode(
            readTypeVarBindArrayField(object, "params", context),
            readAstNodeField(object, "returnType", context),
            readAstNodeField(object, "body", context)
        );
    }
    if (kind === "LetNode") {
        return new LetNode(readBindingArrayField(object, "bindings", context), readAstNodeField(object, "body", context));
    }
    if (kind === "IfNode") {
        return new IfNode(
            readAstNodeField(object, "condExpr", context),
            readAstNodeField(object, "trueBranchExpr", context),
            readAstNodeField(object, "falseBranchExpr", context)
        );
    }
    if (kind === "WhileNode") {
        return new WhileNode(readAstNodeField(object, "condExpr", context), readAstNodeField(object, "bodyExpr", context));
    }
    if (kind === "CondNode") {
        return new CondNode(readClauseArrayField(object, "clausesExprs", context));
    }
    if (kind === "TypeVarBindNode") {
        return new TypeVarBindNode(readIdentifierNodeField(object, "var", context), readAstNodeField(object, "typeExp", context));
    }
    if (kind === "TypeToFromNode") {
        return new TypeToFromNode(readAstNodeField(object, "returnType", context), readAstNodeArrayField(object, "paramTypes", context));
    }
    if (kind === "TypeUnionNode") {
        return new TypeUnionNode(readAstNodeArrayField(object, "types", context));
    }
    if (kind === "ProgramNode") {
        return new ProgramNode(
            readAstNodeArrayField(object, "topLevelExpressions", context),
            readNullableIdentifierNodeField(object, "unitId", context)
        );
    }
    if (kind === "ImportNode") {
        return new ImportNode(readIdentifierNodeField(object, "packagePath", context));
    }
    if (kind === "ExportNode") {
        return new ExportNode(readAstNodeField(object, "inner", context));
    }
    if (kind === "DvarNode") {
        return new DvarNode(readAstNodeField(object, "bind", context), readAstNodeField(object, "value", context));
    }
    if (kind === "DfunNode") {
        return new DfunNode(
            readIdentifierNodeField(object, "name", context),
            readTypeVarBindArrayField(object, "params", context),
            readAstNodeField(object, "returnType", context),
            readAstNodeField(object, "body", context)
        );
    }
    if (kind === "DeclaredDfunNode") {
        return new DeclaredDfunNode(
            readIdentifierNodeField(object, "name", context),
            readTypeVarBindArrayField(object, "params", context),
            readAstNodeField(object, "returnType", context)
        );
    }
    if (kind === "SetNode") {
        return new SetNode(readIdentifierNodeField(object, "identifier", context), readAstNodeField(object, "value", context));
    }
    if (kind === "SeqNode") {
        return new SeqNode(readAstNodeArrayField(object, "expressions", context));
    }
    if (kind === "ClassNode") {
        return new ClassNode(
            readIdentifierNodeField(object, "name", context),
            readClassConstructorArrayField(object, "constructorNodeList", context),
            readClassMethodArrayField(object, "methodNodeList", context),
            readClassPropertyArrayField(object, "propertyNodeList", context)
        );
    }
    if (kind === "ClassPropertyNode") {
        return new ClassPropertyNode(readTypeVarBindNodeField(object, "bind", context));
    }
    if (kind === "ClassMethodNode") {
        return new ClassMethodNode(
            readIdentifierNodeField(object, "methodName", context),
            readTypeVarBindArrayField(object, "params", context),
            readAstNodeField(object, "returnType", context),
            readAstNodeField(object, "body", context)
        );
    }
    if (kind === "ClassConstructorNode") {
        return new ClassConstructorNode(readTypeVarBindArrayField(object, "params", context), readAstNodeField(object, "body", context));
    }
    if (kind === "GenericNameNode") {
        return new GenericNameNode(readIdentifierNodeField(object, "name", context), readIdentifierArrayField(object, "genericTypeArgs", context));
    }
    if (kind === "GenericClassNode") {
        return new GenericClassNode(
            readGenericNameNodeField(object, "genericName", context),
            readClassConstructorArrayField(object, "constructorNodeList", context),
            readClassMethodArrayField(object, "methodNodeList", context),
            readClassPropertyArrayField(object, "propertyNodeList", context)
        );
    }
    if (kind === "GenericDfunNode") {
        return new GenericDfunNode(
            readGenericNameNodeField(object, "genericName", context),
            readTypeVarBindArrayField(object, "params", context),
            readAstNodeField(object, "returnType", context),
            readAstNodeField(object, "body", context)
        );
    }
    if (kind === "FunctionCallNode") {
        return new FunctionCallNode(readAstNodeField(object, "callee", context), readAstNodeArrayField(object, "args", context));
    }
    if (kind === "GenericCallNode") {
        return new GenericCallNode(readAstNodeField(object, "callee", context), readAstNodeArrayField(object, "typeArgs", context));
    }
    if (kind === "MatchNode") {
        return new MatchNode(readAstNodeField(object, "unionExpr", context), readMatchBranchArrayField(object, "branches", context));
    }

    throw new Error(`${context} has unsupported AST kind '${kind}'`);
}

function readAstNodeField(source: JsonObject, fieldName: string, context: string): AstNode {
    return deserializeAstNode(readRequiredJsonValue(source, fieldName, context), `${context}.${fieldName}`);
}

function readAstNodeArrayField(source: JsonObject, fieldName: string, context: string): AstNode[] {
    const values: JsonArray = expectJsonArray(readRequiredJsonValue(source, fieldName, context), `${context}.${fieldName}`);
    return values.map((value: JsonValue, index: number): AstNode => deserializeAstNode(value, `${context}.${fieldName}[${index}]`));
}

function readIdentifierNodeField(source: JsonObject, fieldName: string, context: string): IdentifierNode {
    const node: AstNode = readAstNodeField(source, fieldName, context);
    if (!(node instanceof IdentifierNode)) {
        throw new Error(`${context}.${fieldName} must be an IdentifierNode`);
    }
    return node;
}

function readNullableIdentifierNodeField(source: JsonObject, fieldName: string, context: string): IdentifierNode | null {
    const value: JsonValue = readRequiredJsonValue(source, fieldName, context);
    if (value === null) {
        return null;
    }
    const node: AstNode = deserializeAstNode(value, `${context}.${fieldName}`);
    if (!(node instanceof IdentifierNode)) {
        throw new Error(`${context}.${fieldName} must be null or an IdentifierNode`);
    }
    return node;
}

function readIdentifierArrayField(source: JsonObject, fieldName: string, context: string): IdentifierNode[] {
    const nodes: AstNode[] = readAstNodeArrayField(source, fieldName, context);
    return nodes.map((node: AstNode, index: number): IdentifierNode => {
        if (!(node instanceof IdentifierNode)) {
            throw new Error(`${context}.${fieldName}[${index}] must be an IdentifierNode`);
        }
        return node;
    });
}

function readTypeVarBindNodeField(source: JsonObject, fieldName: string, context: string): TypeVarBindNode {
    const node: AstNode = readAstNodeField(source, fieldName, context);
    if (!(node instanceof TypeVarBindNode)) {
        throw new Error(`${context}.${fieldName} must be a TypeVarBindNode`);
    }
    return node;
}

function readTypeVarBindArrayField(source: JsonObject, fieldName: string, context: string): TypeVarBindNode[] {
    const nodes: AstNode[] = readAstNodeArrayField(source, fieldName, context);
    return nodes.map((node: AstNode, index: number): TypeVarBindNode => {
        if (!(node instanceof TypeVarBindNode)) {
            throw new Error(`${context}.${fieldName}[${index}] must be a TypeVarBindNode`);
        }
        return node;
    });
}

function readGenericNameNodeField(source: JsonObject, fieldName: string, context: string): GenericNameNode {
    const node: AstNode = readAstNodeField(source, fieldName, context);
    if (!(node instanceof GenericNameNode)) {
        throw new Error(`${context}.${fieldName} must be a GenericNameNode`);
    }
    return node;
}

function readClassConstructorArrayField(source: JsonObject, fieldName: string, context: string): ClassConstructorNode[] {
    const nodes: AstNode[] = readAstNodeArrayField(source, fieldName, context);
    return nodes.map((node: AstNode, index: number): ClassConstructorNode => {
        if (!(node instanceof ClassConstructorNode)) {
            throw new Error(`${context}.${fieldName}[${index}] must be a ClassConstructorNode`);
        }
        return node;
    });
}

function readClassMethodArrayField(source: JsonObject, fieldName: string, context: string): ClassMethodNode[] {
    const nodes: AstNode[] = readAstNodeArrayField(source, fieldName, context);
    return nodes.map((node: AstNode, index: number): ClassMethodNode => {
        if (!(node instanceof ClassMethodNode)) {
            throw new Error(`${context}.${fieldName}[${index}] must be a ClassMethodNode`);
        }
        return node;
    });
}

function readClassPropertyArrayField(source: JsonObject, fieldName: string, context: string): ClassPropertyNode[] {
    const nodes: AstNode[] = readAstNodeArrayField(source, fieldName, context);
    return nodes.map((node: AstNode, index: number): ClassPropertyNode => {
        if (!(node instanceof ClassPropertyNode)) {
            throw new Error(`${context}.${fieldName}[${index}] must be a ClassPropertyNode`);
        }
        return node;
    });
}

function readBindingArrayField(source: JsonObject, fieldName: string, context: string): { bind: AstNode; value: AstNode }[] {
    const values: JsonArray = expectJsonArray(readRequiredJsonValue(source, fieldName, context), `${context}.${fieldName}`);
    return values.map((value: JsonValue, index: number): { bind: AstNode; value: AstNode } => {
        const bindingObject: JsonObject = expectJsonObject(value, `${context}.${fieldName}[${index}]`);
        return {
            bind: readAstNodeField(bindingObject, "bind", `${context}.${fieldName}[${index}]`),
            value: readAstNodeField(bindingObject, "value", `${context}.${fieldName}[${index}]`)
        };
    });
}

function readClauseArrayField(source: JsonObject, fieldName: string, context: string): { cond: AstNode; body: AstNode }[] {
    const values: JsonArray = expectJsonArray(readRequiredJsonValue(source, fieldName, context), `${context}.${fieldName}`);
    return values.map((value: JsonValue, index: number): { cond: AstNode; body: AstNode } => {
        const clauseObject: JsonObject = expectJsonObject(value, `${context}.${fieldName}[${index}]`);
        return {
            cond: readAstNodeField(clauseObject, "cond", `${context}.${fieldName}[${index}]`),
            body: readAstNodeField(clauseObject, "body", `${context}.${fieldName}[${index}]`)
        };
    });
}

function readMatchBranchArrayField(source: JsonObject, fieldName: string, context: string): { bind: TypeVarBindNode; body: AstNode }[] {
    const values: JsonArray = expectJsonArray(readRequiredJsonValue(source, fieldName, context), `${context}.${fieldName}`);
    return values.map((value: JsonValue, index: number): { bind: TypeVarBindNode; body: AstNode } => {
        const branchObject: JsonObject = expectJsonObject(value, `${context}.${fieldName}[${index}]`);
        return {
            bind: readTypeVarBindNodeField(branchObject, "bind", `${context}.${fieldName}[${index}]`),
            body: readAstNodeField(branchObject, "body", `${context}.${fieldName}[${index}]`)
        };
    });
}

export function dumpTokensToJsonText(tokens: readonly AbstractToken[]): string {
    const serializedTokens: JsonArray = tokens.map((token: AbstractToken): JsonObject => serializeToken(token));
    return `${JSON.stringify(serializedTokens, null, 2)}\n`;
}

export function restoreTokensFromJsonText(jsonText: string): AbstractToken[] {
    const parsedValue: JsonValue = parseJsonText(jsonText);
    const parsedArray: JsonArray = expectJsonArray(parsedValue, "token-json-root");
    return parsedArray.map((value: JsonValue, index: number): AbstractToken => deserializeToken(value, `token-json-root[${index}]`));
}

export function dumpAstToJsonText(node: AstNode): string {
    return `${JSON.stringify(serializeAstNode(node), null, 2)}\n`;
}

export function restoreAstFromJsonText(jsonText: string): AstNode {
    const parsedValue: JsonValue = parseJsonText(jsonText);
    return deserializeAstNode(parsedValue, "ast-json-root");
}

export function dumpFrontendBundleToJsonText(tokens: readonly AbstractToken[], ast: AstNode): string {
    const bundle: JsonObject = {
        tokens: tokens.map((token: AbstractToken): JsonObject => serializeToken(token)),
        ast: serializeAstNode(ast)
    };
    return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function restoreFrontendBundleFromJsonText(jsonText: string): FrontendJsonBundle {
    const parsedValue: JsonValue = parseJsonText(jsonText);
    const rootObject: JsonObject = expectJsonObject(parsedValue, "frontend-json-root");
    const tokensArray: JsonArray = expectJsonArray(readRequiredJsonValue(rootObject, "tokens", "frontend-json-root"), "frontend-json-root.tokens");
    const tokens: AbstractToken[] = tokensArray.map((value: JsonValue, index: number): AbstractToken => deserializeToken(value, `frontend-json-root.tokens[${index}]`));
    const ast: AstNode = deserializeAstNode(readRequiredJsonValue(rootObject, "ast", "frontend-json-root"), "frontend-json-root.ast");
    return new FrontendJsonBundle(tokens, ast);
}