// Qt AST viewer core: formatter implementation for the covered subset.
#include "iwformatter.h"

#include <stdexcept>

#include <QStringList>

#include "iwlexer.h"

namespace iw {
namespace {

QString indentText(int depth) {
    return QString(depth * 2, QChar(' '));
}

QString formatInline(const AstNodePtr &node);
QString formatNode(const AstNodePtr &node, int depth);

bool collectMemberChainSegments(const AstNodePtr &node, QStringList &segments) {
    const IdentifierNodePtr identifier = std::dynamic_pointer_cast<IdentifierNode>(node);
    if (identifier) {
        if (!isMemberChainSegmentText(identifier->name())) {
            return false;
        }
        segments.push_back(identifier->name());
        return true;
    }

    const std::shared_ptr<FunctionCallNode> callNode = std::dynamic_pointer_cast<FunctionCallNode>(node);
    if (!callNode) {
        return false;
    }

    const IdentifierNodePtr calleeIdentifier = std::dynamic_pointer_cast<IdentifierNode>(callNode->callee());
    if (!calleeIdentifier || calleeIdentifier->name() != QStringLiteral("cm_get") || callNode->args().size() != 2) {
        return false;
    }

    if (!collectMemberChainSegments(callNode->args().at(0), segments)) {
        return false;
    }

    const IdentifierNodePtr fieldIdentifier = std::dynamic_pointer_cast<IdentifierNode>(callNode->args().at(1));
    if (!fieldIdentifier || !isMemberChainSegmentText(fieldIdentifier->name())) {
        return false;
    }
    segments.push_back(fieldIdentifier->name());
    return true;
}

QString tryFormatMemberChain(const AstNodePtr &node) {
    QStringList segments;
    if (!collectMemberChainSegments(node, segments)) {
        return QString();
    }
    return segments.join(QChar('.'));
}

QString formatList(const AstNodeList &elements, const QString &leftBracket, const QString &rightBracket) {
    QStringList parts;
    for (const AstNodePtr &element : elements) {
        parts.push_back(formatInline(element));
    }
    return leftBracket + parts.join(QChar(' ')) + rightBracket;
}

QString formatParamList(const std::vector<TypeVarBindNodePtr> &params) {
    QStringList parts;
    for (const TypeVarBindNodePtr &param : params) {
        parts.push_back(formatInline(param));
    }
    return QStringLiteral("(") + parts.join(QChar(' ')) + QStringLiteral(")");
}

QString formatInline(const AstNodePtr &node) {
    const IdentifierNodePtr identifier = std::dynamic_pointer_cast<IdentifierNode>(node);
    if (identifier) {
        return identifier->name();
    }

    const std::shared_ptr<TextDatabaseReferenceNode> textReference = std::dynamic_pointer_cast<TextDatabaseReferenceNode>(node);
    if (textReference) {
        return textReference->referenceName();
    }

    const std::shared_ptr<NumberLiteralNode> numberLiteral = std::dynamic_pointer_cast<NumberLiteralNode>(node);
    if (numberLiteral) {
        return numberLiteral->raw();
    }

    const std::shared_ptr<TypeVarBindNode> bindNode = std::dynamic_pointer_cast<TypeVarBindNode>(node);
    if (bindNode) {
        return QStringLiteral("[%1 %2]").arg(bindNode->identifier()->name(), formatInline(bindNode->typeExpression()));
    }

    const std::shared_ptr<GenericCallNode> genericCall = std::dynamic_pointer_cast<GenericCallNode>(node);
    if (genericCall) {
        QStringList parts;
        parts.push_back(formatInline(genericCall->callee()));
        for (const AstNodePtr &typeArg : genericCall->typeArgs()) {
            parts.push_back(formatInline(typeArg));
        }
        return QStringLiteral("<") + parts.join(QChar(' ')) + QStringLiteral(">");
    }

    const std::shared_ptr<FunctionCallNode> functionCall = std::dynamic_pointer_cast<FunctionCallNode>(node);
    if (functionCall) {
        const QString memberChain = tryFormatMemberChain(node);
        if (!memberChain.isEmpty()) {
            return memberChain;
        }
        QStringList parts;
        parts.push_back(formatInline(functionCall->callee()));
        for (const AstNodePtr &arg : functionCall->args()) {
            parts.push_back(formatInline(arg));
        }
        return QStringLiteral("(") + parts.join(QChar(' ')) + QStringLiteral(")");
    }

    const std::shared_ptr<RoundParenListNode> roundList = std::dynamic_pointer_cast<RoundParenListNode>(node);
    if (roundList) {
        return formatList(roundList->elements(), QStringLiteral("("), QStringLiteral(")"));
    }

    const std::shared_ptr<SquareParenListNode> squareList = std::dynamic_pointer_cast<SquareParenListNode>(node);
    if (squareList) {
        return formatList(squareList->elements(), QStringLiteral("["), QStringLiteral("]"));
    }

    const std::shared_ptr<CurlyParenListNode> curlyList = std::dynamic_pointer_cast<CurlyParenListNode>(node);
    if (curlyList) {
        return formatList(curlyList->elements(), QStringLiteral("{"), QStringLiteral("}"));
    }

    const std::shared_ptr<AngleParenListNode> angleList = std::dynamic_pointer_cast<AngleParenListNode>(node);
    if (angleList) {
        return formatList(angleList->elements(), QStringLiteral("<"), QStringLiteral(">"));
    }

    const std::shared_ptr<ProgramNode> programNode = std::dynamic_pointer_cast<ProgramNode>(node);
    if (programNode) {
        return formatNode(node, 0);
    }

    const std::shared_ptr<ExportNode> exportNode = std::dynamic_pointer_cast<ExportNode>(node);
    if (exportNode) {
        return formatNode(node, 0);
    }

    const PublicNodePtr publicNode = std::dynamic_pointer_cast<PublicNode>(node);
    if (publicNode) {
        return formatNode(node, 0);
    }

    const std::shared_ptr<DfunNode> functionNode = std::dynamic_pointer_cast<DfunNode>(node);
    if (functionNode) {
        return formatNode(node, 0);
    }

    const std::shared_ptr<SeqNode> seqNode = std::dynamic_pointer_cast<SeqNode>(node);
    if (seqNode) {
        return formatNode(node, 0);
    }

    throw std::runtime_error("Unsupported AST node in formatter.");
}

QString formatNode(const AstNodePtr &node, int depth) {
    const std::shared_ptr<ProgramNode> programNode = std::dynamic_pointer_cast<ProgramNode>(node);
    if (programNode) {
        QStringList lines;
        QString header = QStringLiteral("{program");
        if (programNode->unitId()) {
            header += QStringLiteral(" ") + programNode->unitId()->name();
        }
        lines.push_back(indentText(depth) + header);
        for (const AstNodePtr &expression : programNode->topLevelExpressions()) {
            lines.push_back(formatNode(expression, depth + 1));
        }
        lines.push_back(indentText(depth) + QStringLiteral("}"));
        return lines.join(QChar('\n'));
    }

    const std::shared_ptr<DfunNode> functionNode = std::dynamic_pointer_cast<DfunNode>(node);
    if (functionNode) {
        const QString head = QStringLiteral("(function %1 %2 to %3 in")
            .arg(functionNode->name()->name(), formatParamList(functionNode->params()), formatInline(functionNode->returnType()));
        if (std::dynamic_pointer_cast<SeqNode>(functionNode->body())) {
            QStringList lines;
            lines.push_back(indentText(depth) + head);
            lines.push_back(formatNode(functionNode->body(), depth + 1));
            lines.push_back(indentText(depth) + QStringLiteral(")"));
            return lines.join(QChar('\n'));
        }
        return indentText(depth) + head + QStringLiteral(" ") + formatInline(functionNode->body()) + QStringLiteral(")");
    }

    const std::shared_ptr<ExportNode> exportNode = std::dynamic_pointer_cast<ExportNode>(node);
    if (exportNode) {
        return indentText(depth) + QStringLiteral("(export ") + formatInline(exportNode->inner()) + QStringLiteral(")");
    }

    const PublicNodePtr publicNode = std::dynamic_pointer_cast<PublicNode>(node);
    if (publicNode) {
        return indentText(depth) + QStringLiteral("(public ") + formatInline(publicNode->inner()) + QStringLiteral(")");
    }

    const std::shared_ptr<SeqNode> seqNode = std::dynamic_pointer_cast<SeqNode>(node);
    if (seqNode) {
        QStringList lines;
        lines.push_back(indentText(depth) + QStringLiteral("{"));
        for (const AstNodePtr &expression : seqNode->expressions()) {
            lines.push_back(formatNode(expression, depth + 1));
        }
        lines.push_back(indentText(depth) + QStringLiteral("}"));
        return lines.join(QChar('\n'));
    }

    return indentText(depth) + formatInline(node);
}

}

QString formatIw(const AstNodePtr &node) {
    return formatNode(node, 0) + QStringLiteral("\n");
}

}
