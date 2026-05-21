import {
    AstNode,
    AstNodeType,
    ClassConstructorNode,
    ClassMethodNode,
    ClassNode,
    ClassPropertyNode,
    CondNode,
    DeclaredDfunNode,
    DvarNode,
    DfunNode,
    ExportNode,
    FnNode,
    FunctionCallNode,
    GenericCallNode,
    GenericClassNode,
    GenericDfunNode,
    GenericNameNode,
    IdentifierNode,
    ImportNode,
    IfNode,
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
import { isMemberChainSegmentText } from "./lexer";
import { astToString } from "./parser";

const INDENT = "  ";
const MAX_INLINE_WIDTH = 88;

export function formatIw(node: AstNode): string {
    const preparedNode = prepareNodeForFormatting(node);
    return `${formatNode(preparedNode, 0)}\n`;
}

function prepareNodeForFormatting(node: AstNode): AstNode {
    const dottedMemberChain = tryCollapseCmGetMemberChain(node);
    if (dottedMemberChain !== null) {
        return dottedMemberChain;
    }

    if (node instanceof IdentifierNode) {
        return new IdentifierNode(node.name);
    }
    if (node instanceof TextDatabaseReferenceNode) {
        return new TextDatabaseReferenceNode(node.typeName, node.entryName, node.referenceName, node.content);
    }
    if (node instanceof NumberLiteralNode) {
        return new NumberLiteralNode(node.typeName, node.value, node.raw);
    }
    if (node instanceof TypeVarBindNode) {
        return new TypeVarBindNode(
            prepareIdentifierNode(node.var),
            prepareNodeForFormatting(node.typeExp)
        );
    }
    if (node instanceof TypeToFromNode) {
        return new TypeToFromNode(
            prepareNodeForFormatting(node.returnType),
            node.paramTypes.map((paramType) => prepareNodeForFormatting(paramType))
        );
    }
    if (node instanceof TypeUnionNode) {
        return new TypeUnionNode(node.types.map((typeNode) => prepareNodeForFormatting(typeNode)));
    }
    if (node instanceof ProgramNode) {
        return new ProgramNode(
            node.topLevelExpressions.map((expression) => prepareNodeForFormatting(expression)),
            node.unitId === null ? null : prepareIdentifierNode(node.unitId)
        );
    }
    if (node instanceof ImportNode) {
        return new ImportNode(prepareIdentifierNode(node.packagePath));
    }
    if (node instanceof ExportNode) {
        return new ExportNode(prepareNodeForFormatting(node.inner));
    }
    if (node instanceof DvarNode) {
        return new DvarNode(prepareNodeForFormatting(node.bind), prepareNodeForFormatting(node.value));
    }
    if (node instanceof DfunNode) {
        return new DfunNode(
            prepareIdentifierNode(node.name),
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.returnType),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof DeclaredDfunNode) {
        return new DeclaredDfunNode(
            prepareIdentifierNode(node.name),
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.returnType)
        );
    }
    if (node instanceof SetNode) {
        return new SetNode(prepareIdentifierNode(node.identifier), prepareNodeForFormatting(node.value));
    }
    if (node instanceof SeqNode) {
        return new SeqNode(node.expressions.map((expression) => prepareNodeForFormatting(expression)));
    }
    if (node instanceof FnNode) {
        return new FnNode(
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.returnType),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof LetNode) {
        return new LetNode(
            node.bindings.map((binding) => ({
                bind: prepareNodeForFormatting(binding.bind),
                value: prepareNodeForFormatting(binding.value)
            })),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof IfNode) {
        return new IfNode(
            prepareNodeForFormatting(node.condExpr),
            prepareNodeForFormatting(node.trueBranchExpr),
            prepareNodeForFormatting(node.falseBranchExpr)
        );
    }
    if (node instanceof WhileNode) {
        return new WhileNode(
            prepareNodeForFormatting(node.condExpr),
            prepareNodeForFormatting(node.bodyExpr)
        );
    }
    if (node instanceof CondNode) {
        return new CondNode(node.clausesExprs.map((clause) => ({
            cond: prepareNodeForFormatting(clause.cond),
            body: prepareNodeForFormatting(clause.body)
        })));
    }
    if (node instanceof ClassNode) {
        return new ClassNode(
            prepareIdentifierNode(node.name),
            node.constructorNodeList.map((ctor) => prepareClassConstructorNode(ctor)),
            node.methodNodeList.map((method) => prepareClassMethodNode(method)),
            node.propertyNodeList.map((property) => prepareClassPropertyNode(property))
        );
    }
    if (node instanceof ClassPropertyNode) {
        return new ClassPropertyNode(prepareTypeVarBindNode(node.bind));
    }
    if (node instanceof ClassMethodNode) {
        return new ClassMethodNode(
            prepareIdentifierNode(node.methodName),
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.returnType),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof ClassConstructorNode) {
        return new ClassConstructorNode(
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof GenericNameNode) {
        return new GenericNameNode(
            prepareIdentifierNode(node.name),
            node.genericTypeArgs.map((arg) => prepareIdentifierNode(arg))
        );
    }
    if (node instanceof GenericClassNode) {
        return new GenericClassNode(
            prepareGenericNameNode(node.genericName),
            node.constructorNodeList.map((ctor) => prepareClassConstructorNode(ctor)),
            node.methodNodeList.map((method) => prepareClassMethodNode(method)),
            node.propertyNodeList.map((property) => prepareClassPropertyNode(property))
        );
    }
    if (node instanceof GenericDfunNode) {
        return new GenericDfunNode(
            prepareGenericNameNode(node.genericName),
            node.params.map((param) => prepareTypeVarBindNode(param)),
            prepareNodeForFormatting(node.returnType),
            prepareNodeForFormatting(node.body)
        );
    }
    if (node instanceof FunctionCallNode) {
        return new FunctionCallNode(
            prepareNodeForFormatting(node.callee),
            node.args.map((arg) => prepareNodeForFormatting(arg))
        );
    }
    if (node instanceof GenericCallNode) {
        return new GenericCallNode(
            prepareNodeForFormatting(node.callee),
            node.typeArgs.map((typeArg) => prepareNodeForFormatting(typeArg))
        );
    }
    if (node instanceof MatchNode) {
        return new MatchNode(
            prepareNodeForFormatting(node.unionExpr),
            node.branches.map((branch) => ({
                bind: prepareTypeVarBindNode(branch.bind),
                body: prepareNodeForFormatting(branch.body)
            }))
        );
    }

    return node;
}

function prepareIdentifierNode(node: IdentifierNode): IdentifierNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof IdentifierNode)) {
        throw new Error("Formatter member-chain preparation expected IdentifierNode");
    }
    return preparedNode;
}

function prepareTypeVarBindNode(node: TypeVarBindNode): TypeVarBindNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof TypeVarBindNode)) {
        throw new Error("Formatter member-chain preparation expected TypeVarBindNode");
    }
    return preparedNode;
}

function prepareClassPropertyNode(node: ClassPropertyNode): ClassPropertyNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof ClassPropertyNode)) {
        throw new Error("Formatter member-chain preparation expected ClassPropertyNode");
    }
    return preparedNode;
}

function prepareClassMethodNode(node: ClassMethodNode): ClassMethodNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof ClassMethodNode)) {
        throw new Error("Formatter member-chain preparation expected ClassMethodNode");
    }
    return preparedNode;
}

function prepareClassConstructorNode(node: ClassConstructorNode): ClassConstructorNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof ClassConstructorNode)) {
        throw new Error("Formatter member-chain preparation expected ClassConstructorNode");
    }
    return preparedNode;
}

function prepareGenericNameNode(node: GenericNameNode): GenericNameNode {
    const preparedNode = prepareNodeForFormatting(node);
    if (!(preparedNode instanceof GenericNameNode)) {
        throw new Error("Formatter member-chain preparation expected GenericNameNode");
    }
    return preparedNode;
}

function tryCollapseCmGetMemberChain(node: AstNode): IdentifierNode | null {
    const segments = collectCollapsedMemberChainSegments(node);
    if (segments === null) {
        return null;
    }
    return new IdentifierNode(segments.join("."));
}

function collectCollapsedMemberChainSegments(node: AstNode): string[] | null {
    if (node instanceof IdentifierNode) {
        if (!isMemberChainSegmentText(node.name)) {
            return null;
        }
        return [node.name];
    }

    if (!(node instanceof FunctionCallNode)) {
        return null;
    }
    if (!(node.callee instanceof IdentifierNode) || node.callee.name !== "cm_get") {
        return null;
    }
    if (node.args.length !== 2 || !(node.args[1] instanceof IdentifierNode)) {
        return null;
    }
    if (!isMemberChainSegmentText(node.args[1].name)) {
        return null;
    }

    const receiverSegments = collectCollapsedMemberChainSegments(node.args[0]);
    if (receiverSegments === null) {
        return null;
    }
    return [...receiverSegments, node.args[1].name];
}

function formatNode(node: AstNode, depth: number): string {
    const inline = astToString(node);
    if (shouldStayInline(node, inline, depth)) {
        return inline;
    }

    switch (node.kind) {
        case AstNodeType.ProgramNode:
            return formatProgramNode(node as ProgramNode, depth);
        case AstNodeType.SeqNode:
            return formatSeqNode(node as SeqNode, depth);
        case AstNodeType.LetNode:
            return formatLetNode(node as LetNode, depth);
        case AstNodeType.IfNode:
            return formatIfNode(node as IfNode, depth);
        case AstNodeType.WhileNode:
            return formatWhileNode(node as WhileNode, depth);
        case AstNodeType.CondNode:
            return formatCondNode(node as CondNode, depth);
        case AstNodeType.FnNode:
            return formatFnNode(node as FnNode, depth);
        case AstNodeType.DfunNode:
            return formatDfunNode(node as DfunNode, depth);
        case AstNodeType.DeclaredDfunNode:
            return formatDeclaredDfunNode(node as DeclaredDfunNode, depth);
        case AstNodeType.ClassNode:
            return formatClassNode(node as ClassNode, depth);
        case AstNodeType.GenericClassNode:
            return formatGenericClassNode(node as GenericClassNode, depth);
        case AstNodeType.ClassMethodNode:
            return formatClassMethodNode(node as ClassMethodNode, depth);
        case AstNodeType.ClassConstructorNode:
            return formatClassConstructorNode(node as ClassConstructorNode, depth);
        case AstNodeType.GenericDfunNode:
            return formatGenericDfunNode(node as GenericDfunNode, depth);
        case AstNodeType.MatchNode:
            return formatMatchNode(node as MatchNode, depth);
        case AstNodeType.FunctionCallNode:
            return formatFunctionCallNode(node as FunctionCallNode, depth);
        case AstNodeType.ImportNode:
            return formatImportNode(node as ImportNode);
        case AstNodeType.ExportNode:
            return formatExportNode(node as ExportNode, depth);
        default:
            return inline;
    }
}

function shouldStayInline(node: AstNode, inline: string, depth: number): boolean {
    if (inline.length + depth * INDENT.length > MAX_INLINE_WIDTH) {
        return false;
    }

    switch (node.kind) {
        case AstNodeType.ProgramNode:
            return (node as ProgramNode).topLevelExpressions.length <= 1 && (node as ProgramNode).topLevelExpressions[0]?.kind !== AstNodeType.SeqNode;
        case AstNodeType.SeqNode:
            return false;
        default:
            return true;
    }
}

function formatProgramNode(node: ProgramNode, depth: number): string {
    const header = node.unitId === null ? "{program" : `{program ${astToString(node.unitId)}`;
    if (node.topLevelExpressions.length === 0) {
        return `${header}}`;
    }

    return joinBlock(header, node.topLevelExpressions.map((expression) => formatNode(expression, depth + 1)), "}");
}

function formatSeqNode(node: SeqNode, depth: number): string {
    if (node.expressions.length === 0) {
        return "{}";
    }

    return joinBlock("{", node.expressions.map((expression) => formatNode(expression, depth + 1)), "}");
}

function formatLetNode(node: LetNode, depth: number): string {
    const bindingLines = node.bindings.map((binding) => `(${astToString(binding.bind)} ${formatNode(binding.value, depth + 2)})`);
    return [
        "(let (",
        ...bindingLines.map((line) => indentBlock(line, 1)),
        ") in",
        indentBlock(formatNode(node.body, depth + 1), 1),
        ")"
    ].join("\n");
}

function formatIfNode(node: IfNode, depth: number): string {
    return [
        "(if",
        indentBlock(formatNode(node.condExpr, depth + 1), 1),
        `${INDENT}then`,
        indentBlock(formatNode(node.trueBranchExpr, depth + 1), 1),
        `${INDENT}else`,
        indentBlock(formatNode(node.falseBranchExpr, depth + 1), 1),
        ")"
    ].join("\n");
}

function formatWhileNode(node: WhileNode, depth: number): string {
    return [
        "(while",
        indentBlock(formatNode(node.condExpr, depth + 1), 1),
        `${INDENT}in`,
        indentBlock(formatNode(node.bodyExpr, depth + 1), 1),
        ")"
    ].join("\n");
}

function formatCondNode(node: CondNode, depth: number): string {
    return joinBlock("(cond", node.clausesExprs.map((clause) => `(${formatNode(clause.cond, depth + 1)} ${formatNode(clause.body, depth + 1)})`), ")");
}

function formatFnNode(node: FnNode, depth: number): string {
    return formatCallableLike(`(fn (${node.params.map(astToString).join(" ")}) to ${astToString(node.returnType)} in`, node.body, depth);
}

function formatDfunNode(node: DfunNode, depth: number): string {
    return formatCallableLike(`(function ${astToString(node.name)} (${node.params.map(astToString).join(" ")}) to ${astToString(node.returnType)} in`, node.body, depth);
}

function formatGenericDfunNode(node: GenericDfunNode, depth: number): string {
    return formatCallableLike(`(function ${astToString(node.genericName)} (${node.params.map(astToString).join(" ")}) to ${astToString(node.returnType)} in`, node.body, depth);
}

function formatDeclaredDfunNode(node: DeclaredDfunNode, _depth: number): string {
    return [
        `(declare (function ${astToString(node.name)} (${node.params.map(astToString).join(" ")}) to ${astToString(node.returnType)})`,
        ")"
    ].join("\n");
}

function formatClassNode(node: ClassNode, depth: number): string {
    return formatClassLike(astToString(node.name), [
        ...node.propertyNodeList.map((property) => formatNode(property, depth + 1)),
        ...node.methodNodeList.map((method) => formatNode(method, depth + 1)),
        ...node.constructorNodeList.map((ctor) => formatNode(ctor, depth + 1))
    ]);
}

function formatGenericClassNode(node: GenericClassNode, depth: number): string {
    return formatClassLike(astToString(node.genericName), [
        ...node.propertyNodeList.map((property) => formatNode(property, depth + 1)),
        ...node.methodNodeList.map((method) => formatNode(method, depth + 1)),
        ...node.constructorNodeList.map((ctor) => formatNode(ctor, depth + 1))
    ]);
}

function formatClassMethodNode(node: ClassMethodNode, depth: number): string {
    return formatCallableLike(`(method ${astToString(node.methodName)} (${node.params.map(astToString).join(" ")}) to ${astToString(node.returnType)} in`, node.body, depth);
}

function formatClassConstructorNode(node: ClassConstructorNode, depth: number): string {
    return formatCallableLike(`(constructor (${node.params.map(astToString).join(" ")}) in`, node.body, depth);
}

function formatMatchNode(node: MatchNode, depth: number): string {
    return joinBlock(`(match ${formatNode(node.unionExpr, depth + 1)}`, node.branches.map((branch) => formatMatchBranch(branch.bind, branch.body, depth + 1)), ")");
}

function formatFunctionCallNode(node: FunctionCallNode, depth: number): string {
    if (node.args.length === 0) {
        return `(${astToString(node.callee)})`;
    }

    return [
        `(${astToString(node.callee)}`,
        ...node.args.map((arg) => indentBlock(formatNode(arg, depth + 1), 1)),
        ")"
    ].join("\n");
}

function formatImportNode(node: ImportNode): string {
    return `(import ${astToString(node.packagePath)})`;
}

function formatExportNode(node: ExportNode, depth: number): string {
    return [
        "(export",
        indentBlock(formatNode(node.inner, depth + 1), 1),
        ")"
    ].join("\n");
}

function formatCallableLike(head: string, body: AstNode, depth: number): string {
    return [
        head,
        indentBlock(formatNode(body, depth + 1), 1),
        ")"
    ].join("\n");
}

function formatClassLike(name: string, members: readonly string[]): string {
    if (members.length === 0) {
        return `(class ${name})`;
    }

    return joinBlock(`(class ${name}`, members, ")");
}

function formatMatchBranch(bind: AstNode, body: AstNode, depth: number): string {
    const bodyText = formatNode(body, depth + 1);
    const inlineBody = astToString(body);
    if (bodyText === inlineBody) {
        return `(${astToString(bind)} ${inlineBody})`;
    }

    return [
        `(${astToString(bind)}`,
        indentBlock(bodyText, 1),
        ")"
    ].join("\n");
}

function joinBlock(open: string, items: readonly string[], close: string): string {
    return [
        open,
        ...items.map((item) => indentBlock(item, 1)),
        close
    ].join("\n");
}

function indentBlock(text: string, depth: number): string {
    const prefix = INDENT.repeat(depth);
    return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}