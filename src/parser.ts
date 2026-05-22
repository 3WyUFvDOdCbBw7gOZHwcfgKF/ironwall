
import { AbstractToken } from "./lexer";
import { copyAstSourceTree, getActiveParserNode, wrapErrorAsDiagnostic } from "./Diagnostics";
import { dumpAstToJsonText, restoreAstFromJsonText } from "./FrontendJson";
import {
    AstNode,
    AstNodeType,
    IdentifierNode,
    NumberLiteralNode,
  TextDatabaseReferenceNode,
    RoundParenListNode,
    SquareParenListNode,
    CurlyParenListNode,
    AngleParenListNode,
    FnNode,
    LetNode,
    IfNode,
    WhileNode,
    TypeVarBindNode,
    TypeToFromNode,
    TypeUnionNode,
    ProgramNode,
    ImportNode,
    ExportNode,
    PublicNode,
    DvarNode,
    SeqNode,
    DfunNode,
    DeclaredDfunNode,
    ListNode,
    SetNode,
    CondNode,
    //ClassNode,
    //ClassPropertyNode,
    //ClassMethodNode,
    //ClassConstructorNode,
    //GenericNameNode,
    //GenericClassNode,
    //GenericDfunNode,
  } from "./AstNode";
import { parsePass1 } from "./Parser-Pass-1";
import { parsePass4 } from "./Parser-Pass-2";
import { parsePass5, parsePass6 } from "./Parser-Pass-3";

// 统一 parse 流程，依次调用各 pass，返回最终 AST
export function parse(tokens: AbstractToken[]): AstNode {
    let pass1: AstNode;
    try {
      pass1 = parsePass1(tokens);
    }
    catch (error) {
      throw wrapErrorAsDiagnostic(error, "parser-pass-1", "PARSE_PASS_1_ERROR");
    }
    let pass4: AstNode;
    try {
      pass4 = parsePass4(pass1);
    }
    catch (error) {
      throw wrapErrorAsDiagnostic(error, "parser-pass-4", "PARSE_PASS_4_ERROR", {
        ast: getActiveParserNode(),
      });
    }
    let pass5: AstNode;
    try {
      pass5 = parsePass5(pass4);
    }
    catch (error) {
      throw wrapErrorAsDiagnostic(error, "parser-pass-5", "PARSE_PASS_5_ERROR", {
        ast: getActiveParserNode(),
      });
    }
    let pass6: AstNode;
    try {
      pass6 = parsePass6(pass5);
    }
    catch (error) {
      throw wrapErrorAsDiagnostic(error, "parser-pass-6", "PARSE_PASS_6_ERROR", {
        ast: getActiveParserNode(),
      });
    }

    try {
      const jsonText: string = dumpAstToJsonText(pass6);
      const restoredAst = restoreAstFromJsonText(jsonText);
      copyAstSourceTree(pass6, restoredAst);
      return restoredAst;
    }
    catch (error) {
      throw wrapErrorAsDiagnostic(error, "parser-json-roundtrip", "PARSE_JSON_ROUNDTRIP_ERROR", {
        ast: pass6,
      });
    }
}


// pretty print ast
export function prettyPrintAst(node: AstNode, indent = ""): string {
  if (!node || typeof node !== "object" || node.kind === undefined) {
    return indent + "<InvalidNode>";
  }
  switch (node.kind) {
    case AstNodeType.IdentifierNode:
      return `${indent}Identifier(${(node as IdentifierNode).name})`;
    case AstNodeType.TextDatabaseReferenceNode:
      return `${indent}TextDatabaseReference(${(node as TextDatabaseReferenceNode).referenceName})`;
    case AstNodeType.NumberLiteralNode:
      return `${indent}Number(${(node as NumberLiteralNode).raw})`;
    case AstNodeType.RoundParenListNode:
      return `${indent}ParenList [\n${(node as RoundParenListNode).elements.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    case AstNodeType.ListNode:
      return `${indent}GenericList [\n${(node as ListNode).elements.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    case AstNodeType.SquareParenListNode:
      return `${indent}SquareBracketList [\n${(node as SquareParenListNode).elements.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    case AstNodeType.CurlyParenListNode:
      return `${indent}CurlyBraceList [\n${(node as CurlyParenListNode).elements.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    case AstNodeType.AngleParenListNode:
      return `${indent}AngleBracketList [\n${(node as AngleParenListNode).elements.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    case AstNodeType.FnNode: {
      const fn = node as FnNode;
      return `${indent}FnNode\n${indent}  params:[\n${fn.params.map((p) => prettyPrintAst(p, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  returnType: ${prettyPrintAst(fn.returnType, indent + "    ")}` +
        `\n${indent}  body: ${prettyPrintAst(fn.body, indent + "    ")}`;
    }
    case AstNodeType.DfunNode: {
      const dfun = node as DfunNode;
      return `${indent}DfunNode\n${indent}  name: ${prettyPrintAst(dfun.name, indent + "    ")}` +
        `\n${indent}  params:[\n${dfun.params.map((p) => prettyPrintAst(p, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  returnType: ${prettyPrintAst(dfun.returnType, indent + "    ")}` +
        `\n${indent}  body: ${prettyPrintAst(dfun.body, indent + "    ")}`;
    }
    case AstNodeType.DeclaredDfunNode: {
      const declared = node as DeclaredDfunNode;
      return `${indent}DeclaredDfunNode\n${indent}  name: ${prettyPrintAst(declared.name, indent + "    ")}` +
        `\n${indent}  params:[\n${declared.params.map((p) => prettyPrintAst(p, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  returnType: ${prettyPrintAst(declared.returnType, indent + "    ")}`;
    }
    case AstNodeType.LetNode: {
      const letNode = node as LetNode;
      return `${indent}LetNode\n${indent}  bindings:[\n${letNode.bindings.map((b) => `${indent}    bind: ${prettyPrintAst(b.bind, indent + "      ")}\n${indent}    value: ${prettyPrintAst(b.value, indent + "      ")}`).join("\n")}` +
        `\n${indent}  ]\n${indent}  body: ${prettyPrintAst(letNode.body, indent + "    ")}`;
    }
    case AstNodeType.DvarNode: {
      const dvar = node as DvarNode;
      return `${indent}DvarNode\n${indent}  bind: ${prettyPrintAst(dvar.bind, indent + "    ")}\n${indent}  value: ${prettyPrintAst(dvar.value, indent + "    ")}`;
    }
    case AstNodeType.SeqNode: {
      const seq = node as SeqNode;
      return `${indent}SeqNode [\n${seq.expressions.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    }
    case AstNodeType.TypeVarBindNode: {
      const bind = node as TypeVarBindNode;
      return `${indent}BindNode\n${indent}  var: ${prettyPrintAst(bind.var, indent + "    ")}\n${indent}  type: ${prettyPrintAst(bind.typeExp, indent + "    ")}`;
    }
    case AstNodeType.TypeToFromNode: {
      const ttf = node as TypeToFromNode;
      return `${indent}TypeToFromNode\n${indent}  returnType: ${prettyPrintAst(ttf.returnType, indent + "    ")}\n${indent}  paramTypes:[\n${ttf.paramTypes.map((p) => prettyPrintAst(p, indent + "    ")).join("\n")}` + `\n${indent}  ]`;
    }
    case AstNodeType.TypeUnionNode: {
      const ut = node as TypeUnionNode;
      return `${indent}UnionTypeNode [\n${ut.types.map((t) => prettyPrintAst(t, indent + "  ")).join("\n")}` + `\n${indent}]`;
    }
    case AstNodeType.IfNode: {
      const ifNode = node as IfNode;
      return `${indent}IfNode\n${indent}  cond: ${prettyPrintAst(ifNode.condExpr, indent + "    ")}\n${indent}  trueBranch: ${prettyPrintAst(ifNode.trueBranchExpr, indent + "    ")}\n${indent}  falseBranch: ${prettyPrintAst(ifNode.falseBranchExpr, indent + "    ")}`;
    }
    case AstNodeType.WhileNode: {
      const whileNode = node as WhileNode;
      return `${indent}WhileNode\n${indent}  cond: ${prettyPrintAst(whileNode.condExpr, indent + "    ")}\n${indent}  body: ${prettyPrintAst(whileNode.bodyExpr, indent + "    ")}`;
    }
    case AstNodeType.CondNode: {
      const cond = node as CondNode;
      return `${indent}CondNode\n${indent}  clauses:[\n${cond.clausesExprs.map((cl, i) => `${indent}    clause${i}:\n${indent}      cond: ${prettyPrintAst(cl.cond, indent + "        ")}\n${indent}      body: ${prettyPrintAst(cl.body, indent + "        ")}`).join("\n")}` + `\n${indent}  ]`;
    }
    case AstNodeType.ProgramNode: {
      const program = node as ProgramNode;
      return `${indent}ProgramNode${program.unitId ? `(${program.unitId.name})` : ""} [\n${program.topLevelExpressions.map((e) => prettyPrintAst(e, indent + "  ")).join("\n")}` + `\n${indent}]`;
    }
    case AstNodeType.ImportNode: {
      const importNode = node as ImportNode;
      return `${indent}ImportNode\n${indent}  package: ${prettyPrintAst(importNode.packagePath, indent + "    ")}`;
    }
    case AstNodeType.ExportNode: {
      const exportNode = node as ExportNode;
      return `${indent}ExportNode\n${indent}  inner: ${prettyPrintAst(exportNode.inner, indent + "    ")}`;
    }
    case AstNodeType.SetNode: {
      const set = node as SetNode;
      return `${indent}SetNode\n${indent}  identifier: ${prettyPrintAst(set.identifier, indent + "    ")}\n${indent}  value: ${prettyPrintAst(set.value, indent + "    ")}`;
    }
    case AstNodeType.ClassNode: {
      const cls = node as any;
      return `${indent}ClassNode\n${indent}  name: ${prettyPrintAst(cls.name, indent + "    ")}\n${indent}  constructors:[\n${cls.constructorNodeList.map((c: any) => prettyPrintAst(c, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  methods:[\n${cls.methodNodeList.map((m: any) => prettyPrintAst(m, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  properties:[\n${cls.propertyNodeList.map((p: any) => prettyPrintAst(p, indent + "    ")).join("\n")}` +
        `\n${indent}  ]`;
    }
    case AstNodeType.ClassPropertyNode: {
      const prop = node as any;
      return `${indent}ClassPropertyNode\n${indent}  bind: ${prettyPrintAst(prop.bind, indent + "    ")}`;
    }
    case AstNodeType.ClassMethodNode: {
      const m = node as any;
      return `${indent}ClassMethodNode\n${indent}  methodName: ${prettyPrintAst(m.methodName, indent + "    ")}\n${indent}  params:[\n${m.params.map((p: any) => prettyPrintAst(p, indent + "      ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  returnType: ${prettyPrintAst(m.returnType, indent + "    ")}\n${indent}  body: ${prettyPrintAst(m.body, indent + "    ")}`;
    }
    case AstNodeType.ClassConstructorNode: {
      const c = node as any;
      return `${indent}ClassConstructorNode\n${indent}  params:[\n${c.params.map((p: any) => prettyPrintAst(p, indent + "      ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  body: ${prettyPrintAst(c.body, indent + "    ")}`;
    }
    case AstNodeType.GenericNameNode: {
      const g = node as any;
      return `${indent}GenericNameNode\n${indent}  name: ${prettyPrintAst(g.name, indent + "    ")}\n${indent}  genericTypeArgs:[\n${g.genericTypeArgs.map((a: any) => prettyPrintAst(a, indent + "      ")).join("\n")}` +
        `\n${indent}  ]`;
    }
    case AstNodeType.GenericClassNode: {
      const g = node as any;
      return `${indent}GenericClassNode\n${indent}  genericName: ${prettyPrintAst(g.genericName, indent + "    ")}\n${indent}  constructors:[\n${g.constructorNodeList.map((c: any) => prettyPrintAst(c, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  methods:[\n${g.methodNodeList.map((m: any) => prettyPrintAst(m, indent + "    ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  properties:[\n${g.propertyNodeList.map((p: any) => prettyPrintAst(p, indent + "    ")).join("\n")}` +
        `\n${indent}  ]`;
    }
    case AstNodeType.GenericDfunNode: {
      const g = node as any;
      return `${indent}GenericDfunNode\n${indent}  genericName: ${prettyPrintAst(g.genericName, indent + "    ")}\n${indent}  params:[\n${g.params.map((p: any) => prettyPrintAst(p, indent + "      ")).join("\n")}` +
        `\n${indent}  ]\n${indent}  returnType: ${prettyPrintAst(g.returnType, indent + "    ")}\n${indent}  body: ${prettyPrintAst(g.body, indent + "    ")}`;
    }
    case AstNodeType.FunctionCallNode: {
      const call = node as any;
      return `${indent}FunctionCallNode\n${indent}  callee: ${prettyPrintAst(call.callee, indent + "    ")}\n${indent}  args:[\n${call.args.map((a: any) => prettyPrintAst(a, indent + "    ")).join("\n")}` + `\n${indent}  ]`;
    }
    case AstNodeType.GenericCallNode: {
      const gcall = node as any;
      return `${indent}GenericCallNode\n${indent}  callee: ${prettyPrintAst(gcall.callee, indent + "    ")}\n${indent}  typeArgs:[\n${gcall.typeArgs.map((a: any) => prettyPrintAst(a, indent + "    ")).join("\n")}` + `\n${indent}  ]`;
    }
    case AstNodeType.MatchNode: {
      const match = node as any;
      return `${indent}MatchNode\n${indent}  unionExpr: ${prettyPrintAst(match.unionExpr, indent + "    ")}\n${indent}  branches:[\n${match.branches.map((b: any, i: number) => `${indent}    branch${i}:\n${indent}      bind: ${prettyPrintAst(b.bind, indent + "        ")}\n${indent}      body: ${prettyPrintAst(b.body, indent + "        ")}`).join("\n")}` + `\n${indent}  ]`;
    }
    default:
      return `${indent}${AstNodeType[node.kind]}`;
  }
}

export function astToString(node: AstNode): string {
  switch (node.kind) {
    case AstNodeType.IdentifierNode:
      return (node as IdentifierNode).name;
    case AstNodeType.TextDatabaseReferenceNode:
      return (node as TextDatabaseReferenceNode).referenceName;
    case AstNodeType.NumberLiteralNode:
      return (node as NumberLiteralNode).raw;
    case AstNodeType.ListNode:
      return `(${(node as ListNode).elements.map(astToString).join(" ")})`;
    case AstNodeType.RoundParenListNode:
      return `(${(node as RoundParenListNode).elements.map(astToString).join(" ")})`;
    case AstNodeType.SquareParenListNode:
      return `[${(node as SquareParenListNode).elements.map(astToString).join(" ")}]`;
    case AstNodeType.CurlyParenListNode:
      return `{${(node as CurlyParenListNode).elements.map(astToString).join(" ")}}`;
    case AstNodeType.AngleParenListNode:
      return `<${(node as AngleParenListNode).elements.map(astToString).join(" ")}>`;
    case AstNodeType.FnNode: {
      const fn = node as FnNode;
      return `(fn (${fn.params.map(astToString).join(" ")}) to ${astToString(fn.returnType)} in ${astToString(fn.body)})`;
    }
    case AstNodeType.DfunNode: {
      const dfun = node as DfunNode;
      return `(function ${astToString(dfun.name)} (${dfun.params.map(astToString).join(" ")}) to ${astToString(dfun.returnType)} in ${astToString(dfun.body)})`;
    }
    case AstNodeType.DeclaredDfunNode: {
      const declared = node as DeclaredDfunNode;
      return `(declare (function ${astToString(declared.name)} (${declared.params.map(astToString).join(" ")}) to ${astToString(declared.returnType)}))`;
    }
    case AstNodeType.LetNode: {
      const letNode = node as LetNode;
      return `(let (${letNode.bindings.map((b) => `(${astToString(b.bind)} ${astToString(b.value)})`).join(" ")}) in ${astToString(letNode.body)})`;
    }
    case AstNodeType.DvarNode: {
      const dvar = node as DvarNode;
      return `(var ${astToString(dvar.bind)} ${astToString(dvar.value)})`;
    }
    case AstNodeType.SeqNode: {
      const seq = node as SeqNode;
      return `{${seq.expressions.map(astToString).join(" ")}}`;
    }
    case AstNodeType.TypeVarBindNode: {
      const bind = node as TypeVarBindNode;
      return `[${astToString(bind.var)} ${astToString(bind.typeExp)}]`;
    }
    case AstNodeType.TypeToFromNode: {
      const ttf = node as TypeToFromNode;
      return `<to ${astToString(ttf.returnType)} from ${ttf.paramTypes.map(astToString).join(" ")}>`;
    }
    case AstNodeType.TypeUnionNode: {
      const ut = node as TypeUnionNode;
      return `<union ${ut.types.map(astToString).join(" ")}>`;
    }
    case AstNodeType.IfNode: {
      const ifNode = node as IfNode;
      return `(if ${astToString(ifNode.condExpr)} then ${astToString(ifNode.trueBranchExpr)} else ${astToString(ifNode.falseBranchExpr)})`;
    }
    case AstNodeType.WhileNode: {
      const whileNode = node as WhileNode;
      return `(while ${astToString(whileNode.condExpr)} in ${astToString(whileNode.bodyExpr)})`;
    }
    case AstNodeType.CondNode: {
      const cond = node as CondNode;
      return `(cond ${cond.clausesExprs.map((cl) => `(${astToString(cl.cond)} ${astToString(cl.body)})`).join(" ")})`;
    }
    case AstNodeType.ProgramNode: {
      const program = node as ProgramNode;
      const pieces = ["program"];
      if (program.unitId !== null) {
        pieces.push(astToString(program.unitId));
      }
      if (program.topLevelExpressions.length > 0) {
        pieces.push(...program.topLevelExpressions.map(astToString));
      }
      return `{${pieces.join(' ')}}`;
    }
    case AstNodeType.ImportNode: {
      const importNode = node as ImportNode;
      return `(import ${astToString(importNode.packagePath)})`;
    }
    case AstNodeType.ExportNode:
      return `(export ${astToString((node as ExportNode).inner)})`;
    case AstNodeType.PublicNode:
      return `(public ${astToString((node as PublicNode).inner)})`;
    case AstNodeType.SetNode: {
      const set = node as SetNode;
      return `(var_set ${astToString(set.identifier)} ${astToString(set.value)})`;
    }
    case AstNodeType.ClassNode: {
      const cls = node as any;
      return `(class ${astToString(cls.name)}${cls.memberNodeList.map((member: any) => ` ${astToString(member)}`).join("")})`;
    }
    case AstNodeType.ClassPropertyNode: {
      const prop = node as any;
      return `(property ${astToString(prop.bind)})`;
    }
    case AstNodeType.ClassMethodNode: {
      const m = node as any;
      return `(method ${astToString(m.methodName)} (${m.params.map((p: any) => astToString(p)).join(" ")}) to ${astToString(m.returnType)} in ${astToString(m.body)})`;
    }
    case AstNodeType.ClassConstructorNode: {
      const c = node as any;
      return `(constructor (${c.params.map((p: any) => astToString(p)).join(" ")}) in ${astToString(c.body)})`;
    }
    case AstNodeType.GenericNameNode: {
      const g = node as any;
      return `<generic ${astToString(g.name)}${g.genericTypeArgs.map((a: any) => ` ${astToString(a)}`).join("")}>`;
    }
    case AstNodeType.GenericClassNode: {
      const g = node as any;
      return `(class ${astToString(g.genericName)}${g.memberNodeList.map((member: any) => ` ${astToString(member)}`).join("")})`;
    }
    case AstNodeType.GenericDfunNode: {
      const g = node as any;
      return `(function ${astToString(g.genericName)} (${g.params.map((p: any) => astToString(p)).join(" ")}) to ${astToString(g.returnType)} in ${astToString(g.body)})`;
    }
    case AstNodeType.FunctionCallNode: {
      const call = node as any;
      return `(${astToString(call.callee)}${call.args.length > 0 ? ' ' + call.args.map(astToString).join(' ') : ''})`;
    }
    case AstNodeType.GenericCallNode: {
      const gcall = node as any;
      return `<${astToString(gcall.callee)} ${gcall.typeArgs.map(astToString).join(' ')}>`;
    }
    case AstNodeType.MatchNode: {
      const match = node as any;
      return `(match ${astToString(match.unionExpr)}${match.branches.map((b: any) => ` (${astToString(b.bind)} ${astToString(b.body)})`).join('')})`;
    }
    default:
      return AstNodeType[node.kind];
  }
}