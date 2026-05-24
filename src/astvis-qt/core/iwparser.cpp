// Qt AST viewer core: parser implementation.
#include "iwparser.h"

#include <stdexcept>

#include <QSet>

namespace iw {
namespace {

const QSet<QString> LEGACY_GENERIC_CALLEE_KEYWORDS = {
    QStringLiteral("var"),
    QStringLiteral("var_set"),
    QStringLiteral("fn"),
    QStringLiteral("function"),
    QStringLiteral("declare"),
    QStringLiteral("let"),
    QStringLiteral("if"),
    QStringLiteral("while"),
    QStringLiteral("cond"),
    QStringLiteral("public"),
    QStringLiteral("class"),
    QStringLiteral("match"),
    QStringLiteral("array_new"),
    QStringLiteral("export")
};

const QSet<QString> VARIADIC_FOLD_BUILTIN_NAMES = {
    QStringLiteral("add"),
    QStringLiteral("sub"),
    QStringLiteral("mul"),
    QStringLiteral("and"),
    QStringLiteral("or")
};

const QSet<QString> LEFT_ASSOCIATED_VARIADIC_FOLD_BUILTIN_NAMES = {
    QStringLiteral("sub")
};

class Pass1Parser final {
public:
    explicit Pass1Parser(const TokenList &tokens)
        : m_tokens(tokens),
          m_currentPosition(0) {
    }

    AstNodePtr parseRoot() {
        if (m_tokens.isEmpty()) {
            throw std::runtime_error("Syntax Error: Unexpected end of input.");
        }

        const AstNodePtr root = parseToken();
        if (m_currentPosition != m_tokens.size()) {
            throw std::runtime_error("Syntax Error: Unexpected trailing tokens.");
        }
        return root;
    }

private:
    AstNodePtr buildBracketListNode(BracketKind bracketKind, const AstNodeList &elements) {
        switch (bracketKind) {
        case BracketKind::Round:
            return std::make_shared<RoundParenListNode>(elements);
        case BracketKind::Square:
            return std::make_shared<SquareParenListNode>(elements);
        case BracketKind::Curly:
            return std::make_shared<CurlyParenListNode>(elements);
        case BracketKind::Angle:
            return std::make_shared<AngleParenListNode>(elements);
        }

        throw std::runtime_error("Syntax Error: Unknown bracket kind.");
    }

    AstNodePtr parseList(const Token &openToken) {
        m_currentPosition += 1;
        AstNodeList childNodes;
        while (m_currentPosition < m_tokens.size()) {
            const Token &nextToken = m_tokens.at(m_currentPosition);
            if (nextToken.kind() == TokenType::RParen) {
                if (nextToken.bracketKind() != openToken.bracketKind()) {
                    throw std::runtime_error("Syntax Error: Mismatched closing bracket.");
                }
                m_currentPosition += 1;
                return buildBracketListNode(openToken.bracketKind(), childNodes);
            }
            childNodes.push_back(parseToken());
        }
        throw std::runtime_error("Syntax Error: Unclosed bracket.");
    }

    AstNodePtr parseToken() {
        if (m_currentPosition >= m_tokens.size()) {
            throw std::runtime_error("Syntax Error: Unexpected end of input.");
        }

        const Token &currentToken = m_tokens.at(m_currentPosition);
        if (currentToken.kind() == TokenType::LParen) {
            return parseList(currentToken);
        }
        if (currentToken.kind() == TokenType::Identifier) {
            m_currentPosition += 1;
            const std::optional<TextDatabaseReferenceInfo> textReferenceInfo = parseTextDatabaseReferenceName(currentToken.identifierName());
            if (textReferenceInfo.has_value()) {
                return std::make_shared<TextDatabaseReferenceNode>(textReferenceInfo->typeName(), textReferenceInfo->entryName(), textReferenceInfo->referenceName());
            }
            return std::make_shared<IdentifierNode>(currentToken.identifierName());
        }
        if (currentToken.kind() == TokenType::Number) {
            m_currentPosition += 1;
            return std::make_shared<NumberLiteralNode>(currentToken.typeName(), currentToken.numericValue(), currentToken.raw());
        }
        if (currentToken.kind() == TokenType::RParen) {
            throw std::runtime_error("Syntax Error: Unexpected closing bracket.");
        }

        throw std::runtime_error("Syntax Error: Unexpected token type.");
    }

    const TokenList &m_tokens;
    qsizetype m_currentPosition;
};

struct ParsedClassBody final {
    std::vector<ClassConstructorNodePtr> constructors;
    std::vector<ClassMethodNodePtr> methods;
    std::vector<ClassPropertyNodePtr> properties;
    AstNodeList memberNodeList;
};

AstNodePtr parsePass4(const AstNodePtr &node);
AstNodePtr parsePass5(const AstNodePtr &node);
AstNodePtr parsePass6(const AstNodePtr &node);

std::vector<TypeVarBindNodePtr> parseParameterList(const AstNodePtr &paramsNode);
std::vector<LetBinding> parseBindingList(const AstNodePtr &bindingsNode);
ParsedClassBody parseClassBody(const AstNodeList &bodyElements);

void throwLegacyKeywordError(const QString &legacyKeyword, const QString &canonicalKeyword) {
    throw std::runtime_error(QStringLiteral("Legacy '%1' syntax is no longer accepted; use '%2' instead")
        .arg(legacyKeyword, canonicalKeyword)
        .toStdString());
}

AstNodePtr parseSquareParenList(const std::shared_ptr<SquareParenListNode> &node) {
    AstNodeList processedElements;
    for (const AstNodePtr &element : node->elements()) {
        processedElements.push_back(parsePass4(element));
    }

    if (processedElements.size() == 2) {
        const IdentifierNodePtr identifier = std::dynamic_pointer_cast<IdentifierNode>(processedElements.at(0));
        if (identifier) {
            return std::make_shared<TypeVarBindNode>(identifier, processedElements.at(1));
        }
    }

    const IdentifierNodePtr firstIdentifier = processedElements.empty() ? nullptr : std::dynamic_pointer_cast<IdentifierNode>(processedElements.at(0));
    if (firstIdentifier) {
        throw std::runtime_error("Invalid bind structure: expected [identifier type]");
    }

    return std::make_shared<SquareParenListNode>(processedElements);
}

AstNodePtr parseCurlyParenList(const std::shared_ptr<CurlyParenListNode> &node) {
    AstNodeList processedElements;
    for (const AstNodePtr &element : node->elements()) {
        processedElements.push_back(parsePass4(element));
    }

    if (!processedElements.empty()) {
        const IdentifierNodePtr firstIdentifier = std::dynamic_pointer_cast<IdentifierNode>(processedElements.at(0));
        if (firstIdentifier && firstIdentifier->name() == QStringLiteral("program")) {
            if (processedElements.size() >= 2) {
                const IdentifierNodePtr unitId = std::dynamic_pointer_cast<IdentifierNode>(processedElements.at(1));
                if (unitId) {
                    AstNodeList topLevelExpressions;
                    for (std::size_t index = 2; index < processedElements.size(); index += 1) {
                        topLevelExpressions.push_back(processedElements.at(index));
                    }
                    return std::make_shared<ProgramNode>(unitId, topLevelExpressions);
                }
            }

            AstNodeList topLevelExpressions;
            for (std::size_t index = 1; index < processedElements.size(); index += 1) {
                topLevelExpressions.push_back(processedElements.at(index));
            }
            return std::make_shared<ProgramNode>(nullptr, topLevelExpressions);
        }
    }

    return std::make_shared<SeqNode>(processedElements);
}

AstNodePtr parseAngleParenList(const std::shared_ptr<AngleParenListNode> &node) {
    if (node->elements().empty()) {
        return node;
    }

    const IdentifierNodePtr firstIdentifier = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(0));
    if (firstIdentifier && firstIdentifier->name() == QStringLiteral("bind")) {
        throw std::runtime_error("Legacy '<bind ...>' syntax is no longer accepted; use '[identifier type]' instead");
    }

    if (firstIdentifier && firstIdentifier->name() == QStringLiteral("to")) {
        if (node->elements().size() >= 3) {
            const AstNodePtr returnType = parsePass4(node->elements().at(1));
            const IdentifierNodePtr fromKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
            if (fromKeyword && fromKeyword->name() == QStringLiteral("from")) {
                AstNodeList paramTypes;
                for (std::size_t index = 3; index < node->elements().size(); index += 1) {
                    paramTypes.push_back(parsePass4(node->elements().at(index)));
                }
                return std::make_shared<TypeToFromNode>(returnType, paramTypes);
            }
        }
        throw std::runtime_error("Invalid function type structure: expected <to returnType from paramType1 paramType2 ...>");
    }

    if (firstIdentifier && firstIdentifier->name() == QStringLiteral("union")) {
        if (node->elements().size() >= 2) {
            AstNodeList types;
            for (std::size_t index = 1; index < node->elements().size(); index += 1) {
                types.push_back(parsePass4(node->elements().at(index)));
            }
            return std::make_shared<TypeUnionNode>(types);
        }
        throw std::runtime_error("Invalid union type structure: expected <union type1 type2 ...>");
    }

    if (firstIdentifier && firstIdentifier->name() == QStringLiteral("generic")) {
        if (node->elements().size() >= 2) {
            const AstNodePtr nameNode = parsePass4(node->elements().at(1));
            const IdentifierNodePtr nameIdentifier = std::dynamic_pointer_cast<IdentifierNode>(nameNode);
            if (!nameIdentifier) {
                throw std::runtime_error("Invalid generic structure: expected <generic name T1 T2 ...>");
            }

            std::vector<IdentifierNodePtr> genericTypeArgs;
            for (std::size_t index = 2; index < node->elements().size(); index += 1) {
                const IdentifierNodePtr genericTypeArg = std::dynamic_pointer_cast<IdentifierNode>(parsePass4(node->elements().at(index)));
                if (!genericTypeArg) {
                    throw std::runtime_error("Generic type arguments must be identifiers");
                }
                genericTypeArgs.push_back(genericTypeArg);
            }
            return std::make_shared<GenericNameNode>(nameIdentifier, genericTypeArgs);
        }
        throw std::runtime_error("Invalid generic structure: expected <generic name T1 T2 ...>");
    }

    AstNodeList processedElements;
    for (const AstNodePtr &element : node->elements()) {
        processedElements.push_back(parsePass4(element));
    }
    AstNodeList typeArgs;
    for (std::size_t index = 1; index < processedElements.size(); index += 1) {
        typeArgs.push_back(processedElements.at(index));
    }
    return std::make_shared<GenericCallNode>(processedElements.at(0), typeArgs);
}

std::shared_ptr<ImportNode> parseImportExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("Invalid import structure: expected (import package-path)");
    }

    const IdentifierNodePtr packageNode = std::dynamic_pointer_cast<IdentifierNode>(parsePass4(node->elements().at(1)));
    if (!packageNode) {
        throw std::runtime_error("Import target must be a package path identifier");
    }

    return std::make_shared<ImportNode>(packageNode);
}

std::shared_ptr<PublicNode> parsePublicExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("public expects exactly one argument");
    }

    const AstNodePtr inner = parsePass4(node->elements().at(1));
    if (std::dynamic_pointer_cast<PublicNode>(inner)) {
        throw std::runtime_error("public cannot wrap public");
    }
    return std::make_shared<PublicNode>(inner);
}

std::shared_ptr<ExportNode> parseExportExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("export expects exactly one argument");
    }

    return std::make_shared<ExportNode>(parsePass4(node->elements().at(1)));
}

AstNodePtr parseDvarExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 3) {
        throw std::runtime_error("Invalid var structure: expected (var [identifier type] expression)");
    }
    return std::make_shared<DvarNode>(parsePass4(node->elements().at(1)), parsePass4(node->elements().at(2)));
}

AstNodePtr parseSetExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 3) {
        throw std::runtime_error("Invalid var_set structure: expected (var_set identifier expression)");
    }

    const IdentifierNodePtr identifier = std::dynamic_pointer_cast<IdentifierNode>(parsePass4(node->elements().at(1)));
    if (!identifier) {
        throw std::runtime_error("var_set target must be an identifier");
    }

    return std::make_shared<SetNode>(identifier, parsePass4(node->elements().at(2)));
}

AstNodePtr parseFnExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 6) {
        throw std::runtime_error("Invalid fn structure: expected (fn ([param1 type1] ...) to returnType in bodyexp)");
    }

    const IdentifierNodePtr toKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
    if (!toKeyword || toKeyword->name() != QStringLiteral("to")) {
        throw std::runtime_error("Expected 'to' keyword in fn expression");
    }
    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(4));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in fn expression");
    }

    return std::make_shared<FnNode>(
        parseParameterList(node->elements().at(1)),
        parsePass4(node->elements().at(3)),
        parsePass4(node->elements().at(5))
    );
}

AstNodePtr parseDfunExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 7) {
        throw std::runtime_error("Invalid function structure: expected (function name ([param1 type1] ...) to returnType in bodyexp)");
    }

    const AstNodePtr nameNode = parsePass4(node->elements().at(1));
    const IdentifierNodePtr toKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(3));
    if (!toKeyword || toKeyword->name() != QStringLiteral("to")) {
        throw std::runtime_error("Expected 'to' keyword in function expression");
    }
    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(5));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in function expression");
    }

    const std::vector<TypeVarBindNodePtr> params = parseParameterList(node->elements().at(2));
    const AstNodePtr returnType = parsePass4(node->elements().at(4));
    const AstNodePtr body = parsePass4(node->elements().at(6));

    const GenericNameNodePtr genericName = std::dynamic_pointer_cast<GenericNameNode>(nameNode);
    if (genericName) {
        return std::make_shared<GenericDfunNode>(genericName, params, returnType, body);
    }

    const IdentifierNodePtr functionName = std::dynamic_pointer_cast<IdentifierNode>(nameNode);
    if (!functionName) {
        throw std::runtime_error("Function name must be an identifier");
    }
    return std::make_shared<DfunNode>(functionName, params, returnType, body);
}

std::shared_ptr<DeclaredDfunNode> parseDeclaredDfunExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 5) {
        throw std::runtime_error("Invalid declared function structure: expected (function name ([param1 type1] ...) to returnType)");
    }

    const AstNodePtr nameNode = parsePass4(node->elements().at(1));
    if (std::dynamic_pointer_cast<GenericNameNode>(nameNode)) {
        throw std::runtime_error("declare currently supports only non-generic function declarations");
    }

    const IdentifierNodePtr functionName = std::dynamic_pointer_cast<IdentifierNode>(nameNode);
    if (!functionName) {
        throw std::runtime_error("Declared function name must be an identifier");
    }

    const IdentifierNodePtr toKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(3));
    if (!toKeyword || toKeyword->name() != QStringLiteral("to")) {
        throw std::runtime_error("Expected 'to' keyword in declared function expression");
    }

    return std::make_shared<DeclaredDfunNode>(functionName, parseParameterList(node->elements().at(2)), parsePass4(node->elements().at(4)));
}

AstNodePtr parseDeclareExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("Invalid declare structure: expected (declare (function name ([...] ...) to returnType))");
    }

    const std::shared_ptr<RoundParenListNode> declarationNode = std::dynamic_pointer_cast<RoundParenListNode>(node->elements().at(1));
    if (!declarationNode || declarationNode->elements().empty()) {
        throw std::runtime_error("Invalid declare structure: expected a single declaration form");
    }

    const IdentifierNodePtr keywordNode = std::dynamic_pointer_cast<IdentifierNode>(declarationNode->elements().at(0));
    if (!keywordNode || keywordNode->name() != QStringLiteral("function")) {
        throw std::runtime_error("Invalid declare structure: only function declarations are currently supported");
    }

    return parseDeclaredDfunExpression(declarationNode);
}

AstNodePtr parseLetExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 4) {
        throw std::runtime_error("Invalid let structure: expected (let (([var1 type1] exp1) ...) in bodyexp)");
    }

    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in let expression");
    }

    return std::make_shared<LetNode>(parseBindingList(node->elements().at(1)), parsePass4(node->elements().at(3)));
}

AstNodePtr parseIfExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 6) {
        throw std::runtime_error("Invalid if structure: expected (if cond then exp else elseexp)");
    }

    const IdentifierNodePtr thenKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
    if (!thenKeyword || thenKeyword->name() != QStringLiteral("then")) {
        throw std::runtime_error("Expected 'then' keyword in if expression");
    }
    const IdentifierNodePtr elseKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(4));
    if (!elseKeyword || elseKeyword->name() != QStringLiteral("else")) {
        throw std::runtime_error("Expected 'else' keyword in if expression");
    }

    return std::make_shared<IfNode>(
        parsePass4(node->elements().at(1)),
        parsePass4(node->elements().at(3)),
        parsePass4(node->elements().at(5))
    );
}

AstNodePtr parseWhileExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 4) {
        throw std::runtime_error("Invalid while structure: expected (while condition in exp)");
    }

    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in while expression");
    }

    return std::make_shared<WhileNode>(parsePass4(node->elements().at(1)), parsePass4(node->elements().at(3)));
}

AstNodePtr parseCondExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() < 2) {
        throw std::runtime_error("Invalid cond structure: expected at least one clause");
    }

    std::vector<CondClause> clauses;
    for (std::size_t index = 1; index < node->elements().size(); index += 1) {
        const std::shared_ptr<RoundParenListNode> clauseNode = std::dynamic_pointer_cast<RoundParenListNode>(node->elements().at(index));
        if (!clauseNode || clauseNode->elements().size() != 2) {
            throw std::runtime_error("Invalid cond clause: expected (condition expression)");
        }

        clauses.push_back(CondClause{
            parsePass4(clauseNode->elements().at(0)),
            parsePass4(clauseNode->elements().at(1))
        });
    }

    return std::make_shared<CondNode>(clauses);
}

std::shared_ptr<ClassPropertyNode> parseClassProperty(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("Invalid property structure: expected (property [name type])");
    }

    const TypeVarBindNodePtr bindNode = std::dynamic_pointer_cast<TypeVarBindNode>(parsePass4(node->elements().at(1)));
    if (!bindNode) {
        throw std::runtime_error("Property must have a type binding");
    }

    return std::make_shared<ClassPropertyNode>(bindNode);
}

std::shared_ptr<ClassMethodNode> parseClassMethod(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 7) {
        throw std::runtime_error("Invalid method structure: expected (method name ([param1 type1] ...) to returnType in body)");
    }

    const IdentifierNodePtr methodName = std::dynamic_pointer_cast<IdentifierNode>(parsePass4(node->elements().at(1)));
    if (!methodName) {
        throw std::runtime_error("Method name must be an identifier");
    }

    const IdentifierNodePtr toKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(3));
    if (!toKeyword || toKeyword->name() != QStringLiteral("to")) {
        throw std::runtime_error("Expected 'to' keyword in method definition");
    }
    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(5));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in method definition");
    }

    return std::make_shared<ClassMethodNode>(
        methodName,
        parseParameterList(node->elements().at(2)),
        parsePass4(node->elements().at(4)),
        parsePass4(node->elements().at(6))
    );
}

std::shared_ptr<ClassConstructorNode> parseClassConstructor(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 4) {
        throw std::runtime_error("Invalid constructor structure: expected (constructor ([param1 type1] ...) in body)");
    }

    const IdentifierNodePtr inKeyword = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(2));
    if (!inKeyword || inKeyword->name() != QStringLiteral("in")) {
        throw std::runtime_error("Expected 'in' keyword in constructor definition");
    }

    return std::make_shared<ClassConstructorNode>(parseParameterList(node->elements().at(1)), parsePass4(node->elements().at(3)));
}

std::shared_ptr<PublicNode> parsePublicClassBodyMember(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() != 2) {
        throw std::runtime_error("public expects exactly one argument");
    }

    const std::shared_ptr<RoundParenListNode> innerElement = std::dynamic_pointer_cast<RoundParenListNode>(node->elements().at(1));
    if (!innerElement || innerElement->elements().empty()) {
        throw std::runtime_error("public may only wrap class properties and methods");
    }

    const IdentifierNodePtr firstInnerElement = std::dynamic_pointer_cast<IdentifierNode>(innerElement->elements().at(0));
    if (!firstInnerElement) {
        throw std::runtime_error("public may only wrap class properties and methods");
    }

    const QString &keyword = firstInnerElement->name();
    if (keyword == QStringLiteral("property")) {
        return std::make_shared<PublicNode>(parseClassProperty(innerElement));
    }
    if (keyword == QStringLiteral("method")) {
        return std::make_shared<PublicNode>(parseClassMethod(innerElement));
    }
    if (keyword == QStringLiteral("constructor")) {
        throw std::runtime_error("constructors are always public and cannot be wrapped in public");
    }
    if (keyword == QStringLiteral("public")) {
        throw std::runtime_error("public cannot wrap public");
    }
    throw std::runtime_error("public may only wrap class properties and methods");
}

AstNodePtr parseClassBodyMember(const std::shared_ptr<RoundParenListNode> &node) {
    const IdentifierNodePtr firstIdentifier = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(0));
    if (!firstIdentifier) {
        throw std::runtime_error("Unknown class member type");
    }

    if (firstIdentifier->name() == QStringLiteral("property")) {
        return parseClassProperty(node);
    }
    if (firstIdentifier->name() == QStringLiteral("method")) {
        return parseClassMethod(node);
    }
    if (firstIdentifier->name() == QStringLiteral("constructor")) {
        return parseClassConstructor(node);
    }
    if (firstIdentifier->name() == QStringLiteral("public")) {
        return parsePublicClassBodyMember(node);
    }
    throw std::runtime_error(QStringLiteral("Unknown class member type: %1").arg(firstIdentifier->name()).toStdString());
}

ParsedClassBody parseClassBody(const AstNodeList &bodyElements) {
    ParsedClassBody result;

    for (const AstNodePtr &element : bodyElements) {
        const std::shared_ptr<RoundParenListNode> roundNode = std::dynamic_pointer_cast<RoundParenListNode>(element);
        if (!roundNode || roundNode->elements().empty()) {
            continue;
        }

        const AstNodePtr memberNode = parseClassBodyMember(roundNode);
        result.memberNodeList.push_back(memberNode);

        AstNodePtr innerMember = memberNode;
        if (const PublicNodePtr publicNode = std::dynamic_pointer_cast<PublicNode>(memberNode)) {
            innerMember = publicNode->inner();
        }

        if (const ClassPropertyNodePtr propertyNode = std::dynamic_pointer_cast<ClassPropertyNode>(innerMember)) {
            result.properties.push_back(propertyNode);
            continue;
        }
        if (const ClassMethodNodePtr methodNode = std::dynamic_pointer_cast<ClassMethodNode>(innerMember)) {
            result.methods.push_back(methodNode);
            continue;
        }
        if (const ClassConstructorNodePtr constructorNode = std::dynamic_pointer_cast<ClassConstructorNode>(innerMember)) {
            result.constructors.push_back(constructorNode);
        }
    }

    return result;
}

AstNodePtr parseClassExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() < 2) {
        throw std::runtime_error("Invalid class structure: expected class name and body");
    }

    const AstNodePtr nameNode = parsePass4(node->elements().at(1));
    const ParsedClassBody body = parseClassBody(AstNodeList(node->elements().begin() + 2, node->elements().end()));

    const GenericNameNodePtr genericName = std::dynamic_pointer_cast<GenericNameNode>(nameNode);
    if (genericName) {
        return std::make_shared<GenericClassNode>(genericName, body.constructors, body.methods, body.properties, body.memberNodeList);
    }

    const IdentifierNodePtr className = std::dynamic_pointer_cast<IdentifierNode>(nameNode);
    if (!className) {
        throw std::runtime_error("Class name must be an identifier");
    }

    return std::make_shared<ClassNode>(className, body.constructors, body.methods, body.properties, body.memberNodeList);
}

std::vector<TypeVarBindNodePtr> parseParameterList(const AstNodePtr &paramsNode) {
    const std::shared_ptr<RoundParenListNode> roundParamsNode = std::dynamic_pointer_cast<RoundParenListNode>(paramsNode);
    if (!roundParamsNode) {
        throw std::runtime_error("Parameter list must be enclosed in round parentheses");
    }

    std::vector<TypeVarBindNodePtr> params;
    for (const AstNodePtr &paramNode : roundParamsNode->elements()) {
        const TypeVarBindNodePtr bindNode = std::dynamic_pointer_cast<TypeVarBindNode>(parsePass4(paramNode));
        if (!bindNode) {
            throw std::runtime_error("All parameters must be type-bound identifiers");
        }
        params.push_back(bindNode);
    }
    return params;
}

std::vector<LetBinding> parseBindingList(const AstNodePtr &bindingsNode) {
    const std::shared_ptr<RoundParenListNode> roundBindingsNode = std::dynamic_pointer_cast<RoundParenListNode>(bindingsNode);
    if (!roundBindingsNode) {
        throw std::runtime_error("Binding list must be enclosed in round parentheses");
    }

    std::vector<LetBinding> bindings;
    for (const AstNodePtr &bindingNode : roundBindingsNode->elements()) {
        const std::shared_ptr<RoundParenListNode> roundBindingNode = std::dynamic_pointer_cast<RoundParenListNode>(bindingNode);
        if (!roundBindingNode || roundBindingNode->elements().size() != 2) {
            throw std::runtime_error("Invalid binding: expected ([var type] value)");
        }

        bindings.push_back(LetBinding{
            parsePass4(roundBindingNode->elements().at(0)),
            parsePass4(roundBindingNode->elements().at(1))
        });
    }
    return bindings;
}

AstNodePtr parseMatchExpression(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().size() < 3) {
        throw std::runtime_error("Invalid match structure: expected (match expression (pattern1 body1) ...)");
    }

    std::vector<MatchBranch> branches;
    for (std::size_t index = 2; index < node->elements().size(); index += 1) {
        const std::shared_ptr<RoundParenListNode> caseNode = std::dynamic_pointer_cast<RoundParenListNode>(node->elements().at(index));
        if (!caseNode || caseNode->elements().size() != 2) {
            throw std::runtime_error("Invalid match case: expected (pattern body)");
        }

        const TypeVarBindNodePtr pattern = std::dynamic_pointer_cast<TypeVarBindNode>(parsePass4(caseNode->elements().at(0)));
        if (pattern) {
            branches.push_back(MatchBranch{pattern, parsePass4(caseNode->elements().at(1))});
        }
    }

    return std::make_shared<MatchNode>(parsePass4(node->elements().at(1)), branches);
}

AstNodePtr parseRoundParenList(const std::shared_ptr<RoundParenListNode> &node) {
    if (node->elements().empty()) {
        return node;
    }

    const IdentifierNodePtr firstIdentifier = std::dynamic_pointer_cast<IdentifierNode>(node->elements().at(0));
    if (!firstIdentifier) {
        AstNodeList processedElements;
        for (const AstNodePtr &element : node->elements()) {
            processedElements.push_back(parsePass4(element));
        }
        AstNodeList args;
        for (std::size_t index = 1; index < processedElements.size(); index += 1) {
            args.push_back(processedElements.at(index));
        }
        return std::make_shared<FunctionCallNode>(processedElements.at(0), args);
    }

    if (
        node->elements().size() == 2
        && std::dynamic_pointer_cast<AngleParenListNode>(node->elements().at(1))
        && !LEGACY_GENERIC_CALLEE_KEYWORDS.contains(firstIdentifier->name())
    ) {
        const std::shared_ptr<AngleParenListNode> rawTypeArgs = std::dynamic_pointer_cast<AngleParenListNode>(node->elements().at(1));
        AstNodeList typeArgs;
        for (const AstNodePtr &typeArg : rawTypeArgs->elements()) {
            typeArgs.push_back(parsePass4(typeArg));
        }
        return std::make_shared<GenericCallNode>(parsePass4(firstIdentifier), typeArgs);
    }

    const QString &keyword = firstIdentifier->name();
    if (keyword == QStringLiteral("dvar")) {
        throwLegacyKeywordError(QStringLiteral("dvar"), QStringLiteral("var"));
    }
    if (keyword == QStringLiteral("var")) {
        return parseDvarExpression(node);
    }
    if (keyword == QStringLiteral("set")) {
        throwLegacyKeywordError(QStringLiteral("set"), QStringLiteral("var_set"));
    }
    if (keyword == QStringLiteral("assign")) {
        throwLegacyKeywordError(QStringLiteral("assign"), QStringLiteral("var_set"));
    }
    if (keyword == QStringLiteral("var_set")) {
        return parseSetExpression(node);
    }
    if (keyword == QStringLiteral("fn")) {
        return parseFnExpression(node);
    }
    if (keyword == QStringLiteral("dfun")) {
        throwLegacyKeywordError(QStringLiteral("dfun"), QStringLiteral("function"));
    }
    if (keyword == QStringLiteral("function")) {
        return parseDfunExpression(node);
    }
    if (keyword == QStringLiteral("declare")) {
        return parseDeclareExpression(node);
    }
    if (keyword == QStringLiteral("let")) {
        return parseLetExpression(node);
    }
    if (keyword == QStringLiteral("if")) {
        return parseIfExpression(node);
    }
    if (keyword == QStringLiteral("while")) {
        return parseWhileExpression(node);
    }
    if (keyword == QStringLiteral("cond")) {
        return parseCondExpression(node);
    }
    if (keyword == QStringLiteral("public")) {
        return parsePublicExpression(node);
    }
    if (keyword == QStringLiteral("seq")) {
        throw std::runtime_error("Legacy '(seq ...)' blocks are no longer accepted; use '{...}' blocks instead");
    }
    if (keyword == QStringLiteral("class")) {
        return parseClassExpression(node);
    }
    if (keyword == QStringLiteral("match")) {
        return parseMatchExpression(node);
    }
    if (keyword == QStringLiteral("import")) {
        return parseImportExpression(node);
    }
    if (keyword == QStringLiteral("export")) {
        return parseExportExpression(node);
    }

    AstNodeList processedElements;
    for (const AstNodePtr &element : node->elements()) {
        processedElements.push_back(parsePass4(element));
    }
    AstNodeList args;
    for (std::size_t index = 1; index < processedElements.size(); index += 1) {
        args.push_back(processedElements.at(index));
    }
    return std::make_shared<FunctionCallNode>(processedElements.at(0), args);
}

AstNodePtr parsePass4(const AstNodePtr &node) {
    if (std::dynamic_pointer_cast<IdentifierNode>(node)
        || std::dynamic_pointer_cast<TextDatabaseReferenceNode>(node)
        || std::dynamic_pointer_cast<NumberLiteralNode>(node)
        || std::dynamic_pointer_cast<ListNode>(node)
        || std::dynamic_pointer_cast<FnNode>(node)
        || std::dynamic_pointer_cast<LetNode>(node)
        || std::dynamic_pointer_cast<IfNode>(node)
        || std::dynamic_pointer_cast<WhileNode>(node)
        || std::dynamic_pointer_cast<CondNode>(node)
        || std::dynamic_pointer_cast<TypeVarBindNode>(node)
        || std::dynamic_pointer_cast<TypeToFromNode>(node)
        || std::dynamic_pointer_cast<TypeUnionNode>(node)
        || std::dynamic_pointer_cast<ProgramNode>(node)
        || std::dynamic_pointer_cast<ImportNode>(node)
        || std::dynamic_pointer_cast<ExportNode>(node)
        || std::dynamic_pointer_cast<PublicNode>(node)
        || std::dynamic_pointer_cast<DvarNode>(node)
        || std::dynamic_pointer_cast<DfunNode>(node)
        || std::dynamic_pointer_cast<DeclaredDfunNode>(node)
        || std::dynamic_pointer_cast<SetNode>(node)
        || std::dynamic_pointer_cast<SeqNode>(node)
        || std::dynamic_pointer_cast<ClassNode>(node)
        || std::dynamic_pointer_cast<ClassPropertyNode>(node)
        || std::dynamic_pointer_cast<ClassMethodNode>(node)
        || std::dynamic_pointer_cast<ClassConstructorNode>(node)
        || std::dynamic_pointer_cast<GenericNameNode>(node)
        || std::dynamic_pointer_cast<GenericClassNode>(node)
        || std::dynamic_pointer_cast<GenericDfunNode>(node)
        || std::dynamic_pointer_cast<FunctionCallNode>(node)
        || std::dynamic_pointer_cast<GenericCallNode>(node)
        || std::dynamic_pointer_cast<MatchNode>(node)) {
        return node;
    }

    const std::shared_ptr<SquareParenListNode> squareNode = std::dynamic_pointer_cast<SquareParenListNode>(node);
    if (squareNode) {
        return parseSquareParenList(squareNode);
    }

    const std::shared_ptr<CurlyParenListNode> curlyNode = std::dynamic_pointer_cast<CurlyParenListNode>(node);
    if (curlyNode) {
        return parseCurlyParenList(curlyNode);
    }

    const std::shared_ptr<AngleParenListNode> angleNode = std::dynamic_pointer_cast<AngleParenListNode>(node);
    if (angleNode) {
        return parseAngleParenList(angleNode);
    }

    const std::shared_ptr<RoundParenListNode> roundNode = std::dynamic_pointer_cast<RoundParenListNode>(node);
    if (roundNode) {
        return parseRoundParenList(roundNode);
    }

    return node;
}

TypeVarBindNodePtr rewriteTypeVarBindNode(const TypeVarBindNodePtr &node);
ClassPropertyNodePtr rewriteClassPropertyNode(const ClassPropertyNodePtr &node);
ClassMethodNodePtr rewriteClassMethodNode(const ClassMethodNodePtr &node);
ClassConstructorNodePtr rewriteClassConstructorNode(const ClassConstructorNodePtr &node);
AstNodePtr rewriteAstNode(const AstNodePtr &node);

AstNodePtr buildRightAssociatedBuiltinCall(const QString &name, const AstNodeList &args) {
    if (args.size() < 2) {
        throw std::runtime_error(QStringLiteral("%1 requires at least 2 arguments for right-associated folding").arg(name).toStdString());
    }

    AstNodePtr current = std::make_shared<FunctionCallNode>(
        std::make_shared<IdentifierNode>(name),
        AstNodeList{args.at(args.size() - 2), args.at(args.size() - 1)}
    );

    for (std::size_t index = args.size() - 2; index > 0; index -= 1) {
        current = std::make_shared<FunctionCallNode>(
            std::make_shared<IdentifierNode>(name),
            AstNodeList{args.at(index - 1), current}
        );
    }
    return current;
}

AstNodePtr buildLeftAssociatedBuiltinCall(const QString &name, const AstNodeList &args) {
    if (args.size() < 2) {
        throw std::runtime_error(QStringLiteral("%1 requires at least 2 arguments for left-associated folding").arg(name).toStdString());
    }

    AstNodePtr current = std::make_shared<FunctionCallNode>(
        std::make_shared<IdentifierNode>(name),
        AstNodeList{args.at(0), args.at(1)}
    );

    for (std::size_t index = 2; index < args.size(); index += 1) {
        current = std::make_shared<FunctionCallNode>(
            std::make_shared<IdentifierNode>(name),
            AstNodeList{current, args.at(index)}
        );
    }
    return current;
}

AstNodePtr foldVariadicBuiltinCall(const std::shared_ptr<FunctionCallNode> &node) {
    const IdentifierNodePtr callee = std::dynamic_pointer_cast<IdentifierNode>(node->callee());
    if (!callee) {
        return node;
    }
    if (!VARIADIC_FOLD_BUILTIN_NAMES.contains(callee->name()) || node->args().size() <= 2) {
        return node;
    }
    if (LEFT_ASSOCIATED_VARIADIC_FOLD_BUILTIN_NAMES.contains(callee->name())) {
        return buildLeftAssociatedBuiltinCall(callee->name(), node->args());
    }
    return buildRightAssociatedBuiltinCall(callee->name(), node->args());
}

TypeVarBindNodePtr rewriteTypeVarBindNode(const TypeVarBindNodePtr &node) {
    return std::make_shared<TypeVarBindNode>(node->identifier(), rewriteAstNode(node->typeExpression()));
}

ClassPropertyNodePtr rewriteClassPropertyNode(const ClassPropertyNodePtr &node) {
    return std::make_shared<ClassPropertyNode>(rewriteTypeVarBindNode(node->bind()));
}

ClassMethodNodePtr rewriteClassMethodNode(const ClassMethodNodePtr &node) {
    std::vector<TypeVarBindNodePtr> params;
    for (const TypeVarBindNodePtr &param : node->params()) {
        params.push_back(rewriteTypeVarBindNode(param));
    }
    return std::make_shared<ClassMethodNode>(node->methodName(), params, rewriteAstNode(node->returnType()), rewriteAstNode(node->body()));
}

ClassConstructorNodePtr rewriteClassConstructorNode(const ClassConstructorNodePtr &node) {
    std::vector<TypeVarBindNodePtr> params;
    for (const TypeVarBindNodePtr &param : node->params()) {
        params.push_back(rewriteTypeVarBindNode(param));
    }
    return std::make_shared<ClassConstructorNode>(params, rewriteAstNode(node->body()));
}

AstNodePtr rewriteAstNode(const AstNodePtr &node) {
    if (const std::shared_ptr<FnNode> fnNode = std::dynamic_pointer_cast<FnNode>(node)) {
        std::vector<TypeVarBindNodePtr> params;
        for (const TypeVarBindNodePtr &param : fnNode->params()) {
            params.push_back(rewriteTypeVarBindNode(param));
        }
        return std::make_shared<FnNode>(params, rewriteAstNode(fnNode->returnType()), rewriteAstNode(fnNode->body()));
    }
    if (const std::shared_ptr<LetNode> letNode = std::dynamic_pointer_cast<LetNode>(node)) {
        std::vector<LetBinding> bindings;
        for (const LetBinding &binding : letNode->bindings()) {
            bindings.push_back(LetBinding{rewriteAstNode(binding.bind), rewriteAstNode(binding.value)});
        }
        return std::make_shared<LetNode>(bindings, rewriteAstNode(letNode->body()));
    }
    if (const std::shared_ptr<IfNode> ifNode = std::dynamic_pointer_cast<IfNode>(node)) {
        return std::make_shared<IfNode>(
            rewriteAstNode(ifNode->condExpr()),
            rewriteAstNode(ifNode->trueBranchExpr()),
            rewriteAstNode(ifNode->falseBranchExpr())
        );
    }
    if (const std::shared_ptr<WhileNode> whileNode = std::dynamic_pointer_cast<WhileNode>(node)) {
        return std::make_shared<WhileNode>(rewriteAstNode(whileNode->condExpr()), rewriteAstNode(whileNode->bodyExpr()));
    }
    if (const std::shared_ptr<CondNode> condNode = std::dynamic_pointer_cast<CondNode>(node)) {
        std::vector<CondClause> clauses;
        for (const CondClause &clause : condNode->clauses()) {
            clauses.push_back(CondClause{rewriteAstNode(clause.cond), rewriteAstNode(clause.body)});
        }
        return std::make_shared<CondNode>(clauses);
    }
    if (const TypeVarBindNodePtr bindNode = std::dynamic_pointer_cast<TypeVarBindNode>(node)) {
        return rewriteTypeVarBindNode(bindNode);
    }
    if (const std::shared_ptr<TypeToFromNode> typeToFromNode = std::dynamic_pointer_cast<TypeToFromNode>(node)) {
        AstNodeList paramTypes;
        for (const AstNodePtr &paramType : typeToFromNode->paramTypes()) {
            paramTypes.push_back(rewriteAstNode(paramType));
        }
        return std::make_shared<TypeToFromNode>(rewriteAstNode(typeToFromNode->returnType()), paramTypes);
    }
    if (const std::shared_ptr<TypeUnionNode> typeUnionNode = std::dynamic_pointer_cast<TypeUnionNode>(node)) {
        AstNodeList types;
        for (const AstNodePtr &typeNode : typeUnionNode->types()) {
            types.push_back(rewriteAstNode(typeNode));
        }
        return std::make_shared<TypeUnionNode>(types);
    }
    if (const std::shared_ptr<ProgramNode> programNode = std::dynamic_pointer_cast<ProgramNode>(node)) {
        AstNodeList topLevelExpressions;
        for (const AstNodePtr &expression : programNode->topLevelExpressions()) {
            topLevelExpressions.push_back(rewriteAstNode(expression));
        }
        return std::make_shared<ProgramNode>(programNode->unitId(), topLevelExpressions);
    }
    if (const std::shared_ptr<ExportNode> exportNode = std::dynamic_pointer_cast<ExportNode>(node)) {
        return std::make_shared<ExportNode>(rewriteAstNode(exportNode->inner()));
    }
    if (const PublicNodePtr publicNode = std::dynamic_pointer_cast<PublicNode>(node)) {
        return std::make_shared<PublicNode>(rewriteAstNode(publicNode->inner()));
    }
    if (const std::shared_ptr<DvarNode> dvarNode = std::dynamic_pointer_cast<DvarNode>(node)) {
        return std::make_shared<DvarNode>(rewriteAstNode(dvarNode->bind()), rewriteAstNode(dvarNode->value()));
    }
    if (const std::shared_ptr<SeqNode> seqNode = std::dynamic_pointer_cast<SeqNode>(node)) {
        AstNodeList expressions;
        for (const AstNodePtr &expression : seqNode->expressions()) {
            expressions.push_back(rewriteAstNode(expression));
        }
        return std::make_shared<SeqNode>(expressions);
    }
    if (const std::shared_ptr<DfunNode> dfunNode = std::dynamic_pointer_cast<DfunNode>(node)) {
        std::vector<TypeVarBindNodePtr> params;
        for (const TypeVarBindNodePtr &param : dfunNode->params()) {
            params.push_back(rewriteTypeVarBindNode(param));
        }
        return std::make_shared<DfunNode>(dfunNode->name(), params, rewriteAstNode(dfunNode->returnType()), rewriteAstNode(dfunNode->body()));
    }
    if (const std::shared_ptr<DeclaredDfunNode> declaredDfunNode = std::dynamic_pointer_cast<DeclaredDfunNode>(node)) {
        std::vector<TypeVarBindNodePtr> params;
        for (const TypeVarBindNodePtr &param : declaredDfunNode->params()) {
            params.push_back(rewriteTypeVarBindNode(param));
        }
        return std::make_shared<DeclaredDfunNode>(declaredDfunNode->name(), params, rewriteAstNode(declaredDfunNode->returnType()));
    }
    if (const std::shared_ptr<SetNode> setNode = std::dynamic_pointer_cast<SetNode>(node)) {
        return std::make_shared<SetNode>(setNode->identifier(), rewriteAstNode(setNode->value()));
    }
    if (const std::shared_ptr<ClassNode> classNode = std::dynamic_pointer_cast<ClassNode>(node)) {
        std::vector<ClassConstructorNodePtr> constructors;
        std::vector<ClassMethodNodePtr> methods;
        std::vector<ClassPropertyNodePtr> properties;
        AstNodeList memberNodeList;
        for (const ClassConstructorNodePtr &constructorNode : classNode->constructorNodeList()) {
            constructors.push_back(rewriteClassConstructorNode(constructorNode));
        }
        for (const ClassMethodNodePtr &methodNode : classNode->methodNodeList()) {
            methods.push_back(rewriteClassMethodNode(methodNode));
        }
        for (const ClassPropertyNodePtr &propertyNode : classNode->propertyNodeList()) {
            properties.push_back(rewriteClassPropertyNode(propertyNode));
        }
        for (const AstNodePtr &memberNode : classNode->memberNodeList()) {
            memberNodeList.push_back(rewriteAstNode(memberNode));
        }
        return std::make_shared<ClassNode>(classNode->name(), constructors, methods, properties, memberNodeList);
    }
    if (const ClassPropertyNodePtr propertyNode = std::dynamic_pointer_cast<ClassPropertyNode>(node)) {
        return rewriteClassPropertyNode(propertyNode);
    }
    if (const ClassMethodNodePtr methodNode = std::dynamic_pointer_cast<ClassMethodNode>(node)) {
        return rewriteClassMethodNode(methodNode);
    }
    if (const ClassConstructorNodePtr constructorNode = std::dynamic_pointer_cast<ClassConstructorNode>(node)) {
        return rewriteClassConstructorNode(constructorNode);
    }
    if (const std::shared_ptr<GenericNameNode> genericNameNode = std::dynamic_pointer_cast<GenericNameNode>(node)) {
        return std::make_shared<GenericNameNode>(genericNameNode->name(), genericNameNode->genericTypeArgs());
    }
    if (const std::shared_ptr<GenericClassNode> genericClassNode = std::dynamic_pointer_cast<GenericClassNode>(node)) {
        std::vector<ClassConstructorNodePtr> constructors;
        std::vector<ClassMethodNodePtr> methods;
        std::vector<ClassPropertyNodePtr> properties;
        AstNodeList memberNodeList;
        for (const ClassConstructorNodePtr &constructorNode : genericClassNode->constructorNodeList()) {
            constructors.push_back(rewriteClassConstructorNode(constructorNode));
        }
        for (const ClassMethodNodePtr &methodNode : genericClassNode->methodNodeList()) {
            methods.push_back(rewriteClassMethodNode(methodNode));
        }
        for (const ClassPropertyNodePtr &propertyNode : genericClassNode->propertyNodeList()) {
            properties.push_back(rewriteClassPropertyNode(propertyNode));
        }
        for (const AstNodePtr &memberNode : genericClassNode->memberNodeList()) {
            memberNodeList.push_back(rewriteAstNode(memberNode));
        }
        return std::make_shared<GenericClassNode>(
            std::make_shared<GenericNameNode>(genericClassNode->genericName()->name(), genericClassNode->genericName()->genericTypeArgs()),
            constructors,
            methods,
            properties,
            memberNodeList
        );
    }
    if (const std::shared_ptr<GenericDfunNode> genericDfunNode = std::dynamic_pointer_cast<GenericDfunNode>(node)) {
        std::vector<TypeVarBindNodePtr> params;
        for (const TypeVarBindNodePtr &param : genericDfunNode->params()) {
            params.push_back(rewriteTypeVarBindNode(param));
        }
        return std::make_shared<GenericDfunNode>(
            std::make_shared<GenericNameNode>(genericDfunNode->genericName()->name(), genericDfunNode->genericName()->genericTypeArgs()),
            params,
            rewriteAstNode(genericDfunNode->returnType()),
            rewriteAstNode(genericDfunNode->body())
        );
    }
    if (const std::shared_ptr<FunctionCallNode> functionCallNode = std::dynamic_pointer_cast<FunctionCallNode>(node)) {
        AstNodeList args;
        for (const AstNodePtr &arg : functionCallNode->args()) {
            args.push_back(rewriteAstNode(arg));
        }
        const std::shared_ptr<FunctionCallNode> rewrittenCall = std::make_shared<FunctionCallNode>(rewriteAstNode(functionCallNode->callee()), args);
        return foldVariadicBuiltinCall(rewrittenCall);
    }
    if (const std::shared_ptr<GenericCallNode> genericCallNode = std::dynamic_pointer_cast<GenericCallNode>(node)) {
        AstNodeList typeArgs;
        for (const AstNodePtr &typeArg : genericCallNode->typeArgs()) {
            typeArgs.push_back(rewriteAstNode(typeArg));
        }
        return std::make_shared<GenericCallNode>(rewriteAstNode(genericCallNode->callee()), typeArgs);
    }
    if (const std::shared_ptr<MatchNode> matchNode = std::dynamic_pointer_cast<MatchNode>(node)) {
        std::vector<MatchBranch> branches;
        for (const MatchBranch &branch : matchNode->branches()) {
            branches.push_back(MatchBranch{rewriteTypeVarBindNode(branch.bind), rewriteAstNode(branch.body)});
        }
        return std::make_shared<MatchNode>(rewriteAstNode(matchNode->unionExpr()), branches);
    }
    if (const std::shared_ptr<ListNode> listNode = std::dynamic_pointer_cast<ListNode>(node)) {
        AstNodeList elements;
        for (const AstNodePtr &element : listNode->elements()) {
            elements.push_back(rewriteAstNode(element));
        }
        return std::make_shared<ListNode>(elements);
    }
    return node;
}

AstNodePtr parsePass5(const AstNodePtr &node) {
    return rewriteAstNode(node);
}

AstNodePtr parsePass6(const AstNodePtr &node) {
    return node;
}

}

AstNodePtr parsePass1(const TokenList &tokens) {
    Pass1Parser parser(tokens);
    return parser.parseRoot();
}

AstNodePtr parse(const TokenList &tokens) {
    return parsePass6(parsePass5(parsePass4(parsePass1(tokens))));
}

std::shared_ptr<ProgramNode> parseProgramSource(const QString &source) {
    const AstNodePtr ast = parse(tokenize(source));
    const std::shared_ptr<ProgramNode> program = std::dynamic_pointer_cast<ProgramNode>(ast);
    if (!program) {
        throw std::runtime_error("An .iw file must contain exactly one root {program ...} block");
    }
    return program;
}

}
