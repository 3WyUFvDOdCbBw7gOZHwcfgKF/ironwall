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
	GenericNameNode,
	IdentifierNode,
	IfNode,
	LetNode,
	ListNode,
	MatchNode,
	ProgramNode,
	SeqNode,
	SetNode,
	TypeToFromNode,
	TypeUnionNode,
	TypeVarBindNode,
	WhileNode
} from "./AstNode";
import { inheritAstSource, withActiveParserNode } from "./Diagnostics";

const binaryBuiltinArity: number = 2;
const variadicFoldBuiltinNames: ReadonlySet<string> = new Set(["add", "sub", "mul", "and", "or"]);
const leftAssociatedVariadicFoldBuiltinNames: ReadonlySet<string> = new Set(["sub"]);

export function parsePass5(node: AstNode): AstNode {
	return rewriteAstNode(node, foldVariadicBuiltinCall);
}

export function parsePass6(node: AstNode): AstNode {
	return node;
}

function rewriteAstNode(node: AstNode, rewriteCall: (node: FunctionCallNode) => AstNode): AstNode {
	return withActiveParserNode(node, (): AstNode => {
		let rewrittenNode: AstNode;
		if (node instanceof FnNode) {
			rewrittenNode = new FnNode(
				node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
				rewriteAstNode(node.returnType, rewriteCall),
				rewriteAstNode(node.body, rewriteCall)
			);
		} else if (node instanceof LetNode) {
			rewrittenNode = new LetNode(
				node.bindings.map((binding: { bind: AstNode; value: AstNode }) => ({
					bind: rewriteAstNode(binding.bind, rewriteCall),
					value: rewriteAstNode(binding.value, rewriteCall)
				})),
				rewriteAstNode(node.body, rewriteCall)
			);
		} else if (node instanceof IfNode) {
			rewrittenNode = new IfNode(
				rewriteAstNode(node.condExpr, rewriteCall),
				rewriteAstNode(node.trueBranchExpr, rewriteCall),
				rewriteAstNode(node.falseBranchExpr, rewriteCall)
			);
		} else if (node instanceof WhileNode) {
			rewrittenNode = new WhileNode(
				rewriteAstNode(node.condExpr, rewriteCall),
				rewriteAstNode(node.bodyExpr, rewriteCall)
			);
		} else if (node instanceof CondNode) {
			rewrittenNode = new CondNode(
				node.clausesExprs.map((clause: { cond: AstNode; body: AstNode }) => ({
					cond: rewriteAstNode(clause.cond, rewriteCall),
					body: rewriteAstNode(clause.body, rewriteCall)
				}))
			);
		} else if (node instanceof TypeVarBindNode) {
			rewrittenNode = rewriteTypeVarBindNode(node, rewriteCall);
		} else if (node instanceof TypeToFromNode) {
			rewrittenNode = new TypeToFromNode(
				rewriteAstNode(node.returnType, rewriteCall),
				node.paramTypes.map((paramType: AstNode) => rewriteAstNode(paramType, rewriteCall))
			);
		} else if (node instanceof TypeUnionNode) {
			rewrittenNode = new TypeUnionNode(node.types.map((typeNode: AstNode) => rewriteAstNode(typeNode, rewriteCall)));
		} else if (node instanceof ProgramNode) {
			rewrittenNode = new ProgramNode(
				node.topLevelExpressions.map((expression: AstNode) => rewriteAstNode(expression, rewriteCall)),
				node.unitId
			);
		} else if (node instanceof DvarNode) {
			rewrittenNode = new DvarNode(
				rewriteAstNode(node.bind, rewriteCall),
				rewriteAstNode(node.value, rewriteCall)
			);
		} else if (node instanceof SeqNode) {
			rewrittenNode = new SeqNode(node.expressions.map((expression: AstNode) => rewriteAstNode(expression, rewriteCall)));
		} else if (node instanceof DfunNode) {
			rewrittenNode = new DfunNode(
				node.name,
				node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
				rewriteAstNode(node.returnType, rewriteCall),
				rewriteAstNode(node.body, rewriteCall)
			);
		} else if (node instanceof DeclaredDfunNode) {
			rewrittenNode = new DeclaredDfunNode(
				node.name,
				node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
				rewriteAstNode(node.returnType, rewriteCall)
			);
		} else if (node instanceof SetNode) {
			rewrittenNode = new SetNode(node.identifier, rewriteAstNode(node.value, rewriteCall));
		} else if (node instanceof ClassNode) {
			rewrittenNode = new ClassNode(
				node.name,
				node.constructorNodeList.map((constructorNode: ClassConstructorNode) => rewriteClassConstructorNode(constructorNode, rewriteCall)),
				node.methodNodeList.map((methodNode: ClassMethodNode) => rewriteClassMethodNode(methodNode, rewriteCall)),
				node.propertyNodeList.map((propertyNode: ClassPropertyNode) => rewriteClassPropertyNode(propertyNode, rewriteCall))
			);
		} else if (node instanceof ClassPropertyNode) {
			rewrittenNode = rewriteClassPropertyNode(node, rewriteCall);
		} else if (node instanceof ClassMethodNode) {
			rewrittenNode = rewriteClassMethodNode(node, rewriteCall);
		} else if (node instanceof ClassConstructorNode) {
			rewrittenNode = rewriteClassConstructorNode(node, rewriteCall);
		} else if (node instanceof GenericNameNode) {
			rewrittenNode = new GenericNameNode(node.name, node.genericTypeArgs);
		} else if (node instanceof GenericClassNode) {
			rewrittenNode = new GenericClassNode(
				new GenericNameNode(node.genericName.name, node.genericName.genericTypeArgs),
				node.constructorNodeList.map((constructorNode: ClassConstructorNode) => rewriteClassConstructorNode(constructorNode, rewriteCall)),
				node.methodNodeList.map((methodNode: ClassMethodNode) => rewriteClassMethodNode(methodNode, rewriteCall)),
				node.propertyNodeList.map((propertyNode: ClassPropertyNode) => rewriteClassPropertyNode(propertyNode, rewriteCall))
			);
		} else if (node instanceof GenericDfunNode) {
			rewrittenNode = new GenericDfunNode(
				new GenericNameNode(node.genericName.name, node.genericName.genericTypeArgs),
				node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
				rewriteAstNode(node.returnType, rewriteCall),
				rewriteAstNode(node.body, rewriteCall)
			);
		} else if (node instanceof FunctionCallNode) {
			const rewrittenCall: FunctionCallNode = new FunctionCallNode(
				rewriteAstNode(node.callee, rewriteCall),
				node.args.map((arg: AstNode) => rewriteAstNode(arg, rewriteCall))
			);
			rewrittenNode = rewriteCall(rewrittenCall);
		} else if (node instanceof GenericCallNode) {
			rewrittenNode = new GenericCallNode(
				rewriteAstNode(node.callee, rewriteCall),
				node.typeArgs.map((typeArg: AstNode) => rewriteAstNode(typeArg, rewriteCall))
			);
		} else if (node instanceof MatchNode) {
			rewrittenNode = new MatchNode(
				rewriteAstNode(node.unionExpr, rewriteCall),
				node.branches.map((branch: { bind: TypeVarBindNode; body: AstNode }) => ({
					bind: rewriteTypeVarBindNode(branch.bind, rewriteCall),
					body: rewriteAstNode(branch.body, rewriteCall)
				}))
			);
		} else if (node instanceof ListNode) {
			rewrittenNode = new ListNode(node.elements.map((element: AstNode) => rewriteAstNode(element, rewriteCall)));
		} else {
			rewrittenNode = node;
		}

		return inheritAstSource(rewrittenNode, node);
	});
}

function rewriteTypeVarBindNode(node: TypeVarBindNode, rewriteCall: (node: FunctionCallNode) => AstNode): TypeVarBindNode {
	return new TypeVarBindNode(node.var, rewriteAstNode(node.typeExp, rewriteCall));
}

function rewriteClassPropertyNode(node: ClassPropertyNode, rewriteCall: (node: FunctionCallNode) => AstNode): ClassPropertyNode {
	return new ClassPropertyNode(rewriteTypeVarBindNode(node.bind, rewriteCall));
}

function rewriteClassMethodNode(node: ClassMethodNode, rewriteCall: (node: FunctionCallNode) => AstNode): ClassMethodNode {
	return new ClassMethodNode(
		node.methodName,
		node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
		rewriteAstNode(node.returnType, rewriteCall),
		rewriteAstNode(node.body, rewriteCall)
	);
}

function rewriteClassConstructorNode(node: ClassConstructorNode, rewriteCall: (node: FunctionCallNode) => AstNode): ClassConstructorNode {
	return new ClassConstructorNode(
		node.params.map((param: TypeVarBindNode) => rewriteTypeVarBindNode(param, rewriteCall)),
		rewriteAstNode(node.body, rewriteCall)
	);
}

function foldVariadicBuiltinCall(node: FunctionCallNode): AstNode {
	if (!(node.callee instanceof IdentifierNode)) {
		return node;
	}
	if (!variadicFoldBuiltinNames.has(node.callee.name) || node.args.length <= binaryBuiltinArity) {
		return node;
	}
	if (leftAssociatedVariadicFoldBuiltinNames.has(node.callee.name)) {
		return buildLeftAssociatedBuiltinCall(node.callee.name, node.args);
	}
	return buildRightAssociatedBuiltinCall(node.callee.name, node.args);
}

function buildLeftAssociatedBuiltinCall(name: string, args: readonly AstNode[]): FunctionCallNode {
	if (args.length < binaryBuiltinArity) {
		throw new Error(`${name} requires at least ${binaryBuiltinArity} arguments for left-associated folding`);
	}
	let current: FunctionCallNode = new FunctionCallNode(new IdentifierNode(name), [args[0], args[1]]);
	for (let index: number = 2; index < args.length; index += 1) {
		current = new FunctionCallNode(new IdentifierNode(name), [current, args[index]]);
	}
	return current;
}

function buildRightAssociatedBuiltinCall(name: string, args: readonly AstNode[]): FunctionCallNode {
	if (args.length < binaryBuiltinArity) {
		throw new Error(`${name} requires at least ${binaryBuiltinArity} arguments for right-associated folding`);
	}
	let current: FunctionCallNode = new FunctionCallNode(new IdentifierNode(name), [args[args.length - 2], args[args.length - 1]]);
	for (let index: number = args.length - 3; index >= 0; index -= 1) {
		current = new FunctionCallNode(new IdentifierNode(name), [args[index], current]);
	}
	return current;
}
