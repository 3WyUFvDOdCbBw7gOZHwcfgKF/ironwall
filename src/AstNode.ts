import type { ComplexLiteralValue } from "./lexer";

export enum AstNodeType {
  IdentifierNode,
  TextDatabaseReferenceNode,
  NumberLiteralNode,
  ListNode, // Generic list node
  AngleParenListNode,
  SquareParenListNode,
  CurlyParenListNode,
  RoundParenListNode,
  FnNode, // Anonymous function node
  LetNode,
  IfNode,
  WhileNode,
  CondNode,
  //Intermediate,
  TypeVarBindNode,
  TypeToFromNode,
  TypeUnionNode,
  ProgramNode,
  ImportNode,
  ExportNode,
  DvarNode,
  DfunNode, //Named function node
  DeclaredDfunNode,
  SetNode,
  SeqNode,
  ClassNode,
  ClassPropertyNode,
  ClassMethodNode,
  ClassConstructorNode,
  GenericNameNode,
  GenericClassNode,
  GenericDfunNode,
  FunctionCallNode, // 新增：普通函数调用节点
  GenericCallNode,   // 新增：泛型调用节点
  MatchNode // 新增：联合类型模式匹配节点
}

// 各种 AST 节点类型
export class IdentifierNode {

  readonly kind: AstNodeType = AstNodeType.IdentifierNode;


  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class TextDatabaseReferenceNode {

  readonly kind: AstNodeType = AstNodeType.TextDatabaseReferenceNode;


  typeName: string;
  entryName: string;
  referenceName: string;
  content: string | number | null;
  constructor(typeName: string, entryName: string, referenceName?: string, content?: string | number | null) {
    this.typeName = typeName;
    this.entryName = entryName;
    this.referenceName = referenceName ?? `$${entryName}^${typeName}`;
    this.content = content ?? null;
  }
}

export class NumberLiteralNode {

  readonly kind: AstNodeType = AstNodeType.NumberLiteralNode;


  typeName: string;
  value: number | ComplexLiteralValue;
  raw: string;
  constructor(typeName: string, value: number | ComplexLiteralValue, raw?: string) {
    this.typeName = typeName;
    this.value = value;
    this.raw = raw ?? (typeof value === "number"
      ? `$${String(value)}^${typeName}`
      : `$0real${value.realRaw}img${value.imagRaw}^${typeName}`);
  }
}

// Generic ListNode
export class ListNode {

  readonly kind: AstNodeType = AstNodeType.ListNode;

  elements: AstNode[];
  constructor(elements: AstNode[]) {
    this.elements = elements;
  }
}
//Speicific ListNode types for different brackets
export class SquareParenListNode {

  readonly kind: AstNodeType = AstNodeType.SquareParenListNode;


  elements: AstNode[];
  constructor(elements: AstNode[]) {
    this.elements = elements;
  }
}
export class CurlyParenListNode {

  readonly kind: AstNodeType = AstNodeType.CurlyParenListNode;


  elements: AstNode[];
  constructor(elements: AstNode[]) {
    this.elements = elements;
  }
}
export class AngleParenListNode {

  readonly kind: AstNodeType = AstNodeType.AngleParenListNode;


  elements: AstNode[];
  constructor(elements: AstNode[]) {
    this.elements = elements;
  }
}
export class RoundParenListNode {

  readonly kind: AstNodeType = AstNodeType.RoundParenListNode;


  elements: AstNode[];
  constructor(elements: AstNode[]) {
    this.elements = elements;
  }
}



export class FnNode {

  readonly kind: AstNodeType = AstNodeType.FnNode;


  params: TypeVarBindNode[]; // 参数列表，带类型绑定
  returnType: AstNode; // 返回类型
  body: AstNode; // 函数体
  constructor(params: TypeVarBindNode[], returnType: AstNode, body: AstNode) {
    this.params = params;
    this.returnType = returnType;
    this.body = body;
  }
}

export class LetNode {

  readonly kind: AstNodeType = AstNodeType.LetNode;


  bindings: { bind: AstNode; value: AstNode }[]; // 绑定列表
  body: AstNode; // 函数体
  constructor(bindings: { bind: AstNode; value: AstNode }[], body: AstNode) {
    this.bindings = bindings;
    this.body = body;
  }
}

export class IfNode {

  readonly kind: AstNodeType = AstNodeType.IfNode;

  condExpr: AstNode;
  trueBranchExpr: AstNode;
  //elseifExprs: { cond: AstNode; exprs: AstNode[] }[];
  falseBranchExpr: AstNode;
  constructor(condExpr: AstNode, trueBranchExpr:AstNode, falseBranchExpr: AstNode) {
    this.condExpr = condExpr;
    this.trueBranchExpr = trueBranchExpr;
    this.falseBranchExpr = falseBranchExpr;
  }
}

export class WhileNode {
  readonly kind: AstNodeType = AstNodeType.WhileNode;

  condExpr: AstNode;
  bodyExpr: AstNode;
  constructor(condExpr: AstNode, bodyExpr: AstNode) {
    this.condExpr = condExpr;
    this.bodyExpr = bodyExpr;
  }
}

export class CondNode {
  readonly kind: AstNodeType = AstNodeType.CondNode;
  clausesExprs: { cond: AstNode; body: AstNode }[];
  constructor(clausesExprs: { cond: AstNode; body: AstNode }[]) {
    this.clausesExprs = clausesExprs;
  }
}

// export class IntermediateNode {
//   token: AbstractToken;
//   constructor(token: AbstractToken) {
//     this.token = token;
//   }
// }

// 类型系统相关AST节点
export class TypeVarBindNode {

  readonly kind: AstNodeType = AstNodeType.TypeVarBindNode;

  var: IdentifierNode;
  typeExp: AstNode;
  constructor(identifier: IdentifierNode, typeAnn: AstNode) {
    this.var = identifier;
    this.typeExp = typeAnn;
  }
}

export class TypeToFromNode {
  readonly kind: AstNodeType = AstNodeType.TypeToFromNode;


  returnType: AstNode;
  paramTypes: AstNode[];
  constructor(returnType: AstNode, paramTypes: AstNode[]) {
    this.returnType = returnType;
    this.paramTypes = paramTypes;
  }
}

export class TypeUnionNode {
  readonly kind: AstNodeType = AstNodeType.TypeUnionNode;


  types: AstNode[];
  constructor(types: AstNode[]) {
    this.types = types;
  }
}

export class ProgramNode {
  readonly kind: AstNodeType = AstNodeType.ProgramNode;

  unitId: IdentifierNode | null;
  topLevelExpressions: AstNode[];
  constructor(topLevelExpressions: AstNode[], unitId: IdentifierNode | null = null) {
    this.unitId = unitId;
    this.topLevelExpressions = topLevelExpressions;
  }
}

export class ImportNode {
  readonly kind: AstNodeType = AstNodeType.ImportNode;

  packagePath: IdentifierNode;
  constructor(packagePath: IdentifierNode) {
    this.packagePath = packagePath;
  }
}

export class ExportNode {
  readonly kind: AstNodeType = AstNodeType.ExportNode;

  inner: AstNode;
  constructor(inner: AstNode) {
    this.inner = inner;
  }
}

// 新增 DvarNode 类型
export class DvarNode {
  readonly kind: AstNodeType = AstNodeType.DvarNode;

  bind: AstNode;
  value: AstNode;
  constructor(bind: AstNode, value: AstNode) {
    this.bind = bind;
    this.value = value;
  }
}

// 新增 SeqNode 类型
export class SeqNode {
  readonly kind: AstNodeType = AstNodeType.SeqNode;

  expressions: AstNode[];
  constructor(expressions: AstNode[]) {
    this.expressions = expressions;
  }
}

// 新增 DfunNode 类型
export class DfunNode {
  readonly kind: AstNodeType = AstNodeType.DfunNode;

  name: IdentifierNode; // 函数名
  params: TypeVarBindNode[]; // 参数列表，带类型绑定
  returnType: AstNode; // 返回类型
  body: AstNode; // 函数体
  constructor(name: IdentifierNode, params: TypeVarBindNode[], returnType: AstNode, body: AstNode) {
    this.name = name;
    this.params = params;
    this.returnType = returnType;
    this.body = body;
  }
}

export class DeclaredDfunNode {
  readonly kind: AstNodeType = AstNodeType.DeclaredDfunNode;

  name: IdentifierNode;
  params: TypeVarBindNode[];
  returnType: AstNode;
  constructor(name: IdentifierNode, params: TypeVarBindNode[], returnType: AstNode) {
    this.name = name;
    this.params = params;
    this.returnType = returnType;
  }
}

export class SetNode {
  readonly kind: AstNodeType = AstNodeType.SetNode;
  
  identifier: IdentifierNode; // 被赋值的标识符
  value: AstNode; // 赋值的值
  constructor(identifier: IdentifierNode, value: AstNode) {
    this.identifier = identifier;
    this.value = value;
  }
}

export class ClassNode {
  readonly kind: AstNodeType = AstNodeType.ClassNode;

  name: IdentifierNode;
  constructorNodeList: ClassConstructorNode[];
  methodNodeList: ClassMethodNode[];
  propertyNodeList: ClassPropertyNode[];

  constructor(name: IdentifierNode, constructorNodeList: ClassConstructorNode[], methodNodeList: ClassMethodNode[], propertyNodeList: ClassPropertyNode[]) {
    this.name = name;
    this.constructorNodeList = constructorNodeList;
    this.methodNodeList = methodNodeList;
    this.propertyNodeList = propertyNodeList;
  }
}

export class ClassPropertyNode {
  readonly kind: AstNodeType = AstNodeType.ClassPropertyNode;

  bind: TypeVarBindNode;
  constructor(bind: TypeVarBindNode) {
    this.bind = bind;
  }
}

export class ClassMethodNode {
  readonly kind: AstNodeType = AstNodeType.ClassMethodNode;


  methodName: IdentifierNode;
  params: TypeVarBindNode[]; // 参数列表，带类型绑定
  returnType: AstNode; // 返回类型
  body: AstNode; // 方法体
  constructor(methodName: IdentifierNode, params: TypeVarBindNode[], returnType: AstNode, body: AstNode) {
    this.methodName = methodName;
    this.params = params;
    this.returnType = returnType;
    this.body = body;
  }
}

export class ClassConstructorNode {
  
  readonly kind: AstNodeType = AstNodeType.ClassConstructorNode;

  params: TypeVarBindNode[]; // 参数列表，带类型绑定
  body: AstNode; // 构造函数体
  constructor(params: TypeVarBindNode[], body: AstNode) {
    this.params = params;
    this.body = body;
  }
}

export class GenericNameNode {
  readonly kind: AstNodeType = AstNodeType.GenericNameNode;

  name: IdentifierNode;
  genericTypeArgs: IdentifierNode[];
  constructor(name: IdentifierNode, genericTypeArgs: IdentifierNode[]) {
    this.name = name;
    this.genericTypeArgs = genericTypeArgs;
  }
}

export class GenericClassNode {
  readonly kind: AstNodeType = AstNodeType.GenericClassNode;

  genericName: GenericNameNode;;
  constructorNodeList: ClassConstructorNode[];
  methodNodeList: ClassMethodNode[];
  propertyNodeList: ClassPropertyNode[];

  constructor(genericName: GenericNameNode, constructorNodeList: ClassConstructorNode[], methodNodeList: ClassMethodNode[], propertyNodeList: ClassPropertyNode[]) {
    this.genericName = genericName;
    this.constructorNodeList = constructorNodeList;
    this.methodNodeList = methodNodeList;
    this.propertyNodeList = propertyNodeList;
  }
}

export class GenericDfunNode {
  readonly kind: AstNodeType = AstNodeType.GenericDfunNode;

  genericName: GenericNameNode;
  params: TypeVarBindNode[]; // 参数列表，带类型绑定
  returnType: AstNode; // 返回类型
  body: AstNode; // 函数体
  constructor(genericName: GenericNameNode, params: TypeVarBindNode[], returnType: AstNode, body: AstNode) {
    this.genericName = genericName;
    this.params = params;
    this.returnType = returnType;
    this.body = body;
  }
}

// 普通函数调用节点
export class FunctionCallNode {
  readonly kind: AstNodeType = AstNodeType.FunctionCallNode;
  callee: AstNode; // 被调用对象（函数名或表达式）
  args: AstNode[]; // 参数表达式
  constructor(callee: AstNode, args: AstNode[]) {
    this.callee = callee;
    this.args = args;
  }
}

// 泛型调用节点（如 (<id i5> 42) 或 <foo i5>）
export class GenericCallNode {
  readonly kind: AstNodeType = AstNodeType.GenericCallNode;
  callee: AstNode; // 泛型函数/类名
  typeArgs: AstNode[]; // 类型参数
  constructor(callee: AstNode, typeArgs: AstNode[]) {
    this.callee = callee;
    this.typeArgs = typeArgs;
  }
}

// 联合类型模式匹配节点
export class MatchNode {
  readonly kind: AstNodeType = AstNodeType.MatchNode;
  unionExpr: AstNode; // 被匹配的联合类型表达式
  branches: { bind: TypeVarBindNode; body: AstNode }[]; // 分支，每个分支为<bind ...> body
  constructor(unionExpr: AstNode, branches: { bind: TypeVarBindNode; body: AstNode }[]) {
    this.unionExpr = unionExpr;
    this.branches = branches;
  }
}

// AstNode 
export type AstNode =
  | IdentifierNode
  | TextDatabaseReferenceNode
  | NumberLiteralNode
  | ListNode // Added generic ListNode
  | RoundParenListNode
  | SquareParenListNode
  | CurlyParenListNode
  | AngleParenListNode
  | FnNode
  | LetNode
  | IfNode
  | WhileNode
  | CondNode
  | ProgramNode
  | ImportNode
  | ExportNode
  | DvarNode
  | DfunNode
  | DeclaredDfunNode
  | SeqNode
  | SetNode
  //| IntermediateNode
  | TypeVarBindNode
  | TypeToFromNode
  | TypeUnionNode
  | ClassNode
  | ClassPropertyNode
  | ClassMethodNode
  | ClassConstructorNode
  | GenericNameNode
  | GenericClassNode
  | GenericDfunNode
  | FunctionCallNode
  | GenericCallNode
  | MatchNode; // 新增

export type ExportableTopLevelAstNode =
  | ClassNode
  | GenericClassNode
  | DfunNode
  | DeclaredDfunNode
  | GenericDfunNode
  | DvarNode;

export function isExportableTopLevelAstNode(node: AstNode): node is ExportableTopLevelAstNode {
  return node instanceof ClassNode
    || node instanceof GenericClassNode
    || node instanceof DfunNode
    || node instanceof DeclaredDfunNode
    || node instanceof GenericDfunNode
    || node instanceof DvarNode;
}

export function unwrapExportNode(node: AstNode): AstNode {
  return node instanceof ExportNode ? node.inner : node;
}

