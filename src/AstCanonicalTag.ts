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
    IfNode,
    ImportNode,
    LetNode,
    ListNode,
    MatchNode,
    PublicNode,
    ProgramNode,
    SeqNode,
    SetNode,
    TypeToFromNode,
    TypeUnionNode,
    TypeVarBindNode,
    WhileNode
} from "./AstNode";
import { getCompilationUnitMetadata } from "./ModuleMetadata";

let astCanonicalTagTable: WeakMap<AstNode, string> = new WeakMap<AstNode, string>();

function setAstCanonicalTag(node: AstNode, tag: string): void {
    astCanonicalTagTable.set(node, tag);
}

function annotateChild(node: AstNode, tag: string): void {
    annotateCanonicalTagsForSubtree(node, tag);
}

function annotateTypeVarBindingList(bindings: readonly TypeVarBindNode[], tagPrefix: string): void {
    for (let index = 0; index < bindings.length; index += 1) {
        annotateChild(bindings[index], `${tagPrefix}[${index}]`);
    }
}

export function resetAstCanonicalTags(): void {
    astCanonicalTagTable = new WeakMap<AstNode, string>();
}

export function getAstCanonicalTag(node: AstNode): string {
    const tag = astCanonicalTagTable.get(node);
    if (tag === undefined) {
        throw new Error(`Missing canonical tag for AST node kind ${String(node.kind)}`);
    }
    return tag;
}

export function annotateCanonicalTagsForSubtree(node: AstNode, rootTag: string): void {
    setAstCanonicalTag(node, rootTag);

    if (node instanceof ProgramNode) {
        if (node.unitId !== null) {
            annotateChild(node.unitId, `${rootTag}/unit-id`);
        }
        for (let index = 0; index < node.topLevelExpressions.length; index += 1) {
            annotateChild(node.topLevelExpressions[index], `${rootTag}/top[${index}]`);
        }
        return;
    }

    if (node instanceof ImportNode) {
        annotateChild(node.packagePath, `${rootTag}/package`);
        return;
    }

    if (node instanceof FnNode) {
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.returnType, `${rootTag}/return`);
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof LetNode) {
        for (let index = 0; index < node.bindings.length; index += 1) {
            annotateChild(node.bindings[index].bind, `${rootTag}/bind[${index}]`);
            annotateChild(node.bindings[index].value, `${rootTag}/value[${index}]`);
        }
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof IfNode) {
        annotateChild(node.condExpr, `${rootTag}/cond`);
        annotateChild(node.trueBranchExpr, `${rootTag}/true`);
        annotateChild(node.falseBranchExpr, `${rootTag}/false`);
        return;
    }

    if (node instanceof WhileNode) {
        annotateChild(node.condExpr, `${rootTag}/cond`);
        annotateChild(node.bodyExpr, `${rootTag}/body`);
        return;
    }

    if (node instanceof CondNode) {
        for (let index = 0; index < node.clausesExprs.length; index += 1) {
            annotateChild(node.clausesExprs[index].cond, `${rootTag}/clause-cond[${index}]`);
            annotateChild(node.clausesExprs[index].body, `${rootTag}/clause-body[${index}]`);
        }
        return;
    }

    if (node instanceof DvarNode) {
        annotateChild(node.bind, `${rootTag}/bind`);
        annotateChild(node.value, `${rootTag}/value`);
        return;
    }

    if (node instanceof DfunNode) {
        annotateChild(node.name, `${rootTag}/name`);
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.returnType, `${rootTag}/return`);
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof DeclaredDfunNode) {
        annotateChild(node.name, `${rootTag}/name`);
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.returnType, `${rootTag}/return`);
        return;
    }

    if (node instanceof SetNode) {
        annotateChild(node.identifier, `${rootTag}/target`);
        annotateChild(node.value, `${rootTag}/value`);
        return;
    }

    if (node instanceof SeqNode) {
        for (let index = 0; index < node.expressions.length; index += 1) {
            annotateChild(node.expressions[index], `${rootTag}/expr[${index}]`);
        }
        return;
    }

    if (node instanceof TypeVarBindNode) {
        annotateChild(node.var, `${rootTag}/var`);
        annotateChild(node.typeExp, `${rootTag}/type`);
        return;
    }

    if (node instanceof TypeToFromNode) {
        annotateChild(node.returnType, `${rootTag}/return`);
        for (let index = 0; index < node.paramTypes.length; index += 1) {
            annotateChild(node.paramTypes[index], `${rootTag}/param-type[${index}]`);
        }
        return;
    }

    if (node instanceof TypeUnionNode) {
        for (let index = 0; index < node.types.length; index += 1) {
            annotateChild(node.types[index], `${rootTag}/member[${index}]`);
        }
        return;
    }

    if (node instanceof ClassNode) {
        annotateChild(node.name, `${rootTag}/name`);
        for (let index = 0; index < node.memberNodeList.length; index += 1) {
            annotateChild(node.memberNodeList[index], `${rootTag}/member[${index}]`);
        }
        return;
    }

    if (node instanceof PublicNode) {
        annotateChild(node.inner, `${rootTag}/inner`);
        return;
    }

    if (node instanceof ClassPropertyNode) {
        annotateChild(node.bind, `${rootTag}/bind`);
        return;
    }

    if (node instanceof ClassMethodNode) {
        annotateChild(node.methodName, `${rootTag}/name`);
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.returnType, `${rootTag}/return`);
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof ClassConstructorNode) {
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof GenericClassNode) {
        annotateChild(node.genericName, `${rootTag}/name`);
        for (let index = 0; index < node.memberNodeList.length; index += 1) {
            annotateChild(node.memberNodeList[index], `${rootTag}/member[${index}]`);
        }
        return;
    }

    if (node instanceof GenericDfunNode) {
        annotateChild(node.genericName, `${rootTag}/name`);
        annotateTypeVarBindingList(node.params, `${rootTag}/param`);
        annotateChild(node.returnType, `${rootTag}/return`);
        annotateChild(node.body, `${rootTag}/body`);
        return;
    }

    if (node instanceof GenericCallNode) {
        annotateChild(node.callee, `${rootTag}/callee`);
        for (let index = 0; index < node.typeArgs.length; index += 1) {
            annotateChild(node.typeArgs[index], `${rootTag}/type-arg[${index}]`);
        }
        return;
    }

    if (node instanceof FunctionCallNode) {
        annotateChild(node.callee, `${rootTag}/callee`);
        for (let index = 0; index < node.args.length; index += 1) {
            annotateChild(node.args[index], `${rootTag}/arg[${index}]`);
        }
        return;
    }

    if (node instanceof MatchNode) {
        annotateChild(node.unionExpr, `${rootTag}/union`);
        for (let index = 0; index < node.branches.length; index += 1) {
            annotateChild(node.branches[index].bind, `${rootTag}/branch-bind[${index}]`);
            annotateChild(node.branches[index].body, `${rootTag}/branch-body[${index}]`);
        }
        return;
    }

    if (node instanceof ListNode) {
        for (let index = 0; index < node.elements.length; index += 1) {
            annotateChild(node.elements[index], `${rootTag}/element[${index}]`);
        }
    }
}

function buildCodeRootTag(node: AstNode, index: number): string {
    if (node instanceof DfunNode || node instanceof DeclaredDfunNode) {
        return `code:function:${node.name.name}:${index}`;
    }
    if (node instanceof GenericDfunNode) {
        return `code:generic-function:${node.genericName.name.name}:${index}`;
    }
    if (node instanceof ClassNode) {
        return `code:class:${node.name.name}:${index}`;
    }
    if (node instanceof GenericClassNode) {
        return `code:generic-class:${node.genericName.name.name}:${index}`;
    }
    if (node instanceof DvarNode && node.bind instanceof TypeVarBindNode) {
        return `code:global:${node.bind.var.name}:${index}`;
    }
    const metadata = getCompilationUnitMetadata(node);
    if (metadata !== undefined) {
        return `code:unit:${metadata.unitId}:root:${index}`;
    }
    return `code:root:${index}`;
}

export function annotateCanonicalTagsForCodeRoots(codeRoots: readonly AstNode[]): void {
    resetAstCanonicalTags();
    for (let index = 0; index < codeRoots.length; index += 1) {
        annotateCanonicalTagsForSubtree(codeRoots[index], buildCodeRootTag(codeRoots[index], index));
    }
}

export function annotateCanonicalTagsForProgram(program: ProgramNode): void {
    resetAstCanonicalTags();
    const rootTag = program.unitId === null ? "program:merged" : `program:${program.unitId.name}`;
    annotateCanonicalTagsForSubtree(program, rootTag);
}