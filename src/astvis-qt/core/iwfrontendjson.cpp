// Qt AST viewer core: shared token/AST JSON serializers for TS/C++ frontend parity.
#include "iwfrontendjson.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

namespace iw {
namespace {

QJsonArray serializeAstNodeList(const AstNodeList &nodes);

QJsonObject serializeToken(const Token &token) {
    switch (token.kind()) {
    case TokenType::LParen:
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("LParenToken")}, {QStringLiteral("bracketKind"), bracketKindToText(token.bracketKind())}};
    case TokenType::RParen:
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("RParenToken")}, {QStringLiteral("bracketKind"), bracketKindToText(token.bracketKind())}};
    case TokenType::Number:
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("NumberToken")},
            {QStringLiteral("typeName"), token.typeName()},
            {QStringLiteral("raw"), token.raw()}
        };
    case TokenType::Identifier:
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("IdentifierToken")}, {QStringLiteral("name"), token.identifierName()}};
    }

    return QJsonObject();
}

QJsonArray serializeIdentifierList(const std::vector<IdentifierNodePtr> &nodes) {
    QJsonArray result;
    for (const IdentifierNodePtr &node : nodes) {
        result.append(QJsonObject{{QStringLiteral("kind"), QStringLiteral("IdentifierNode")}, {QStringLiteral("name"), node->name()}});
    }
    return result;
}

QJsonValue serializeAstNode(const AstNodePtr &node) {
    if (const IdentifierNodePtr identifierNode = std::dynamic_pointer_cast<IdentifierNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("IdentifierNode")}, {QStringLiteral("name"), identifierNode->name()}};
    }
    if (const std::shared_ptr<TextDatabaseReferenceNode> textNode = std::dynamic_pointer_cast<TextDatabaseReferenceNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("TextDatabaseReferenceNode")},
            {QStringLiteral("typeName"), textNode->typeName()},
            {QStringLiteral("entryName"), textNode->entryName()},
            {QStringLiteral("referenceName"), textNode->referenceName()},
            {QStringLiteral("content"), QJsonValue()}
        };
    }
    if (const std::shared_ptr<NumberLiteralNode> numberNode = std::dynamic_pointer_cast<NumberLiteralNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("NumberLiteralNode")},
            {QStringLiteral("typeName"), numberNode->typeName()},
            {QStringLiteral("raw"), numberNode->raw()}
        };
    }
    if (const std::shared_ptr<ListNode> listNode = std::dynamic_pointer_cast<ListNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("ListNode")}, {QStringLiteral("elements"), serializeAstNodeList(listNode->elements())}};
    }
    if (const std::shared_ptr<RoundParenListNode> listNode = std::dynamic_pointer_cast<RoundParenListNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("RoundParenListNode")}, {QStringLiteral("elements"), serializeAstNodeList(listNode->elements())}};
    }
    if (const std::shared_ptr<SquareParenListNode> listNode = std::dynamic_pointer_cast<SquareParenListNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("SquareParenListNode")}, {QStringLiteral("elements"), serializeAstNodeList(listNode->elements())}};
    }
    if (const std::shared_ptr<CurlyParenListNode> listNode = std::dynamic_pointer_cast<CurlyParenListNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("CurlyParenListNode")}, {QStringLiteral("elements"), serializeAstNodeList(listNode->elements())}};
    }
    if (const std::shared_ptr<AngleParenListNode> listNode = std::dynamic_pointer_cast<AngleParenListNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("AngleParenListNode")}, {QStringLiteral("elements"), serializeAstNodeList(listNode->elements())}};
    }
    if (const std::shared_ptr<FnNode> fnNode = std::dynamic_pointer_cast<FnNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : fnNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("FnNode")},
            {QStringLiteral("params"), params},
            {QStringLiteral("returnType"), serializeAstNode(fnNode->returnType())},
            {QStringLiteral("body"), serializeAstNode(fnNode->body())}
        };
    }
    if (const std::shared_ptr<LetNode> letNode = std::dynamic_pointer_cast<LetNode>(node)) {
        QJsonArray bindings;
        for (const LetBinding &binding : letNode->bindings()) {
            bindings.append(QJsonObject{
                {QStringLiteral("bind"), serializeAstNode(binding.bind)},
                {QStringLiteral("value"), serializeAstNode(binding.value)}
            });
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("LetNode")},
            {QStringLiteral("bindings"), bindings},
            {QStringLiteral("body"), serializeAstNode(letNode->body())}
        };
    }
    if (const std::shared_ptr<IfNode> ifNode = std::dynamic_pointer_cast<IfNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("IfNode")},
            {QStringLiteral("condExpr"), serializeAstNode(ifNode->condExpr())},
            {QStringLiteral("trueBranchExpr"), serializeAstNode(ifNode->trueBranchExpr())},
            {QStringLiteral("falseBranchExpr"), serializeAstNode(ifNode->falseBranchExpr())}
        };
    }
    if (const std::shared_ptr<WhileNode> whileNode = std::dynamic_pointer_cast<WhileNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("WhileNode")},
            {QStringLiteral("condExpr"), serializeAstNode(whileNode->condExpr())},
            {QStringLiteral("bodyExpr"), serializeAstNode(whileNode->bodyExpr())}
        };
    }
    if (const std::shared_ptr<CondNode> condNode = std::dynamic_pointer_cast<CondNode>(node)) {
        QJsonArray clauses;
        for (const CondClause &clause : condNode->clauses()) {
            clauses.append(QJsonObject{
                {QStringLiteral("cond"), serializeAstNode(clause.cond)},
                {QStringLiteral("body"), serializeAstNode(clause.body)}
            });
        }
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("CondNode")}, {QStringLiteral("clausesExprs"), clauses}};
    }
    if (const TypeVarBindNodePtr typeVarBindNode = std::dynamic_pointer_cast<TypeVarBindNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("TypeVarBindNode")},
            {QStringLiteral("var"), serializeAstNode(typeVarBindNode->identifier())},
            {QStringLiteral("typeExp"), serializeAstNode(typeVarBindNode->typeExpression())}
        };
    }
    if (const std::shared_ptr<TypeToFromNode> typeToFromNode = std::dynamic_pointer_cast<TypeToFromNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("TypeToFromNode")},
            {QStringLiteral("returnType"), serializeAstNode(typeToFromNode->returnType())},
            {QStringLiteral("paramTypes"), serializeAstNodeList(typeToFromNode->paramTypes())}
        };
    }
    if (const std::shared_ptr<TypeUnionNode> typeUnionNode = std::dynamic_pointer_cast<TypeUnionNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("TypeUnionNode")}, {QStringLiteral("types"), serializeAstNodeList(typeUnionNode->types())}};
    }
    if (const std::shared_ptr<ProgramNode> programNode = std::dynamic_pointer_cast<ProgramNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("ProgramNode")},
            {QStringLiteral("unitId"), programNode->unitId() ? serializeAstNode(programNode->unitId()) : QJsonValue()},
            {QStringLiteral("topLevelExpressions"), serializeAstNodeList(programNode->topLevelExpressions())}
        };
    }
    if (const std::shared_ptr<ImportNode> importNode = std::dynamic_pointer_cast<ImportNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("ImportNode")}, {QStringLiteral("packagePath"), serializeAstNode(importNode->packagePath())}};
    }
    if (const std::shared_ptr<DvarNode> dvarNode = std::dynamic_pointer_cast<DvarNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("DvarNode")},
            {QStringLiteral("bind"), serializeAstNode(dvarNode->bind())},
            {QStringLiteral("value"), serializeAstNode(dvarNode->value())}
        };
    }
    if (const std::shared_ptr<DfunNode> dfunNode = std::dynamic_pointer_cast<DfunNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : dfunNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("DfunNode")},
            {QStringLiteral("name"), serializeAstNode(dfunNode->name())},
            {QStringLiteral("params"), params},
            {QStringLiteral("returnType"), serializeAstNode(dfunNode->returnType())},
            {QStringLiteral("body"), serializeAstNode(dfunNode->body())}
        };
    }
    if (const std::shared_ptr<DeclaredDfunNode> declaredDfunNode = std::dynamic_pointer_cast<DeclaredDfunNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : declaredDfunNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("DeclaredDfunNode")},
            {QStringLiteral("name"), serializeAstNode(declaredDfunNode->name())},
            {QStringLiteral("params"), params},
            {QStringLiteral("returnType"), serializeAstNode(declaredDfunNode->returnType())}
        };
    }
    if (const std::shared_ptr<SetNode> setNode = std::dynamic_pointer_cast<SetNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("SetNode")},
            {QStringLiteral("identifier"), serializeAstNode(setNode->identifier())},
            {QStringLiteral("value"), serializeAstNode(setNode->value())}
        };
    }
    if (const std::shared_ptr<SeqNode> seqNode = std::dynamic_pointer_cast<SeqNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("SeqNode")}, {QStringLiteral("expressions"), serializeAstNodeList(seqNode->expressions())}};
    }
    if (const std::shared_ptr<ClassNode> classNode = std::dynamic_pointer_cast<ClassNode>(node)) {
        QJsonArray constructors;
        QJsonArray methods;
        QJsonArray properties;
        for (const ClassConstructorNodePtr &constructorNode : classNode->constructorNodeList()) {
            constructors.append(serializeAstNode(constructorNode));
        }
        for (const ClassMethodNodePtr &methodNode : classNode->methodNodeList()) {
            methods.append(serializeAstNode(methodNode));
        }
        for (const ClassPropertyNodePtr &propertyNode : classNode->propertyNodeList()) {
            properties.append(serializeAstNode(propertyNode));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("ClassNode")},
            {QStringLiteral("name"), serializeAstNode(classNode->name())},
            {QStringLiteral("constructorNodeList"), constructors},
            {QStringLiteral("methodNodeList"), methods},
            {QStringLiteral("propertyNodeList"), properties}
        };
    }
    if (const ClassPropertyNodePtr classPropertyNode = std::dynamic_pointer_cast<ClassPropertyNode>(node)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("ClassPropertyNode")}, {QStringLiteral("bind"), serializeAstNode(classPropertyNode->bind())}};
    }
    if (const ClassMethodNodePtr classMethodNode = std::dynamic_pointer_cast<ClassMethodNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : classMethodNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("ClassMethodNode")},
            {QStringLiteral("methodName"), serializeAstNode(classMethodNode->methodName())},
            {QStringLiteral("params"), params},
            {QStringLiteral("returnType"), serializeAstNode(classMethodNode->returnType())},
            {QStringLiteral("body"), serializeAstNode(classMethodNode->body())}
        };
    }
    if (const ClassConstructorNodePtr classConstructorNode = std::dynamic_pointer_cast<ClassConstructorNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : classConstructorNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("ClassConstructorNode")},
            {QStringLiteral("params"), params},
            {QStringLiteral("body"), serializeAstNode(classConstructorNode->body())}
        };
    }
    if (const GenericNameNodePtr genericNameNode = std::dynamic_pointer_cast<GenericNameNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("GenericNameNode")},
            {QStringLiteral("name"), serializeAstNode(genericNameNode->name())},
            {QStringLiteral("genericTypeArgs"), serializeIdentifierList(genericNameNode->genericTypeArgs())}
        };
    }
    if (const std::shared_ptr<GenericClassNode> genericClassNode = std::dynamic_pointer_cast<GenericClassNode>(node)) {
        QJsonArray constructors;
        QJsonArray methods;
        QJsonArray properties;
        for (const ClassConstructorNodePtr &constructorNode : genericClassNode->constructorNodeList()) {
            constructors.append(serializeAstNode(constructorNode));
        }
        for (const ClassMethodNodePtr &methodNode : genericClassNode->methodNodeList()) {
            methods.append(serializeAstNode(methodNode));
        }
        for (const ClassPropertyNodePtr &propertyNode : genericClassNode->propertyNodeList()) {
            properties.append(serializeAstNode(propertyNode));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("GenericClassNode")},
            {QStringLiteral("genericName"), serializeAstNode(genericClassNode->genericName())},
            {QStringLiteral("constructorNodeList"), constructors},
            {QStringLiteral("methodNodeList"), methods},
            {QStringLiteral("propertyNodeList"), properties}
        };
    }
    if (const std::shared_ptr<GenericDfunNode> genericDfunNode = std::dynamic_pointer_cast<GenericDfunNode>(node)) {
        QJsonArray params;
        for (const TypeVarBindNodePtr &param : genericDfunNode->params()) {
            params.append(serializeAstNode(param));
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("GenericDfunNode")},
            {QStringLiteral("genericName"), serializeAstNode(genericDfunNode->genericName())},
            {QStringLiteral("params"), params},
            {QStringLiteral("returnType"), serializeAstNode(genericDfunNode->returnType())},
            {QStringLiteral("body"), serializeAstNode(genericDfunNode->body())}
        };
    }
    if (const std::shared_ptr<FunctionCallNode> functionCallNode = std::dynamic_pointer_cast<FunctionCallNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("FunctionCallNode")},
            {QStringLiteral("callee"), serializeAstNode(functionCallNode->callee())},
            {QStringLiteral("args"), serializeAstNodeList(functionCallNode->args())}
        };
    }
    if (const std::shared_ptr<GenericCallNode> genericCallNode = std::dynamic_pointer_cast<GenericCallNode>(node)) {
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("GenericCallNode")},
            {QStringLiteral("callee"), serializeAstNode(genericCallNode->callee())},
            {QStringLiteral("typeArgs"), serializeAstNodeList(genericCallNode->typeArgs())}
        };
    }
    if (const std::shared_ptr<MatchNode> matchNode = std::dynamic_pointer_cast<MatchNode>(node)) {
        QJsonArray branches;
        for (const MatchBranch &branch : matchNode->branches()) {
            branches.append(QJsonObject{
                {QStringLiteral("bind"), serializeAstNode(branch.bind)},
                {QStringLiteral("body"), serializeAstNode(branch.body)}
            });
        }
        return QJsonObject{
            {QStringLiteral("kind"), QStringLiteral("MatchNode")},
            {QStringLiteral("unionExpr"), serializeAstNode(matchNode->unionExpr())},
            {QStringLiteral("branches"), branches}
        };
    }

    return QJsonObject();
}

QJsonArray serializeAstNodeList(const AstNodeList &nodes) {
    QJsonArray result;
    for (const AstNodePtr &node : nodes) {
        result.append(serializeAstNode(node));
    }
    return result;
}

QString dumpJsonValue(const QJsonValue &value) {
    return QString::fromUtf8(QJsonDocument(value.toObject()).toJson(QJsonDocument::Indented));
}

}

QString dumpTokensToJsonText(const TokenList &tokens) {
    QJsonArray serializedTokens;
    for (const Token &token : tokens) {
        serializedTokens.append(serializeToken(token));
    }
    return QString::fromUtf8(QJsonDocument(serializedTokens).toJson(QJsonDocument::Indented));
}

QString dumpAstToJsonText(const AstNodePtr &node) {
    return dumpJsonValue(serializeAstNode(node));
}

QString dumpFrontendBundleToJsonText(const TokenList &tokens, const AstNodePtr &ast) {
    QJsonArray serializedTokens;
    for (const Token &token : tokens) {
        serializedTokens.append(serializeToken(token));
    }

    const QJsonObject bundle = {
        {QStringLiteral("tokens"), serializedTokens},
        {QStringLiteral("ast"), serializeAstNode(ast)}
    };
    return QString::fromUtf8(QJsonDocument(bundle).toJson(QJsonDocument::Indented));
}

}