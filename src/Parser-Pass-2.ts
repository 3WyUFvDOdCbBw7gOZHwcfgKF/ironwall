
import {
  AstNode,
  IdentifierNode,
  NumberLiteralNode,
  TextDatabaseReferenceNode,
  RoundParenListNode,
  DfunNode,
  DeclaredDfunNode,
  FnNode,
  LetNode,
  DvarNode,
  ExportNode,
  IfNode,
  WhileNode,
  SeqNode,
  ProgramNode,
  ImportNode,
  PublicNode,
  AngleParenListNode,
  TypeVarBindNode,
  TypeToFromNode,
  TypeUnionNode,
  SquareParenListNode,
  CurlyParenListNode,
  SetNode,
  CondNode,
  ClassNode,
  ClassPropertyNode,
  ClassMethodNode,
  ClassConstructorNode,
  ClassBodyMemberNode,
  GenericNameNode,
  GenericClassNode,
  GenericDfunNode,
  MatchNode,
  GenericCallNode,
  FunctionCallNode
} from "./AstNode";
import { inheritAstSource, withActiveParserNode } from "./Diagnostics";

// pass4: 识别所有 iw-spec.md 结构，生成对应 AST 节点
export function parsePass4(node: AstNode): AstNode {
  return withActiveParserNode(node, (): AstNode => {
    let parsedNode: AstNode;

    if (node instanceof IdentifierNode || node instanceof TextDatabaseReferenceNode || node instanceof NumberLiteralNode) {
      parsedNode = node;
    } else if (node instanceof SquareParenListNode) {
      parsedNode = parseSquareParenList(node);
    } else if (node instanceof CurlyParenListNode) {
      parsedNode = parseCurlyParenList(node);
    } else if (node instanceof AngleParenListNode) {
      parsedNode = parseAngleParenList(node);
    } else if (node instanceof RoundParenListNode) {
      parsedNode = parseRoundParenList(node);
    } else {
      parsedNode = node;
    }

    return inheritAstSource(parsedNode, node);
  });
}

function parseSquareParenList(node: SquareParenListNode): AstNode {
  const processedElements: AstNode[] = node.elements.map((element) => parsePass4(element));
  if (processedElements.length === 2 && processedElements[0] instanceof IdentifierNode) {
    return new TypeVarBindNode(processedElements[0], processedElements[1]);
  }
  if (processedElements.length > 0 && processedElements[0] instanceof IdentifierNode) {
    throw new Error("Invalid bind structure: expected [identifier type]");
  }
  return new SquareParenListNode(processedElements);
}

function parseCurlyParenList(node: CurlyParenListNode): AstNode {
  const processedElements: AstNode[] = node.elements.map((element) => parsePass4(element));
  if (processedElements.length > 0 && processedElements[0] instanceof IdentifierNode && processedElements[0].name === "program") {
    if (processedElements.length >= 2 && processedElements[1] instanceof IdentifierNode) {
      return new ProgramNode(processedElements.slice(2), processedElements[1]);
    }
    return new ProgramNode(processedElements.slice(1));
  }
  return new SeqNode(processedElements);
}

/**
 * 解析尖括号列表，处理类型相关结构
 */
function parseAngleParenList(node: AngleParenListNode): AstNode {
  if (node.elements.length === 0) {
    return node;
  }

  const firstElement: AstNode = node.elements[0];

  if (firstElement instanceof IdentifierNode && firstElement.name === "bind") {
    throw new Error("Legacy '<bind ...>' syntax is no longer accepted; use '[identifier type]' instead");
  }

  // 处理 <to returnType from paramType1 paramType2 ...> 结构
  if (firstElement instanceof IdentifierNode && firstElement.name === "to") {
    if (node.elements.length >= 3) {
      const returnType: AstNode = parsePass4(node.elements[1]);
      const fromKeyword: AstNode = node.elements[2];

      if (fromKeyword instanceof IdentifierNode && fromKeyword.name === "from") {
        const paramTypes: AstNode[] = node.elements.slice(3).map(element => parsePass4(element));
        return new TypeToFromNode(returnType, paramTypes);
      }
    }
    throw new Error("Invalid function type structure: expected <to returnType from paramType1 paramType2 ...>");
  }

  // 处理 <union type1 type2 ...> 结构
  if (firstElement instanceof IdentifierNode && firstElement.name === "union") {
    if (node.elements.length >= 2) {
      const types: AstNode[] = node.elements.slice(1).map(element => parsePass4(element));
      return new TypeUnionNode(types);
    }
    throw new Error("Invalid union type structure: expected <union type1 type2 ...>");
  }

  // 处理 <generic name T1 T2 ...> 结构
  if (firstElement instanceof IdentifierNode && firstElement.name === "generic") {
    if (node.elements.length >= 2) {
      const name: AstNode = parsePass4(node.elements[1]);
      const genericArgs: AstNode[] = node.elements.slice(2).map(element => parsePass4(element));
      
      if (name instanceof IdentifierNode) {
        const genericTypeArgs: IdentifierNode[] = [];
        for (const arg of genericArgs) {
          if (arg instanceof IdentifierNode) {
            genericTypeArgs.push(arg);
          } else {
            throw new Error("Generic type arguments must be identifiers");
          }
        }
        return new GenericNameNode(name, genericTypeArgs);
      }
    }
    throw new Error("Invalid generic structure: expected <generic name T1 T2 ...>");
  }

  // 对于其他尖括号结构，递归处理所有元素
  const processedElements: AstNode[] = node.elements.map(element => parsePass4(element));
  const newGenericCallNode:GenericCallNode = new GenericCallNode(processedElements[0], processedElements.slice(1));
  return newGenericCallNode;//new AngleParenListNode(processedElements);
}

/**
 * 解析圆括号列表，处理主要的表达式结构
 */
function parseRoundParenList(node: RoundParenListNode): AstNode {
  if (node.elements.length === 0) {
    return node;
  }

  const firstElement: AstNode = node.elements[0];
  const legacyGenericCalleeKeywords: Set<string> = new Set([
    "var",
    "var_set",
    "fn",
    "function",
    "declare",
    "let",
    "if",
    "while",
    "cond",
    "class",
    "match",
    "array_new"
  ]);

  if (!(firstElement instanceof IdentifierNode)) {
    const processedElements: AstNode[] = node.elements.map(element => parsePass4(element));
    return new FunctionCallNode(processedElements[0], processedElements.slice(1));
  }

  const keyword: string = firstElement.name;

  if (
    node.elements.length === 2 &&
    node.elements[1] instanceof AngleParenListNode &&
    !legacyGenericCalleeKeywords.has(keyword)
  ) {
    const callee: AstNode = parsePass4(firstElement);
    const typeArgs: AstNode[] = node.elements[1].elements.map((element) => parsePass4(element));
    return new GenericCallNode(callee, typeArgs);
  }

  switch (keyword) {
    case "dvar":
      throwLegacyKeywordError("dvar", "var");
    case "var":
      return parseDvarExpression(node);
    case "set":
      throwLegacyKeywordError("set", "var_set");
    case "assign":
      throwLegacyKeywordError("assign", "var_set");
    case "var_set":
      return parseSetExpression(node);
    case "fn":
      return parseFnExpression(node);
    case "dfun":
      throwLegacyKeywordError("dfun", "function");
    case "function":
      return parseDfunExpression(node);
    case "declare":
      return parseDeclareExpression(node);
    case "let":
      return parseLetExpression(node);
    case "if":
      return parseIfExpression(node);
    case "while":
      return parseWhileExpression(node);
    case "cond":
      return parseCondExpression(node);
    case "public":
      return parsePublicExpression(node);
    case "seq":
      throw new Error("Legacy '(seq ...)' blocks are no longer accepted; use '{...}' blocks instead");
    case "class":
      return parseClassExpression(node);
    case "match":
      return parseMatchExpression(node);
    case "import":
      return parseImportExpression(node);
    case "export":
      return parseExportExpression(node);
    default:
      // 对于其他圆括号结构，递归处理所有元素
      const processedElements: AstNode[] = node.elements.map(element => parsePass4(element));

      const newFunctionCallNode = new FunctionCallNode(processedElements[0], processedElements.slice(1));
      return newFunctionCallNode;
      //return new RoundParenListNode(processedElements);
  }
}

function parsePublicExpression(node: RoundParenListNode): PublicNode {
  if (node.elements.length !== 2) {
    throw new Error("public expects exactly one argument");
  }

  const inner: AstNode = parsePass4(node.elements[1]);
  if (inner instanceof PublicNode) {
    throw new Error("public cannot wrap public");
  }

  return new PublicNode(inner);
}

function throwLegacyKeywordError(legacyKeyword: string, canonicalKeyword: string): never {
  throw new Error(`Legacy '${legacyKeyword}' syntax is no longer accepted; use '${canonicalKeyword}' instead`);
}

function parseImportExpression(node: RoundParenListNode): ImportNode {
  if (node.elements.length !== 2) {
    throw new Error("Invalid import structure: expected (import package-path)");
  }

  const packageNode: AstNode = parsePass4(node.elements[1]);
  if (!(packageNode instanceof IdentifierNode)) {
    throw new Error("Import target must be a package path identifier");
  }

  return new ImportNode(packageNode);
}

function parseExportExpression(node: RoundParenListNode): ExportNode {
  if (node.elements.length !== 2) {
    throw new Error("export expects exactly one argument");
  }

  return new ExportNode(parsePass4(node.elements[1]));
}

/**
 * 解析 (var [identifier type] expression) 结构
 */
function parseDvarExpression(node: RoundParenListNode): DvarNode {
  if (node.elements.length !== 3) {
    throw new Error("Invalid var structure: expected (var [identifier type] expression)");
  }

  const bindExpression: AstNode = parsePass4(node.elements[1]);
  const valueExpression: AstNode = parsePass4(node.elements[2]);

  return new DvarNode(bindExpression, valueExpression);
}

/**
 * 解析 (var_set identifier expression) 结构
 */
function parseSetExpression(node: RoundParenListNode): SetNode {
  if (node.elements.length !== 3) {
    throw new Error("Invalid var_set structure: expected (var_set identifier expression)");
  }

  const identifier: AstNode = parsePass4(node.elements[1]);
  const value: AstNode = parsePass4(node.elements[2]);

  if (!(identifier instanceof IdentifierNode)) {
    throw new Error("var_set target must be an identifier");
  }

  return new SetNode(identifier, value);
}

/**
 * 解析 (fn ([param1 type1] ...) to returnType in bodyexp) 结构
 */
function parseFnExpression(node: RoundParenListNode): FnNode {
  if (node.elements.length !== 6) {
    throw new Error("Invalid fn structure: expected (fn ([param1 type1] ...) to returnType in bodyexp)");
  }

  const paramsNode: AstNode = node.elements[1];
  const toKeyword: AstNode = node.elements[2];
  const returnType: AstNode = parsePass4(node.elements[3]);
  const inKeyword: AstNode = node.elements[4];
  const body: AstNode = parsePass4(node.elements[5]);

  if (!(toKeyword instanceof IdentifierNode) || toKeyword.name !== "to") {
    throw new Error("Expected 'to' keyword in fn expression");
  }

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in fn expression");
  }

  // 解析参数列表
  const params: TypeVarBindNode[] = parseParameterList(paramsNode);

  return new FnNode(params, returnType, body);
}

/**
 * 解析 (function 函数名 ([参数1 类型] ...) to 返回类型 in 表达式) 结构
 */
function parseDfunExpression(node: RoundParenListNode): AstNode {
  if (node.elements.length !== 7) {
    throw new Error("Invalid function structure: expected (function name ([param1 type1] ...) to returnType in bodyexp)");
  }

  const nameNode: AstNode = parsePass4(node.elements[1]);
  
  // 检查是否是泛型函数定义
  if (nameNode instanceof GenericNameNode) {
    const paramsNode: AstNode = node.elements[2];
    const toKeyword: AstNode = node.elements[3];
    const returnType: AstNode = parsePass4(node.elements[4]);
    const inKeyword: AstNode = node.elements[5];
    const body: AstNode = parsePass4(node.elements[6]);

    if (!(toKeyword instanceof IdentifierNode) || toKeyword.name !== "to") {
      throw new Error("Expected 'to' keyword in function expression");
    }

    if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
      throw new Error("Expected 'in' keyword in function expression");
    }

    const params: TypeVarBindNode[] = parseParameterList(paramsNode);
    return new GenericDfunNode(nameNode, params, returnType, body);
  }

  if (!(nameNode instanceof IdentifierNode)) {
    throw new Error("Function name must be an identifier");
  }

  const paramsNode: AstNode = node.elements[2];
  const toKeyword: AstNode = node.elements[3];
  const returnType: AstNode = parsePass4(node.elements[4]);
  const inKeyword: AstNode = node.elements[5];
  const body: AstNode = parsePass4(node.elements[6]);

  if (!(toKeyword instanceof IdentifierNode) || toKeyword.name !== "to") {
    throw new Error("Expected 'to' keyword in function expression");
  }

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in function expression");
  }

  const params: TypeVarBindNode[] = parseParameterList(paramsNode);

  return new DfunNode(nameNode, params, returnType, body);
}

function parseDeclaredDfunExpression(node: RoundParenListNode): DeclaredDfunNode {
  if (node.elements.length !== 5) {
    throw new Error("Invalid declared function structure: expected (function name ([param1 type1] ...) to returnType)");
  }

  const nameNode: AstNode = parsePass4(node.elements[1]);
  if (nameNode instanceof GenericNameNode) {
    throw new Error("declare currently supports only non-generic function declarations");
  }
  if (!(nameNode instanceof IdentifierNode)) {
    throw new Error("Declared function name must be an identifier");
  }

  const paramsNode: AstNode = node.elements[2];
  const toKeyword: AstNode = node.elements[3];
  const returnType: AstNode = parsePass4(node.elements[4]);

  if (!(toKeyword instanceof IdentifierNode) || toKeyword.name !== "to") {
    throw new Error("Expected 'to' keyword in declared function expression");
  }

  const params: TypeVarBindNode[] = parseParameterList(paramsNode);
  return new DeclaredDfunNode(nameNode, params, returnType);
}

function parseDeclareExpression(node: RoundParenListNode): DeclaredDfunNode {
  if (node.elements.length !== 2) {
    throw new Error("Invalid declare structure: expected (declare (function name ([...] ...) to returnType))");
  }

  const declarationNode = node.elements[1];
  if (!(declarationNode instanceof RoundParenListNode) || declarationNode.elements.length === 0) {
    throw new Error("Invalid declare structure: expected a single declaration form");
  }
  const keywordNode = declarationNode.elements[0];
  if (!(keywordNode instanceof IdentifierNode) || keywordNode.name !== "function") {
    throw new Error("Invalid declare structure: only function declarations are currently supported");
  }

  return parseDeclaredDfunExpression(declarationNode);
}

/**
 * 解析 (let (([var1 type1] exp1) ...) in bodyexp) 结构
 */
function parseLetExpression(node: RoundParenListNode): LetNode {
  if (node.elements.length !== 4) {
    throw new Error("Invalid let structure: expected (let (([var1 type1] exp1) ...) in bodyexp)");
  }

  const bindingsNode: AstNode = node.elements[1];
  const inKeyword: AstNode = node.elements[2];
  const body: AstNode = parsePass4(node.elements[3]);

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in let expression");
  }

  // 解析绑定列表
  const bindings: { bind: AstNode; value: AstNode }[] = parseBindingList(bindingsNode);

  return new LetNode(bindings, body);
}

/**
 * 解析 (if cond then exp else elseexp) 结构
 */
function parseIfExpression(node: RoundParenListNode): IfNode {
  if (node.elements.length !== 6) {
    throw new Error("Invalid if structure: expected (if cond then exp else elseexp)");
  }

  const condition: AstNode = parsePass4(node.elements[1]);
  const thenKeyword: AstNode = node.elements[2];
  const thenExpression: AstNode = parsePass4(node.elements[3]);
  const elseKeyword: AstNode = node.elements[4];
  const elseExpression: AstNode = parsePass4(node.elements[5]);

  if (!(thenKeyword instanceof IdentifierNode) || thenKeyword.name !== "then") {
    throw new Error("Expected 'then' keyword in if expression");
  }

  if (!(elseKeyword instanceof IdentifierNode) || elseKeyword.name !== "else") {
    throw new Error("Expected 'else' keyword in if expression");
  }

  return new IfNode(condition, thenExpression, elseExpression);
}

/**
 * 解析 (while condition in exp) 结构
 */
function parseWhileExpression(node: RoundParenListNode): WhileNode {
  if (node.elements.length !== 4) {
    throw new Error("Invalid while structure: expected (while condition in exp)");
  }

  const condition: AstNode = parsePass4(node.elements[1]);
  const inKeyword: AstNode = node.elements[2];
  const bodyExpression: AstNode = parsePass4(node.elements[3]);

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in while expression");
  }

  return new WhileNode(condition, bodyExpression);
}

/**
 * 解析 (cond (cond1 clauseexp1) ... (else elseexp)) 结构
 */
function parseCondExpression(node: RoundParenListNode): CondNode {
  if (node.elements.length < 2) {
    throw new Error("Invalid cond structure: expected at least one clause");
  }

  const clauses: { cond: AstNode; body: AstNode }[] = [];

  for (let i = 1; i < node.elements.length; i++) {
    const clauseNode: AstNode = node.elements[i];
    
    if (!(clauseNode instanceof RoundParenListNode) || clauseNode.elements.length !== 2) {
      throw new Error("Invalid cond clause: expected (condition expression)");
    }

    const condition: AstNode = parsePass4(clauseNode.elements[0]);
    const expression: AstNode = parsePass4(clauseNode.elements[1]);

    // 检查最后一个子句是否是 else 子句
    if (i === node.elements.length - 1 && condition instanceof IdentifierNode && condition.name === "else") {
      // 这是 else 子句，condition 实际上是 else 关键词，真正的表达式是 expression
      clauses.push({ cond: condition, body: expression });
    } else {
      clauses.push({ cond: condition, body: expression });
    }
  }

  return new CondNode(clauses);
}

/**
 * 解析类定义结构
 */
function parseClassExpression(node: RoundParenListNode): AstNode {
  if (node.elements.length < 2) {
    throw new Error("Invalid class structure: expected class name and body");
  }

  const nameNode: AstNode = parsePass4(node.elements[1]);
  
  // 检查是否是泛型类定义
  if (nameNode instanceof GenericNameNode) {
    const { constructors, methods, properties, memberNodeList } = parseClassBody(node.elements.slice(2));
    return new GenericClassNode(nameNode, constructors, methods, properties, memberNodeList);
  }

  if (!(nameNode instanceof IdentifierNode)) {
    throw new Error("Class name must be an identifier");
  }

  const { constructors, methods, properties, memberNodeList } = parseClassBody(node.elements.slice(2));
  return new ClassNode(nameNode, constructors, methods, properties, memberNodeList);
}

/**
 * 解析类体
 */
function parseClassBody(bodyElements: AstNode[]): {
  constructors: ClassConstructorNode[];
  methods: ClassMethodNode[];
  properties: ClassPropertyNode[];
  memberNodeList: ClassBodyMemberNode[];
} {
  const constructors: ClassConstructorNode[] = [];
  const methods: ClassMethodNode[] = [];
  const properties: ClassPropertyNode[] = [];
  const memberNodeList: ClassBodyMemberNode[] = [];

  for (const element of bodyElements) {
    if (element instanceof RoundParenListNode && element.elements.length > 0) {
      const memberNode = parseClassBodyMember(element);
      memberNodeList.push(memberNode);
      const innerMember = memberNode instanceof PublicNode ? memberNode.inner : memberNode;
      if (innerMember instanceof ClassPropertyNode) {
        properties.push(innerMember);
      } else if (innerMember instanceof ClassMethodNode) {
        methods.push(innerMember);
      } else if (innerMember instanceof ClassConstructorNode) {
        constructors.push(innerMember);
      }
    }
  }

  return { constructors, methods, properties, memberNodeList };
}

function parseClassBodyMember(node: RoundParenListNode): ClassBodyMemberNode {
  const firstElement: AstNode | undefined = node.elements[0];
  if (!(firstElement instanceof IdentifierNode)) {
    throw new Error("Unknown class member type");
  }

  switch (firstElement.name) {
    case "property":
      return parseClassProperty(node);
    case "method":
      return parseClassMethod(node);
    case "constructor":
      return parseClassConstructor(node);
    case "public":
      return parsePublicClassBodyMember(node);
    default:
      throw new Error(`Unknown class member type: ${firstElement.name}`);
  }
}

function parsePublicClassBodyMember(node: RoundParenListNode): PublicNode {
  if (node.elements.length !== 2) {
    throw new Error("public expects exactly one argument");
  }

  const innerElement = node.elements[1];
  if (!(innerElement instanceof RoundParenListNode) || innerElement.elements.length === 0) {
    throw new Error("public may only wrap class properties and methods");
  }

  const firstInnerElement = innerElement.elements[0];
  if (!(firstInnerElement instanceof IdentifierNode)) {
    throw new Error("public may only wrap class properties and methods");
  }

  switch (firstInnerElement.name) {
    case "property":
      return new PublicNode(parseClassProperty(innerElement));
    case "method":
      return new PublicNode(parseClassMethod(innerElement));
    case "constructor":
      throw new Error("constructors are always public and cannot be wrapped in public");
    case "public":
      throw new Error("public cannot wrap public");
    default:
      throw new Error("public may only wrap class properties and methods");
  }
}

/**
 * 解析类属性
 */
function parseClassProperty(node: RoundParenListNode): ClassPropertyNode {
  if (node.elements.length !== 2) {
    throw new Error("Invalid property structure: expected (property [name type])");
  }

  const bindNode: AstNode = parsePass4(node.elements[1]);
  
  if (!(bindNode instanceof TypeVarBindNode)) {
    throw new Error("Property must have a type binding");
  }

  return new ClassPropertyNode(bindNode);
}

/**
 * 解析类方法
 */
function parseClassMethod(node: RoundParenListNode): ClassMethodNode {
  if (node.elements.length !== 7) {
    throw new Error("Invalid method structure: expected (method name ([param1 type1] ...) to returnType in body)");
  }

  const methodName: AstNode = parsePass4(node.elements[1]);
  const paramsNode: AstNode = node.elements[2];
  const toKeyword: AstNode = node.elements[3];
  const returnType: AstNode = parsePass4(node.elements[4]);
  const inKeyword: AstNode = node.elements[5];
  const body: AstNode = parsePass4(node.elements[6]);

  if (!(methodName instanceof IdentifierNode)) {
    throw new Error("Method name must be an identifier");
  }

  if (!(toKeyword instanceof IdentifierNode) || toKeyword.name !== "to") {
    throw new Error("Expected 'to' keyword in method definition");
  }

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in method definition");
  }

  const params: TypeVarBindNode[] = parseParameterList(paramsNode);

  return new ClassMethodNode(methodName, params, returnType, body);
}

/**
 * 解析类构造器
 */
function parseClassConstructor(node: RoundParenListNode): ClassConstructorNode {
  if (node.elements.length !== 4) {
    throw new Error("Invalid constructor structure: expected (constructor ([param1 type1] ...) in body)");
  }

  const paramsNode: AstNode = node.elements[1];
  const inKeyword: AstNode = node.elements[2];
  const body: AstNode = parsePass4(node.elements[3]);

  if (!(inKeyword instanceof IdentifierNode) || inKeyword.name !== "in") {
    throw new Error("Expected 'in' keyword in constructor definition");
  }

  const params: TypeVarBindNode[] = parseParameterList(paramsNode);

  return new ClassConstructorNode(params, body);
}

/**
 * 解析参数列表
 */
function parseParameterList(paramsNode: AstNode): TypeVarBindNode[] {
  if (!(paramsNode instanceof RoundParenListNode)) {
    throw new Error("Parameter list must be enclosed in round parentheses");
  }

  const params: TypeVarBindNode[] = [];
  for (const param of paramsNode.elements) {
    const processedParam: AstNode = parsePass4(param);
    if (!(processedParam instanceof TypeVarBindNode)) {
      throw new Error("All parameters must be type-bound identifiers");
    }
    params.push(processedParam);
  }

  return params;
}

/**
 * 解析绑定列表 (用于 let 表达式)
 */
function parseBindingList(bindingsNode: AstNode): { bind: AstNode; value: AstNode }[] {
  if (!(bindingsNode instanceof RoundParenListNode)) {
    throw new Error("Binding list must be enclosed in round parentheses");
  }

  const bindings: { bind: AstNode; value: AstNode }[] = [];
  
  for (const binding of bindingsNode.elements) {
    if (!(binding instanceof RoundParenListNode) || binding.elements.length !== 2) {
      throw new Error("Invalid binding: expected ([var type] value)");
    }

    const bindExpression: AstNode = parsePass4(binding.elements[0]);
    const valueExpression: AstNode = parsePass4(binding.elements[1]);

    bindings.push({ bind: bindExpression, value: valueExpression });
  }

  return bindings;
}


function parseMatchExpression(node: RoundParenListNode): MatchNode {
  if (node.elements.length < 3) {
    throw new Error("Invalid match structure: expected (match expression (pattern1 body1) ...)");
  }

  const targetExpression: AstNode = parsePass4(node.elements[1]);
  const cases: { bind: TypeVarBindNode; body: AstNode }[] = [];

  for (let i = 2; i < node.elements.length; i++) {
    const caseNode: AstNode = node.elements[i];
    
    if (!(caseNode instanceof RoundParenListNode) || caseNode.elements.length !== 2) {
      throw new Error("Invalid match case: expected (pattern body)");
    }

    const pattern: AstNode = parsePass4(caseNode.elements[0]);
    const body: AstNode = parsePass4(caseNode.elements[1]);
    if(pattern instanceof TypeVarBindNode){
      cases.push({ bind: pattern, body });
    }
  }

  return new MatchNode(targetExpression, cases);
}
