import { AstNode, ClassNode, DeclaredDfunNode, DfunNode, GenericClassNode, GenericDfunNode } from "./AstNode";
import { collectClassInfoPass } from "./Typecheck-Pass-1-CollectSymbols";
import { collectGenericInstantiationsPass, genericClassInstanceTable, genericFunctionInstanceTable } from "./Typecheck-Pass-4-CollectInstantiations";
import { classTable, functionTable, genericClassTable, genericFunctionTable } from "./Typecheck-Definitions";
import { printTypeValue } from "./TypeSystem";

export function collectAllDefinitionsPass(astList: AstNode[]): void {
    astList.forEach((ast) => collectClassInfoPass(ast));
}

export function collectExecutableStmtsPass(astList: AstNode[]): AstNode[] {
    return astList.filter((ast) => !(
        ast instanceof ClassNode
        || ast instanceof GenericClassNode
        || ast instanceof DfunNode
        || ast instanceof DeclaredDfunNode
        || ast instanceof GenericDfunNode
    ));
}

export function collectGenericInstantiations(node: AstNode): void {
    collectGenericInstantiationsPass(node);
}

export { genericClassInstanceTable, genericFunctionInstanceTable };

export function printClassTable(): void {
    console.log("classTable:");
    for (const [name, info] of classTable.entries()) {
        console.log(`  Class: ${name}`);
        console.log(`    Constructors: ${info.constructors.length}`);
        console.log(`    Methods: ${info.methods.map((method) => method.methodName.name).join(", ")}`);
        console.log(`    Properties: ${info.properties.map((property) => property.bind.var.name).join(", ")}`);
    }
}

export function printGenericClassTable(): void {
    console.log("genericClassTable:");
    for (const [name, info] of genericClassTable.entries()) {
        console.log(`  GenericClass: ${name}<${info.typeParams.join(", ")}>`);
        console.log(`    Constructors: ${info.constructors.length}`);
        console.log(`    Methods: ${info.methods.map((method) => method.methodName.name).join(", ")}`);
        console.log(`    Properties: ${info.properties.map((property) => property.bind.var.name).join(", ")}`);
    }
}

export function printFunctionTable(): void {
    console.log("functionTable:");
    for (const [name, info] of functionTable.entries()) {
        console.log(`  Function: ${name}(${info.paramVars.join(", ")})`);
    }
}

export function printGenericFunctionTable(): void {
    console.log("genericFunctionTable:");
    for (const [name, info] of genericFunctionTable.entries()) {
        console.log(`  GenericFunction: ${name}<${info.typeParams.join(", ")}>`);
    }
}

export function printGenericClassInstanceTable(): void {
    console.log("genericClassInstanceTable:");
    for (const [key, value] of genericClassInstanceTable.entries()) {
        console.log(`  Instance: ${key}`);
        console.log(`    typeArgs: ${value.typeArgs.map(printTypeValue).join(", ")}`);
    }
}

export function printGenericFunctionInstanceTable(): void {
    console.log("genericFunctionInstanceTable:");
    for (const [key, value] of genericFunctionInstanceTable.entries()) {
        console.log(`  Instance: ${key}`);
        console.log(`    typeArgs: ${value.typeArgs.map(printTypeValue).join(", ")}`);
    }
}