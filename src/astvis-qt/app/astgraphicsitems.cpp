// GraphicsView-based AST items for the Ironwall AST visualizer.
#include "astgraphicsitems.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <initializer_list>
#include <vector>

#include <QBrush>
#include <QColor>
#include <QCoreApplication>
#include <QDir>
#include <QFont>
#include <QFontDatabase>
#include <QFontMetricsF>
#include <QPainter>
#include <QPainterPath>
#include <QPen>

namespace {

constexpr qreal TRIVIAL_LITERAL_BORDER_WIDTH = 1.0;
constexpr qreal TRIVIAL_LITERAL_X_PADDING = 0.0;
constexpr qreal TRIVIAL_LITERAL_Y_PADDING = 0.0;
constexpr qreal STRUCTURED_PADDING = 0.0;
constexpr qreal HEADER_X_PADDING = 0.0;
constexpr qreal HEADER_Y_PADDING = 0.0;
constexpr qreal COLUMN_GAP = 20.0;
constexpr qreal ROW_GAP = 4.0;
constexpr qreal MIN_BODY_WIDTH = 72.0;
constexpr qreal CALL_BOX_X_PADDING = 0.0;
constexpr qreal CALL_BOX_Y_PADDING = 0.0;
constexpr qreal CALL_PLACEHOLDER_SIZE = 20.0;
constexpr qreal CALL_INLINE_EXTRACTION_WIDTH_LIMIT = 360.0;
constexpr qreal CALL_INLINE_EXTRACTION_AREA_LIMIT = 12000.0;
constexpr qreal CALL_OUTER_MARGIN = 0.0;
constexpr qreal CALL_DETAIL_Y_GAP = 12.0;
constexpr qreal CALL_DETAIL_ROW_GAP = 6.0;
constexpr qreal CALL_BLOCK_INDENT = 24.0;
constexpr qreal CALL_BLOCK_TARGET_GAP = 14.0;
constexpr qreal CALL_ROUTE_FANOUT_GAP = 10.0;
constexpr qreal CALL_ROUTE_LANE_GAP = 14.0;
constexpr qreal CALL_ROUTE_TO_DETAIL_GAP = 14.0;
constexpr qreal FUNCTION_CARD_PADDING = 0.0;
constexpr qreal FUNCTION_CARD_GAP = 4.0;
constexpr qreal FUNCTION_SIGNATURE_PANEL_PADDING = 0.0;
constexpr qreal FUNCTION_SIGNATURE_LABEL_GAP = 4.0;
constexpr qreal FUNCTION_SIGNATURE_FORMULA_GAP = 4.0;
constexpr qreal FUNCTION_SIGNATURE_LINE_GAP = 2.0;
constexpr qreal FUNCTION_SIGNATURE_BLOCK_INDENT = 8.0;
constexpr qreal FUNCTION_SIGNATURE_HANGING_INDENT = 16.0;
constexpr qreal FUNCTION_SIGNATURE_MIN_WIDTH = 220.0;
constexpr qreal FUNCTION_SIGNATURE_INLINE_WIDTH_LIMIT = 440.0;
constexpr qreal INLINE_FORMULA_X_PADDING = 0.0;
constexpr qreal INLINE_FORMULA_Y_PADDING = 0.0;
constexpr qreal ASSIGNMENT_PADDING = 0.0;
constexpr qreal ASSIGNMENT_PLACEHOLDER_SIZE = 18.0;
constexpr qreal ASSIGNMENT_DETAIL_X_GAP = 28.0;
constexpr qreal ASSIGNMENT_DETAIL_Y_GAP = 24.0;
constexpr qreal ASSIGNMENT_INLINE_VALUE_WIDTH_LIMIT = 360.0;
constexpr qreal ASSIGNMENT_INLINE_VALUE_AREA_LIMIT = 12000.0;
constexpr qreal BRACKET_BLOCK_PADDING = 0.0;
constexpr qreal BRACKET_BLOCK_VERTICAL_MARGIN = 10.0;
constexpr qreal BRACKET_BLOCK_ENTRY_GAP = 3.0;
constexpr qreal BRACKET_BLOCK_INDENT = 16.0;
constexpr qreal BRACKET_BLOCK_BRACKET_GAP = 0.0;
constexpr qreal BRACKET_BLOCK_HOOK = 10.0;
constexpr qreal PROGRAM_ENTRY_SEPARATOR_MARGIN = 2.0;
constexpr qreal PROGRAM_ENTRY_GAP = 14.0;
constexpr qreal BRANCH_LEAD_BOX_MARGIN = 3.0;
constexpr qreal LINKED_BRANCH_INDENT = 16.0;
constexpr qreal LINKED_BRANCH_ROW_GAP = 14.0;
constexpr qreal LINKED_BRANCH_TARGET_GAP = 4.0;
constexpr qreal LINKED_BRANCH_EXIT_RUNOUT = 8.0;
constexpr qreal IMPORT_BRACKET_GAP = 6.0;
constexpr qreal IMPORT_BRACKET_HOOK = 8.0;
constexpr qreal AST_FONT_POINT_SIZE = 14.0;
constexpr qreal NODE_CONNECTION_PORT_OFFSET = 4.0;
constexpr qreal STRUCTURED_CONNECTOR_VERTICAL_GAP = 8.0;
constexpr qreal STRUCTURED_CONNECTOR_TARGET_GAP = 12.0;
constexpr qreal ORTHOGONAL_ROUTE_EPSILON = 0.01;
constexpr qreal ORTHOGONAL_ROUTE_HUMP_HALF_WIDTH = 4.0;
constexpr qreal ORTHOGONAL_ROUTE_HUMP_HEIGHT = 3.0;

QString g_selectedMathFontFamily;
QHash<QString, QString> g_literalReferenceDisplayTexts;
LiteralDisplayOptions g_literalDisplayOptions;
AstVisTheme g_astVisTheme{
    Qt::white,
    Qt::black,
    QColor(0, 0, 255),
    QColor(0, 170, 127),
    Qt::red,
    QColor(234, 88, 12),
    Qt::red
};

struct OrthogonalRoute final {
    std::vector<QPointF> points;
};

struct OrthogonalRouteSegment final {
    QPointF start;
    QPointF end;
    int routeIndex = 0;
    int segmentIndex = 0;
};

QString escapeLiteralDisplayText(const QString &text);

QString literalDisplayTextForNode(const std::shared_ptr<iw::TextDatabaseReferenceNode> &textNode) {
    const QString referenceName = textNode->referenceName();
    QString text;
    if (g_literalDisplayOptions.showReferenceName) {
        text = referenceName;
    } else if (g_literalReferenceDisplayTexts.contains(referenceName)) {
        text = g_literalReferenceDisplayTexts.value(referenceName);
    } else {
        text = textNode->entryName();
    }
    const qsizetype originalLength = text.size();
    if (!g_literalDisplayOptions.showFullText
        && g_literalDisplayOptions.truncateLength > 0
        && text.size() > g_literalDisplayOptions.truncateLength) {
        text = text.left(g_literalDisplayOptions.truncateLength) + QStringLiteral("...");
    }
    if (!g_literalDisplayOptions.renderControlCharacters) {
        text = escapeLiteralDisplayText(text);
    }
    return QStringLiteral("%1: %2")
        .arg(QString::number(originalLength), text);
}

QString escapedLiteralDisplayTextForNode(const std::shared_ptr<iw::TextDatabaseReferenceNode> &textNode) {
    return escapeLiteralDisplayText(literalDisplayTextForNode(textNode));
}

QColor astTextColor() {
    return g_astVisTheme.textColor;
}

QColor astKeywordColor() {
    return g_astVisTheme.keywordColor;
}

QColor astTypeColor() {
    return g_astVisTheme.typeColor;
}

QColor astNumberColor() {
    return g_astVisTheme.numberColor;
}

QColor astStringColor() {
    return g_astVisTheme.stringColor;
}

QColor astLogicalKeywordColor() {
    return g_astVisTheme.logicalKeywordColor;
}

QColor astBackgroundColor() {
    return g_astVisTheme.backgroundColor;
}

bool nearlyEqual(qreal left, qreal right) {
    return std::abs(left - right) <= ORTHOGONAL_ROUTE_EPSILON;
}

bool isHorizontalSegment(const OrthogonalRouteSegment &segment) {
    return nearlyEqual(segment.start.y(), segment.end.y())
        && !nearlyEqual(segment.start.x(), segment.end.x());
}

bool isVerticalSegment(const OrthogonalRouteSegment &segment) {
    return nearlyEqual(segment.start.x(), segment.end.x())
        && !nearlyEqual(segment.start.y(), segment.end.y());
}

qreal segmentMinX(const OrthogonalRouteSegment &segment) {
    return std::min(segment.start.x(), segment.end.x());
}

qreal segmentMaxX(const OrthogonalRouteSegment &segment) {
    return std::max(segment.start.x(), segment.end.x());
}

qreal segmentMinY(const OrthogonalRouteSegment &segment) {
    return std::min(segment.start.y(), segment.end.y());
}

qreal segmentMaxY(const OrthogonalRouteSegment &segment) {
    return std::max(segment.start.y(), segment.end.y());
}

std::vector<QPointF> compactRoutePoints(std::initializer_list<QPointF> inputPoints) {
    std::vector<QPointF> points;
    points.reserve(inputPoints.size());
    for (const QPointF &point : inputPoints) {
        if (!points.empty()
            && nearlyEqual(points.back().x(), point.x())
            && nearlyEqual(points.back().y(), point.y())) {
            continue;
        }
        points.push_back(point);
    }

    std::vector<QPointF> compacted;
    compacted.reserve(points.size());
    for (const QPointF &point : points) {
        compacted.push_back(point);
        while (compacted.size() >= 3) {
            const QPointF &a = compacted.at(compacted.size() - 3);
            const QPointF &b = compacted.at(compacted.size() - 2);
            const QPointF &c = compacted.at(compacted.size() - 1);
            const bool horizontal = nearlyEqual(a.y(), b.y()) && nearlyEqual(b.y(), c.y());
            const bool vertical = nearlyEqual(a.x(), b.x()) && nearlyEqual(b.x(), c.x());
            if (!horizontal && !vertical) {
                break;
            }
            compacted.erase(compacted.end() - 2);
        }
    }
    return compacted;
}

std::vector<QPointF> routePointsForExtractedBlock(
    const QPointF &start,
    qreal approachX,
    qreal fanoutY,
    const QPointF &target) {
    return compactRoutePoints({
        start,
        QPointF(start.x(), fanoutY),
        QPointF(approachX, fanoutY),
        QPointF(approachX, target.y()),
        target,
    });
}

std::vector<QPointF> routePointsFromExitToTarget(
    const QPointF &start,
    qreal runoutX,
    qreal approachX,
    qreal fanoutY,
    const QPointF &target) {
    return compactRoutePoints({
        start,
        QPointF(runoutX, start.y()),
        QPointF(runoutX, fanoutY),
        QPointF(approachX, fanoutY),
        QPointF(approachX, target.y()),
        target,
    });
}

std::vector<OrthogonalRouteSegment> routeSegmentsForRoutes(const std::vector<OrthogonalRoute> &routes) {
    std::vector<OrthogonalRouteSegment> segments;
    for (std::size_t routeIndex = 0; routeIndex < routes.size(); routeIndex += 1) {
        const OrthogonalRoute &route = routes.at(routeIndex);
        for (std::size_t pointIndex = 1; pointIndex < route.points.size(); pointIndex += 1) {
            OrthogonalRouteSegment segment;
            segment.start = route.points.at(pointIndex - 1);
            segment.end = route.points.at(pointIndex);
            segment.routeIndex = static_cast<int>(routeIndex);
            segment.segmentIndex = static_cast<int>(pointIndex - 1);
            segments.push_back(segment);
        }
    }
    return segments;
}

bool hasInteriorIntersection(const OrthogonalRouteSegment &horizontal, const OrthogonalRouteSegment &vertical, QPointF *intersectionOut) {
    if (!isHorizontalSegment(horizontal) || !isVerticalSegment(vertical)) {
        return false;
    }
    if (horizontal.routeIndex == vertical.routeIndex) {
        return false;
    }

    const qreal x = vertical.start.x();
    const qreal y = horizontal.start.y();
    const qreal horizontalMargin = ORTHOGONAL_ROUTE_HUMP_HALF_WIDTH + 0.5;
    const qreal verticalMargin = ORTHOGONAL_ROUTE_HUMP_HEIGHT + 0.5;
    if (x <= segmentMinX(horizontal) + horizontalMargin || x >= segmentMaxX(horizontal) - horizontalMargin) {
        return false;
    }
    if (y <= segmentMinY(vertical) + verticalMargin || y >= segmentMaxY(vertical) - verticalMargin) {
        return false;
    }
    if (intersectionOut) {
        *intersectionOut = QPointF(x, y);
    }
    return true;
}

std::vector<qreal> routeHumpsForHorizontalSegment(
    const OrthogonalRouteSegment &horizontal,
    const std::vector<OrthogonalRouteSegment> &segments) {
    std::vector<qreal> crossings;
    for (const OrthogonalRouteSegment &candidate : segments) {
        QPointF intersection;
        if (hasInteriorIntersection(horizontal, candidate, &intersection)) {
            crossings.push_back(intersection.x());
        }
    }

    if (horizontal.end.x() >= horizontal.start.x()) {
        std::sort(crossings.begin(), crossings.end());
    } else {
        std::sort(crossings.begin(), crossings.end(), std::greater<qreal>());
    }
    crossings.erase(
        std::unique(
            crossings.begin(),
            crossings.end(),
            [](qreal left, qreal right) { return nearlyEqual(left, right); }),
        crossings.end());
    return crossings;
}

void appendHorizontalSegmentWithHumps(
    QPainterPath &path,
    const OrthogonalRouteSegment &segment,
    const std::vector<qreal> &crossings) {
    const qreal y = segment.start.y();
    const qreal direction = segment.end.x() >= segment.start.x() ? 1.0 : -1.0;
    for (qreal crossingX : crossings) {
        path.lineTo(QPointF(crossingX - (direction * ORTHOGONAL_ROUTE_HUMP_HALF_WIDTH), y));
        path.quadTo(
            QPointF(crossingX, y - ORTHOGONAL_ROUTE_HUMP_HEIGHT),
            QPointF(crossingX + (direction * ORTHOGONAL_ROUTE_HUMP_HALF_WIDTH), y));
    }
    path.lineTo(segment.end);
}

void paintOrthogonalRoutes(QPainter *painter, const std::vector<OrthogonalRoute> &routes, const QPen &routePen) {
    if (routes.empty()) {
        return;
    }

    const std::vector<OrthogonalRouteSegment> segments = routeSegmentsForRoutes(routes);
    QPen pen(routePen);
    pen.setCapStyle(Qt::FlatCap);
    painter->save();
    painter->setPen(pen);
    painter->setBrush(Qt::NoBrush);

    for (const OrthogonalRouteSegment &segment : segments) {
        if (isVerticalSegment(segment)) {
            painter->drawLine(segment.start, segment.end);
        }
    }

    for (const OrthogonalRouteSegment &segment : segments) {
        if (!isHorizontalSegment(segment)) {
            continue;
        }
        QPainterPath path;
        path.moveTo(segment.start);
        appendHorizontalSegmentWithHumps(path, segment, routeHumpsForHorizontalSegment(segment, segments));
        painter->drawPath(path);
    }

    painter->setPen(Qt::NoPen);
    painter->setBrush(Qt::black);
    for (const OrthogonalRoute &route : routes) {
        if (route.points.empty()) {
            continue;
        }
        painter->drawEllipse(route.points.front(), 2.0, 2.0);
        painter->drawEllipse(route.points.back(), 2.0, 2.0);
    }

    painter->restore();
}

QColor colorForNodeType(iw::AstNodeType nodeType) {
    switch (nodeType) {
    case iw::AstNodeType::IdentifierNode:
        return astTextColor();
    case iw::AstNodeType::TextDatabaseReferenceNode:
        return astStringColor();
    case iw::AstNodeType::NumberLiteralNode:
        return astNumberColor();
    default:
        break;
    }

    return astTextColor();
}

bool itemExceedsInlineLimits(const AstGraphicsItem *item, qreal widthLimit, qreal areaLimit) {
    if (!item) {
        return false;
    }
    const QRectF bounds = item->boundingRect();
    return bounds.width() > widthLimit || (bounds.width() * bounds.height()) > areaLimit;
}

bool isLiteralNodeType(iw::AstNodeType nodeType) {
    return nodeType == iw::AstNodeType::TextDatabaseReferenceNode;
}

bool isTrivialDisplayNodeType(iw::AstNodeType nodeType) {
    return nodeType == iw::AstNodeType::IdentifierNode
        || nodeType == iw::AstNodeType::TextDatabaseReferenceNode
        || nodeType == iw::AstNodeType::NumberLiteralNode;
}

bool isInlineFormulaNodeType(iw::AstNodeType nodeType) {
    return nodeType == iw::AstNodeType::TypeVarBindNode
        || nodeType == iw::AstNodeType::TypeToFromNode
        || nodeType == iw::AstNodeType::TypeUnionNode
        || nodeType == iw::AstNodeType::GenericCallNode;
}

QString escapeLiteralDisplayText(const QString &text) {
    QString escaped = text;
    escaped.replace(QChar('\\'), QStringLiteral("\\\\"));
    escaped.replace(QChar('"'), QStringLiteral("\\\""));
    escaped.replace(QChar('\n'), QStringLiteral("\\n"));
    escaped.replace(QChar('\r'), QStringLiteral("\\r"));
    escaped.replace(QChar('\t'), QStringLiteral("\\t"));
    return escaped;
}

QString formatDisplayNumber(double value) {
    if (std::isnan(value)) {
        return QStringLiteral("nan");
    }
    if (std::isinf(value)) {
        return value < 0.0 ? QStringLiteral("-inf") : QStringLiteral("inf");
    }

    QString text = QString::number(value, 'g', 15);
    if (text == QStringLiteral("-0")) {
        return QStringLiteral("0");
    }
    return text;
}

QString formatDisplayNumber(const iw::NumericLiteralValue &value) {
    if (!value.isComplex()) {
        return formatDisplayNumber(value.number());
    }

    const iw::ComplexLiteralValue &complex = value.complex();
    const QString realText = formatDisplayNumber(complex.real());
    const QString imagMagnitudeText = formatDisplayNumber(std::fabs(complex.imag()));
    const bool imagNegative = std::signbit(complex.imag()) && !std::isnan(complex.imag());
    const QString separator = imagNegative ? QStringLiteral(" - ") : QStringLiteral(" + ");
    return realText + separator + imagMagnitudeText + QStringLiteral("i");
}

QString signatureTextForAstNode(const iw::AstNodePtr &node);

QString joinSignatureParts(const QStringList &parts, const QString &separator, const QString &emptyValue = QStringLiteral("none")) {
    if (parts.isEmpty()) {
        return emptyValue;
    }
    return parts.join(separator);
}

QString signatureTextForList(const iw::AstNodeList &elements, const QString &left, const QString &right, const QString &separator) {
    QStringList partTexts;
    partTexts.reserve(static_cast<qsizetype>(elements.size()));
    for (const iw::AstNodePtr &element : elements) {
        partTexts.push_back(signatureTextForAstNode(element));
    }
    if (partTexts.isEmpty()) {
        return left + right;
    }
    return left + partTexts.join(separator) + right;
}

QString signatureTextForTypeVarBind(const iw::TypeVarBindNodePtr &bind) {
    return QStringLiteral("%1 : %2").arg(bind->identifier()->name(), signatureTextForAstNode(bind->typeExpression()));
}

bool shouldWrapGenericCallCalleeText(const iw::AstNodePtr &callee) {
    if (!callee) {
        return false;
    }

    switch (callee->type()) {
    case iw::AstNodeType::IdentifierNode:
    case iw::AstNodeType::GenericNameNode:
    case iw::AstNodeType::GenericCallNode:
        return false;
    default:
        return true;
    }
}

QString signatureTextForGenericCall(const std::shared_ptr<iw::GenericCallNode> &genericCall) {
    QString calleeText = signatureTextForAstNode(genericCall->callee());
    if (shouldWrapGenericCallCalleeText(genericCall->callee())) {
        calleeText = QStringLiteral("(%1)").arg(calleeText);
    }

    QStringList typeArgTexts;
    typeArgTexts.reserve(static_cast<qsizetype>(genericCall->typeArgs().size()));
    for (const iw::AstNodePtr &typeArg : genericCall->typeArgs()) {
        typeArgTexts.push_back(signatureTextForAstNode(typeArg));
    }
    return QStringLiteral("%1\u27e8%2\u27e9")
        .arg(calleeText, joinSignatureParts(typeArgTexts, QStringLiteral(", "), QString()));
}

QString inlineMathTextForNode(const iw::AstNodePtr &node) {
    if (!node) {
        return QStringLiteral("unknown");
    }
    if (const iw::IdentifierNodePtr identifierNode = std::dynamic_pointer_cast<iw::IdentifierNode>(node)) {
        return identifierNode->name();
    }
    if (const std::shared_ptr<iw::TextDatabaseReferenceNode> textNode = std::dynamic_pointer_cast<iw::TextDatabaseReferenceNode>(node)) {
        return escapedLiteralDisplayTextForNode(textNode);
    }
    if (const std::shared_ptr<iw::NumberLiteralNode> numberNode = std::dynamic_pointer_cast<iw::NumberLiteralNode>(node)) {
        return formatDisplayNumber(numberNode->value());
    }
    return signatureTextForAstNode(node);
}

bool canRenderNodeAsInlineMathText(const iw::AstNodePtr &node);
bool canRenderNodeAsInlineMathItem(const iw::AstNodePtr &node);

bool isCondElseClause(const iw::AstNodePtr &node) {
    const iw::IdentifierNodePtr identifier = std::dynamic_pointer_cast<iw::IdentifierNode>(node);
    return identifier != nullptr && identifier->name() == QStringLiteral("else");
}

bool canRenderNodeAsInlineMathLayout(const iw::AstNodePtr &node) {
    return canRenderNodeAsInlineMathText(node) || canRenderNodeAsInlineMathItem(node);
}

bool canRenderNodeAsInlineMathText(const iw::AstNodePtr &node) {
    if (!node) {
        return false;
    }

    if (node->type() == iw::AstNodeType::TextDatabaseReferenceNode) {
        return false;
    }

    return isTrivialDisplayNodeType(node->type())
        || node->type() == iw::AstNodeType::GenericNameNode;
}

bool canRenderNodeAsInlineMathItem(const iw::AstNodePtr &node) {
    if (!node) {
        return false;
    }

    if (isInlineFormulaNodeType(node->type())) {
        return true;
    }
    if (node->type() == iw::AstNodeType::TextDatabaseReferenceNode) {
        return true;
    }

    if (const std::shared_ptr<iw::FunctionCallNode> callNode = std::dynamic_pointer_cast<iw::FunctionCallNode>(node)) {
        if (!canRenderNodeAsInlineMathLayout(callNode->callee())) {
            return false;
        }
        for (const iw::AstNodePtr &argument : callNode->args()) {
            if (!canRenderNodeAsInlineMathLayout(argument)) {
                return false;
            }
        }
        return true;
    }

    return false;
}

bool canRenderNodeAsInlineAssignmentText(const iw::AstNodePtr &node) {
    return canRenderNodeAsInlineMathText(node);
}

QString inlineAssignmentTextForNode(const iw::AstNodePtr &node) {
    return inlineMathTextForNode(node);
}

struct BuiltinOperatorInfo final {
    QString name;
    QString symbol;
    int precedence = 0;
    bool associative = false;
    bool wrapLeftOnEqualPrecedence = false;
    bool wrapRightOnEqualPrecedence = false;
};

enum class SpecialCallSyntax {
    None,
    IndexGet,
    IndexSet,
    MemberGet,
    MemberSet,
};

const BuiltinOperatorInfo *builtinOperatorInfoForName(const QString &name) {
    static const BuiltinOperatorInfo add{QStringLiteral("add"), QStringLiteral("+"), 70, true, false, true};
    static const BuiltinOperatorInfo sub{QStringLiteral("sub"), QStringLiteral("-"), 70, false, false, true};
    static const BuiltinOperatorInfo mul{QStringLiteral("mul"), QStringLiteral("\u00d7"), 80, true, false, true};
    static const BuiltinOperatorInfo div{QStringLiteral("div"), QStringLiteral("/"), 80, false, false, true};
    static const BuiltinOperatorInfo mod{QStringLiteral("mod"), QStringLiteral("%"), 80, false, false, true};
    static const BuiltinOperatorInfo le{QStringLiteral("le"), QStringLiteral("\u2264"), 50, false, true, true};
    static const BuiltinOperatorInfo lt{QStringLiteral("lt"), QStringLiteral("<"), 50, false, true, true};
    static const BuiltinOperatorInfo ge{QStringLiteral("ge"), QStringLiteral("\u2265"), 50, false, true, true};
    static const BuiltinOperatorInfo gt{QStringLiteral("gt"), QStringLiteral(">"), 50, false, true, true};
    static const BuiltinOperatorInfo eq{QStringLiteral("eq"), QStringLiteral("=="), 45, false, true, true};
    static const BuiltinOperatorInfo neq{QStringLiteral("neq"), QStringLiteral("\u2260"), 45, false, true, true};
    static const BuiltinOperatorInfo logicalAnd{QStringLiteral("and"), QStringLiteral(" and "), 30, true, false, false};
    static const BuiltinOperatorInfo logicalOr{QStringLiteral("or"), QStringLiteral(" or "), 20, true, false, false};
    static const BuiltinOperatorInfo logicalXor{QStringLiteral("xor"), QStringLiteral(" xor "), 25, true, false, false};
    static const BuiltinOperatorInfo logicalNot{QStringLiteral("not"), QStringLiteral("not "), 90, false, false, true};
    static const BuiltinOperatorInfo bitwiseAnd{QStringLiteral("bwand"), QStringLiteral("&"), 40, true, false, false};
    static const BuiltinOperatorInfo bitwiseOr{QStringLiteral("bwor"), QStringLiteral("|"), 38, true, false, false};
    static const BuiltinOperatorInfo bitwiseXor{QStringLiteral("bwxor"), QStringLiteral("^"), 39, true, false, false};
    static const BuiltinOperatorInfo shiftLeft{QStringLiteral("ls"), QStringLiteral("<<"), 60, false, false, true};
    static const BuiltinOperatorInfo shiftRight{QStringLiteral("rs"), QStringLiteral(">>"), 60, false, false, true};

    const BuiltinOperatorInfo *infos[] = {
        &add,
        &sub,
        &mul,
        &div,
        &mod,
        &le,
        &lt,
        &ge,
        &gt,
        &eq,
        &neq,
        &logicalAnd,
        &logicalOr,
        &logicalXor,
        &logicalNot,
        &bitwiseAnd,
        &bitwiseOr,
        &bitwiseXor,
        &shiftLeft,
        &shiftRight,
    };

    for (const BuiltinOperatorInfo *info : infos) {
        if (info->name == name) {
            return info;
        }
    }
    return nullptr;
}

bool isIndexGetBuiltinName(const QString &name) {
    return name == QStringLiteral("array_get")
        || name == QStringLiteral("s3_get")
        || name == QStringLiteral("s4_get")
        || name == QStringLiteral("s5_get");
}

bool isIndexSetBuiltinName(const QString &name) {
    return name == QStringLiteral("array_set")
        || name == QStringLiteral("s3_set")
        || name == QStringLiteral("s4_set")
        || name == QStringLiteral("s5_set");
}

QString functionCallCalleeName(const std::shared_ptr<iw::FunctionCallNode> &callNode) {
    if (!callNode) {
        return QString();
    }
    const iw::IdentifierNodePtr calleeIdentifier = std::dynamic_pointer_cast<iw::IdentifierNode>(callNode->callee());
    return calleeIdentifier ? calleeIdentifier->name() : QString();
}

const BuiltinOperatorInfo *builtinOperatorInfoForCall(const std::shared_ptr<iw::FunctionCallNode> &callNode) {
    if (!callNode) {
        return nullptr;
    }

    const QString calleeName = functionCallCalleeName(callNode);
    if (calleeName == QStringLiteral("not")) {
        return callNode->args().size() == 1 ? builtinOperatorInfoForName(calleeName) : nullptr;
    }
    if (callNode->args().size() < 2) {
        return nullptr;
    }

    return builtinOperatorInfoForName(calleeName);
}

const BuiltinOperatorInfo *builtinOperatorInfoForNode(const iw::AstNodePtr &node) {
    return builtinOperatorInfoForCall(std::dynamic_pointer_cast<iw::FunctionCallNode>(node));
}

SpecialCallSyntax specialCallSyntaxForCall(const std::shared_ptr<iw::FunctionCallNode> &callNode) {
    const QString calleeName = functionCallCalleeName(callNode);
    if (calleeName.isEmpty()) {
        return SpecialCallSyntax::None;
    }

    if (isIndexGetBuiltinName(calleeName) && callNode->args().size() == 2) {
        return SpecialCallSyntax::IndexGet;
    }
    if (isIndexSetBuiltinName(calleeName) && callNode->args().size() == 3) {
        return SpecialCallSyntax::IndexSet;
    }
    if (calleeName == QStringLiteral("cm_get") && callNode->args().size() >= 2) {
        return SpecialCallSyntax::MemberGet;
    }
    if (calleeName == QStringLiteral("cm_set") && callNode->args().size() == 3) {
        return SpecialCallSyntax::MemberSet;
    }
    return SpecialCallSyntax::None;
}

SpecialCallSyntax specialCallSyntaxForNode(const iw::AstNodePtr &node) {
    return specialCallSyntaxForCall(std::dynamic_pointer_cast<iw::FunctionCallNode>(node));
}

bool isLogicalOperatorName(const QString &name) {
    return name == QStringLiteral("and")
        || name == QStringLiteral("or")
        || name == QStringLiteral("xor")
        || name == QStringLiteral("not");
}

int expressionPrecedenceForNode(const iw::AstNodePtr &node) {
    if (const BuiltinOperatorInfo *info = builtinOperatorInfoForNode(node)) {
        return info->precedence;
    }

    switch (specialCallSyntaxForNode(node)) {
    case SpecialCallSyntax::IndexGet:
    case SpecialCallSyntax::MemberGet:
        return 100;
    case SpecialCallSyntax::IndexSet:
    case SpecialCallSyntax::MemberSet:
        return 5;
    case SpecialCallSyntax::None:
        break;
    }
    return 1000;
}

bool shouldWrapBuiltinOperatorArgument(
    const BuiltinOperatorInfo &parentInfo,
    const iw::AstNodePtr &argument,
    bool rightArgument) {
    const BuiltinOperatorInfo *childInfo = builtinOperatorInfoForNode(argument);
    if (expressionPrecedenceForNode(argument) < parentInfo.precedence) {
        return true;
    }
    if (!childInfo || childInfo->precedence > parentInfo.precedence) {
        return false;
    }
    if (parentInfo.associative && childInfo->name == parentInfo.name) {
        return false;
    }
    return rightArgument
        ? parentInfo.wrapRightOnEqualPrecedence
        : parentInfo.wrapLeftOnEqualPrecedence;
}

bool shouldWrapSpecialCallArgument(
    SpecialCallSyntax syntax,
    const iw::AstNodePtr &argument,
    std::size_t argumentIndex) {
    switch (syntax) {
    case SpecialCallSyntax::IndexGet:
    case SpecialCallSyntax::IndexSet:
    case SpecialCallSyntax::MemberGet:
    case SpecialCallSyntax::MemberSet:
        if (argumentIndex == 0) {
            return expressionPrecedenceForNode(argument) < 100;
        }
        return syntax == SpecialCallSyntax::MemberGet
            && expressionPrecedenceForNode(argument) < 100;
    case SpecialCallSyntax::None:
        return false;
    }
    return false;
}

struct SignatureParamData final {
    QString name;
    iw::AstNodePtr typeNode;
    QString typeText;
};

SignatureParamData signatureParamDataForTypeVarBind(const iw::TypeVarBindNodePtr &bind) {
    return SignatureParamData{bind->identifier()->name(), bind->typeExpression(), signatureTextForAstNode(bind->typeExpression())};
}

QString signatureTextForAstNode(const iw::AstNodePtr &node) {
    if (!node) {
        return QStringLiteral("unknown");
    }
    if (const iw::IdentifierNodePtr identifier = std::dynamic_pointer_cast<iw::IdentifierNode>(node)) {
        return identifier->name();
    }
    if (const std::shared_ptr<iw::TextDatabaseReferenceNode> textReference = std::dynamic_pointer_cast<iw::TextDatabaseReferenceNode>(node)) {
        return escapedLiteralDisplayTextForNode(textReference);
    }
    if (const std::shared_ptr<iw::NumberLiteralNode> numberLiteral = std::dynamic_pointer_cast<iw::NumberLiteralNode>(node)) {
        return formatDisplayNumber(numberLiteral->value());
    }
    if (const std::shared_ptr<iw::TypeVarBindNode> bindNode = std::dynamic_pointer_cast<iw::TypeVarBindNode>(node)) {
        return signatureTextForTypeVarBind(bindNode);
    }
    if (const iw::GenericNameNodePtr genericName = std::dynamic_pointer_cast<iw::GenericNameNode>(node)) {
        QStringList genericArgs;
        genericArgs.reserve(static_cast<qsizetype>(genericName->genericTypeArgs().size()));
        for (const iw::IdentifierNodePtr &genericArg : genericName->genericTypeArgs()) {
            genericArgs.push_back(genericArg->name());
        }
        if (genericArgs.isEmpty()) {
            return genericName->name()->name();
        }
        return QStringLiteral("%1\u27e8%2\u27e9").arg(genericName->name()->name(), genericArgs.join(QStringLiteral(", ")));
    }
    if (const std::shared_ptr<iw::AngleParenListNode> angleList = std::dynamic_pointer_cast<iw::AngleParenListNode>(node)) {
        return signatureTextForList(angleList->elements(), QStringLiteral("\u27e8"), QStringLiteral("\u27e9"), QStringLiteral(", "));
    }
    if (const std::shared_ptr<iw::SquareParenListNode> squareList = std::dynamic_pointer_cast<iw::SquareParenListNode>(node)) {
        return signatureTextForList(squareList->elements(), QStringLiteral("["), QStringLiteral("]"), QStringLiteral(" "));
    }
    if (const std::shared_ptr<iw::RoundParenListNode> roundList = std::dynamic_pointer_cast<iw::RoundParenListNode>(node)) {
        return signatureTextForList(roundList->elements(), QStringLiteral("("), QStringLiteral(")"), QStringLiteral(", "));
    }
    if (const std::shared_ptr<iw::CurlyParenListNode> curlyList = std::dynamic_pointer_cast<iw::CurlyParenListNode>(node)) {
        return signatureTextForList(curlyList->elements(), QStringLiteral("{"), QStringLiteral("}"), QStringLiteral(", "));
    }
    if (const std::shared_ptr<iw::TypeToFromNode> typeToFrom = std::dynamic_pointer_cast<iw::TypeToFromNode>(node)) {
        QStringList paramTypes;
        for (const iw::AstNodePtr &paramType : typeToFrom->paramTypes()) {
            paramTypes.push_back(signatureTextForAstNode(paramType));
        }
        return QStringLiteral("(%1) \u2192 %2")
            .arg(joinSignatureParts(paramTypes, QStringLiteral(", "), QString()),
                 signatureTextForAstNode(typeToFrom->returnType()));
    }
    if (const std::shared_ptr<iw::TypeUnionNode> unionNode = std::dynamic_pointer_cast<iw::TypeUnionNode>(node)) {
        QStringList parts;
        for (const iw::AstNodePtr &memberType : unionNode->types()) {
            parts.push_back(signatureTextForAstNode(memberType));
        }
        return joinSignatureParts(parts, QStringLiteral(" \u2223 "));
    }
    if (const std::shared_ptr<iw::GenericCallNode> genericCall = std::dynamic_pointer_cast<iw::GenericCallNode>(node)) {
        return signatureTextForGenericCall(genericCall);
    }
    return node->summaryText();
}

std::vector<SignatureParamData> signatureParamDataList(const std::vector<iw::TypeVarBindNodePtr> &params) {
    std::vector<SignatureParamData> paramData;
    paramData.reserve(params.size());
    for (const iw::TypeVarBindNodePtr &param : params) {
        paramData.push_back(signatureParamDataForTypeVarBind(param));
    }
    return paramData;
}

struct FunctionSignatureCardData final {
    QString label;
    QString displayName;
    std::vector<SignatureParamData> params;
    iw::AstNodePtr returnTypeNode;
    QString returnTypeText;
};

FunctionSignatureCardData buildFunctionSignatureCardData(const QString &label, const QString &displayName, const std::vector<iw::TypeVarBindNodePtr> &params, const iw::AstNodePtr &returnType) {
    return FunctionSignatureCardData{label, displayName, signatureParamDataList(params), returnType, signatureTextForAstNode(returnType)};
}

QString findAncestorDirectoryContaining(const QString &startPath, const QString &childName) {
    if (startPath.isEmpty()) {
        return QString();
    }

    QDir directory(startPath);
    while (true) {
        if (directory.exists(childName)) {
            return directory.filePath(childName);
        }
        if (!directory.cdUp()) {
            break;
        }
    }
    return QString();
}

QString mathFontDirectoryPath() {
    QString fontPath = findAncestorDirectoryContaining(QCoreApplication::applicationDirPath(), QStringLiteral("math-font"));
    if (!fontPath.isEmpty()) {
        return fontPath;
    }
    return findAncestorDirectoryContaining(QDir::currentPath(), QStringLiteral("math-font"));
}

QStringList loadedMathFontFamilies() {
    static const QStringList families = []() {
        QStringList loadedFamilies;
        const QString fontDirectoryPath = mathFontDirectoryPath();
        if (!fontDirectoryPath.isEmpty()) {
            const QDir fontDirectory(fontDirectoryPath);
            const QStringList fontFiles = fontDirectory.entryList({QStringLiteral("*.ttf"), QStringLiteral("*.otf")}, QDir::Files, QDir::Name);
            for (const QString &fontFile : fontFiles) {
                const int fontId = QFontDatabase::addApplicationFont(fontDirectory.filePath(fontFile));
                if (fontId >= 0) {
                    loadedFamilies.append(QFontDatabase::applicationFontFamilies(fontId));
                }
            }
            loadedFamilies.removeDuplicates();
        }
        loadedFamilies.sort(Qt::CaseInsensitive);
        return loadedFamilies;
    }();
    return families;
}

QString defaultMathFontFamily() {
    const QStringList loadedFamilies = loadedMathFontFamilies();

    const QStringList preferredFamilies = {
        QStringLiteral("Latin Modern Math"),
        QStringLiteral("Libertinus Math"),
        QStringLiteral("STIX Two Math"),
        QStringLiteral("XITS Math"),
        QStringLiteral("STIX Math")
    };

    const QFontDatabase fontDatabase;
    const QStringList availableFamilies = fontDatabase.families();
    for (const QString &familyName : preferredFamilies) {
        if (loadedFamilies.contains(familyName) || availableFamilies.contains(familyName)) {
            return familyName;
        }
    }

    if (!loadedFamilies.isEmpty()) {
        return loadedFamilies.front();
    }

    QFont fallback = QFontDatabase::systemFont(QFontDatabase::GeneralFont);
    fallback.setStyleHint(QFont::Serif);
    return fallback.family();
}

QString functionSignatureMathFamily() {
    loadedMathFontFamilies();
    if (g_selectedMathFontFamily.isEmpty()) {
        g_selectedMathFontFamily = defaultMathFontFamily();
    }
    return g_selectedMathFontFamily;
}

QFont sizedFont(const QString &family, bool bold = false) {
    QFont font(family);
    font.setStyleStrategy(QFont::PreferAntialias);
    font.setPointSizeF(AST_FONT_POINT_SIZE);
    font.setBold(bold);
    return font;
}

QFont functionSignatureMathFont();
QFont functionSignatureOperatorFont();

QFont trivialFont() {
    return functionSignatureMathFont();
}

QFont headerFont() {
    return functionSignatureMathFont();
}

QFont callSyntaxFont() {
    return functionSignatureOperatorFont();
}

QFont callParenFont(qreal inlineContentHeight) {
    Q_UNUSED(inlineContentHeight);
    return callSyntaxFont();
}

QFont functionSignatureLabelFont() {
    return functionSignatureMathFont();
}

QFont functionSignatureMathFont() {
    QFont candidate = sizedFont(functionSignatureMathFamily());
    candidate.setStyleHint(QFont::Serif);
    return candidate;
}

QFont functionSignatureNameFont() {
    return functionSignatureMathFont();
}

QFont functionSignatureIdentifierFont() {
    return functionSignatureMathFont();
}

QFont functionSignatureTypeFont() {
    return functionSignatureMathFont();
}

QFont functionSignatureOperatorFont() {
    return functionSignatureMathFont();
}

QFont assignmentKeywordFont() {
    return functionSignatureTypeFont();
}

QFont assignmentIdentifierFont(bool emphasized = false) {
    Q_UNUSED(emphasized);
    return functionSignatureIdentifierFont();
}

QFont assignmentTypeFont() {
    return functionSignatureTypeFont();
}

QFont assignmentOperatorFont() {
    return functionSignatureOperatorFont();
}

QFont assignmentValueFontForNode(const iw::AstNodePtr &node) {
    if (node && node->type() == iw::AstNodeType::IdentifierNode) {
        return assignmentIdentifierFont(false);
    }
    return assignmentTypeFont();
}

QColor assignmentValueColorForNode(const iw::AstNodePtr &node) {
    if (node && node->type() == iw::AstNodeType::TextDatabaseReferenceNode) {
        return astStringColor();
    }
    if (node && node->type() == iw::AstNodeType::NumberLiteralNode) {
        return astNumberColor();
    }
    return astTextColor();
}

struct InlineTextRunSpec final {
    QString text;
    QFont font;
    QColor color;
};

QFont classHeaderNameFont() {
    return functionSignatureMathFont();
}

std::vector<InlineTextRunSpec> buildGenericDisplayNameRuns(const QString &displayName, const QFont &baseFont);

std::vector<InlineTextRunSpec> buildFunctionHeaderRuns(const QString &headerKeyword, const FunctionSignatureCardData &data, bool hasReturnType, const QColor &accent) {
    Q_UNUSED(accent);
    const QColor keywordColor = astKeywordColor();
    const QColor nameColor = astTextColor();
    const QColor operatorColor = astTextColor();
    const QColor formulaColor = astTypeColor();

    std::vector<InlineTextRunSpec> runs;
    runs.reserve(8 + (data.params.size() * 4));
    runs.push_back(InlineTextRunSpec{headerKeyword + QStringLiteral(" "), assignmentKeywordFont(), keywordColor});
    const std::vector<InlineTextRunSpec> displayNameRuns = buildGenericDisplayNameRuns(data.displayName, functionSignatureNameFont());
    runs.insert(runs.end(), displayNameRuns.begin(), displayNameRuns.end());
    runs.push_back(InlineTextRunSpec{QStringLiteral("("), assignmentOperatorFont(), operatorColor});
    for (std::size_t index = 0; index < data.params.size(); index += 1) {
        const SignatureParamData &param = data.params.at(index);
        if (index > 0) {
            runs.push_back(InlineTextRunSpec{QStringLiteral(", "), assignmentOperatorFont(), operatorColor});
        }
        runs.push_back(InlineTextRunSpec{param.name, assignmentIdentifierFont(false), nameColor});
        runs.push_back(InlineTextRunSpec{QStringLiteral(":"), assignmentOperatorFont(), operatorColor});
        runs.push_back(InlineTextRunSpec{param.typeText, assignmentTypeFont(), formulaColor});
    }
    runs.push_back(InlineTextRunSpec{QStringLiteral(")"), assignmentOperatorFont(), operatorColor});
    if (hasReturnType) {
        runs.push_back(InlineTextRunSpec{QStringLiteral(" \u2192 "), assignmentOperatorFont(), operatorColor});
        runs.push_back(InlineTextRunSpec{data.returnTypeText, assignmentTypeFont(), formulaColor});
    }
    return runs;
}

std::vector<InlineTextRunSpec> buildGenericDisplayNameRuns(const QString &displayName, const QFont &baseFont) {
    std::vector<InlineTextRunSpec> runs;
    qsizetype cursor = 0;
    while (cursor < displayName.size()) {
        const qsizetype open = displayName.indexOf(QStringLiteral("\u27e8"), cursor);
        if (open < 0) {
            runs.push_back(InlineTextRunSpec{displayName.mid(cursor), baseFont, astTextColor()});
            break;
        }
        if (open > cursor) {
            runs.push_back(InlineTextRunSpec{displayName.mid(cursor, open - cursor), baseFont, astTextColor()});
        }
        const qsizetype close = displayName.indexOf(QStringLiteral("\u27e9"), open + 1);
        const qsizetype count = close >= 0 ? close - open + 1 : displayName.size() - open;
        runs.push_back(InlineTextRunSpec{displayName.mid(open, count), baseFont, astTypeColor()});
        cursor = open + count;
    }
    return runs;
}

std::vector<InlineTextRunSpec> buildDeclareRuns(const FunctionSignatureCardData &data) {
    std::vector<InlineTextRunSpec> runs = {
        InlineTextRunSpec{QStringLiteral("Declare "), assignmentKeywordFont(), astKeywordColor()},
    };
    const std::vector<InlineTextRunSpec> nameRuns = buildGenericDisplayNameRuns(data.displayName, functionSignatureNameFont());
    runs.insert(runs.end(), nameRuns.begin(), nameRuns.end());
    return runs;
}

std::vector<InlineTextRunSpec> buildClassHeaderRuns(const QString &displayName, const QColor &accent) {
    Q_UNUSED(accent);
    std::vector<InlineTextRunSpec> runs = {
        InlineTextRunSpec{QStringLiteral("Class "), assignmentKeywordFont(), astKeywordColor()},
    };
    const std::vector<InlineTextRunSpec> nameRuns = buildGenericDisplayNameRuns(displayName, classHeaderNameFont());
    runs.insert(runs.end(), nameRuns.begin(), nameRuns.end());
    return runs;
}

std::vector<InlineTextRunSpec> buildKeywordRuns(const QString &text, const QColor &accent) {
    Q_UNUSED(accent);
    return {
        InlineTextRunSpec{text, assignmentKeywordFont(), astKeywordColor()}
    };
}

std::vector<InlineTextRunSpec> buildPropertyRuns(const iw::TypeVarBindNodePtr &bind, const QColor &accent) {
    Q_UNUSED(accent);
    const QColor keywordColor = astKeywordColor();
    const QColor nameColor = astTextColor();
    const QColor operatorColor = astTextColor();
    const QColor formulaColor = astTypeColor();

    return {
        InlineTextRunSpec{QStringLiteral("Var "), assignmentKeywordFont(), keywordColor},
        InlineTextRunSpec{bind->identifier()->name(), assignmentIdentifierFont(true), nameColor},
        InlineTextRunSpec{QStringLiteral(":"), assignmentOperatorFont(), operatorColor},
        InlineTextRunSpec{signatureTextForAstNode(bind->typeExpression()), assignmentTypeFont(), formulaColor},
    };
}

AstGraphicsItem *createAstGraphicsItemInternal(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr);

class FunctionSignatureTextGraphicsItem final : public QGraphicsObject {
public:
    struct TextRunLayout final {
        QString text;
        QFont font;
        QColor color;
        qreal x = 0.0;
    };

    struct LineLayout final {
        std::vector<TextRunLayout> runs;
        qreal baseline = 0.0;
    };

    explicit FunctionSignatureTextGraphicsItem(const FunctionSignatureCardData &data, const QColor &accent, QGraphicsItem *parent = nullptr)
        : QGraphicsObject(parent),
          m_data(data),
          m_accent(accent) {
        setAcceptedMouseButtons(Qt::NoButton);
        layoutText();
    }

    QRectF boundingRect() const override {
        return m_bounds;
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing, true);
        painter->setRenderHint(QPainter::TextAntialiasing, true);

        const QColor panelBorder = astTextColor();
        QColor panelFill = astBackgroundColor();
        painter->setPen(QPen(panelBorder, 1.0));
        painter->setBrush(panelFill);
        painter->drawRect(boundingRect());

        QPen accentPen(astTextColor(), 1.4);
        painter->setPen(accentPen);
        painter->drawLine(
            QPointF(1.0, 1.0),
            QPointF(std::max<qreal>(1.0, boundingRect().width() - 1.0), 1.0));

        if (m_formulaTop > 0.0) {
            QPen dividerPen(astTextColor(), 1.0);
            painter->setPen(dividerPen);
            const qreal dividerY = m_formulaTop - (FUNCTION_SIGNATURE_FORMULA_GAP * 0.55);
            painter->drawLine(
                QPointF(FUNCTION_SIGNATURE_PANEL_PADDING, dividerY),
                QPointF(boundingRect().width() - FUNCTION_SIGNATURE_PANEL_PADDING, dividerY));
        }

        for (const LineLayout &line : m_lines) {
            for (const TextRunLayout &run : line.runs) {
                painter->setFont(run.font);
                painter->setPen(run.color);
                painter->drawText(QPointF(run.x, line.baseline), run.text);
            }
        }
    }

private:
    struct StyledRun final {
        QString text;
        QFont font;
        QColor color;
    };

    enum class TypeLayoutContext {
        TopLevel,
        GenericArg,
        ArrowParam,
        UnionMember,
    };

    static qreal signatureDepthPointDelta(int depth) {
        Q_UNUSED(depth);
        return 0.0;
    }

    static QFont scaledSignatureFont(const QFont &base, qreal delta) {
        Q_UNUSED(delta);
        QFont candidate(base);
        candidate.setPointSizeF(AST_FONT_POINT_SIZE);
        return candidate;
    }

    static void appendRuns(std::vector<StyledRun> &target, const std::vector<StyledRun> &extra) {
        target.insert(target.end(), extra.begin(), extra.end());
    }

    QFont typeIdentifierFontForName(const QString &name, int depth) const {
        const qreal delta = -signatureDepthPointDelta(depth);
        Q_UNUSED(name);
        return scaledSignatureFont(functionSignatureTypeFont(), delta);
    }

    QFont typeFontForDepth(int depth) const {
        return scaledSignatureFont(functionSignatureTypeFont(), -signatureDepthPointDelta(depth));
    }

    QFont typeOperatorFontForDepth(int depth, qreal bonus = 0.0) const {
        return scaledSignatureFont(functionSignatureOperatorFont(), -signatureDepthPointDelta(depth) + bonus);
    }

    bool canTreatAngleListAsTypeApplication(const std::shared_ptr<iw::AngleParenListNode> &angleList) const {
        if (!angleList || angleList->elements().size() < 2) {
            return false;
        }

        const iw::AstNodePtr &base = angleList->elements().front();
        return base->type() == iw::AstNodeType::IdentifierNode
            || base->type() == iw::AstNodeType::GenericNameNode
            || base->type() == iw::AstNodeType::AngleParenListNode;
    }

    std::vector<StyledRun> delimitedTypeRuns(const iw::AstNodeList &elements, const QString &left, const QString &right, const QString &separator, int depth, TypeLayoutContext context, const QColor &typeColor, const QColor &operatorColor, const QColor &accentOperatorColor) const {
        std::vector<StyledRun> runs;
        runs.push_back(StyledRun{left, typeOperatorFontForDepth(depth, 0.1), accentOperatorColor});
        for (std::size_t index = 0; index < elements.size(); index += 1) {
            if (index > 0) {
                runs.push_back(StyledRun{separator, typeOperatorFontForDepth(depth), operatorColor});
            }
            appendRuns(runs, typeRunsForNode(elements.at(index), depth + 1, context, typeColor, operatorColor, accentOperatorColor));
        }
        runs.push_back(StyledRun{right, typeOperatorFontForDepth(depth, 0.1), accentOperatorColor});
        return runs;
    }

    std::vector<StyledRun> typeRunsForNode(const iw::AstNodePtr &node, int depth, TypeLayoutContext context, const QColor &typeColor, const QColor &operatorColor, const QColor &accentOperatorColor) const {
        if (!node) {
            return {StyledRun{QStringLiteral("unknown"), typeFontForDepth(depth), typeColor}};
        }

        const bool wrapArrow = node->type() == iw::AstNodeType::TypeToFromNode && context != TypeLayoutContext::TopLevel;
        const bool wrapUnion = node->type() == iw::AstNodeType::TypeUnionNode && context == TypeLayoutContext::GenericArg;

        std::vector<StyledRun> runs;
        if (wrapArrow || wrapUnion) {
            runs.push_back(StyledRun{QStringLiteral("("), typeOperatorFontForDepth(depth, 0.1), operatorColor});
        }

        if (const iw::IdentifierNodePtr identifier = std::dynamic_pointer_cast<iw::IdentifierNode>(node)) {
            runs.push_back(StyledRun{identifier->name(), typeIdentifierFontForName(identifier->name(), depth), typeColor});
        } else if (const iw::GenericNameNodePtr genericName = std::dynamic_pointer_cast<iw::GenericNameNode>(node)) {
            appendRuns(runs, typeRunsForNode(genericName->name(), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
            if (!genericName->genericTypeArgs().empty()) {
                runs.push_back(StyledRun{QStringLiteral("\u27e8"), typeOperatorFontForDepth(depth, 0.15), accentOperatorColor});
                for (std::size_t index = 0; index < genericName->genericTypeArgs().size(); index += 1) {
                    if (index > 0) {
                        runs.push_back(StyledRun{QStringLiteral(", "), typeOperatorFontForDepth(depth), operatorColor});
                    }
                    appendRuns(runs, typeRunsForNode(genericName->genericTypeArgs().at(index), depth + 1, TypeLayoutContext::GenericArg, typeColor, operatorColor, accentOperatorColor));
                }
                runs.push_back(StyledRun{QStringLiteral("\u27e9"), typeOperatorFontForDepth(depth, 0.15), accentOperatorColor});
            }
        } else if (const std::shared_ptr<iw::AngleParenListNode> angleList = std::dynamic_pointer_cast<iw::AngleParenListNode>(node)) {
            if (canTreatAngleListAsTypeApplication(angleList)) {
                appendRuns(runs, typeRunsForNode(angleList->elements().front(), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
                runs.push_back(StyledRun{QStringLiteral("\u27e8"), typeOperatorFontForDepth(depth, 0.15), accentOperatorColor});
                for (std::size_t index = 1; index < angleList->elements().size(); index += 1) {
                    if (index > 1) {
                        runs.push_back(StyledRun{QStringLiteral(", "), typeOperatorFontForDepth(depth), operatorColor});
                    }
                    appendRuns(runs, typeRunsForNode(angleList->elements().at(index), depth + 1, TypeLayoutContext::GenericArg, typeColor, operatorColor, accentOperatorColor));
                }
                runs.push_back(StyledRun{QStringLiteral("\u27e9"), typeOperatorFontForDepth(depth, 0.15), accentOperatorColor});
            } else {
                appendRuns(runs, delimitedTypeRuns(angleList->elements(), QStringLiteral("\u27e8"), QStringLiteral("\u27e9"), QStringLiteral(", "), depth, TypeLayoutContext::GenericArg, typeColor, operatorColor, accentOperatorColor));
            }
        } else if (const std::shared_ptr<iw::TypeToFromNode> typeToFrom = std::dynamic_pointer_cast<iw::TypeToFromNode>(node)) {
            runs.push_back(StyledRun{QStringLiteral("("), typeOperatorFontForDepth(depth, 0.2), accentOperatorColor});
            for (std::size_t index = 0; index < typeToFrom->paramTypes().size(); index += 1) {
                if (index > 0) {
                    runs.push_back(StyledRun{QStringLiteral(", "), typeOperatorFontForDepth(depth), operatorColor});
                }
                appendRuns(runs, typeRunsForNode(typeToFrom->paramTypes().at(index), depth + 1, TypeLayoutContext::ArrowParam, typeColor, operatorColor, accentOperatorColor));
            }
            runs.push_back(StyledRun{QStringLiteral(")"), typeOperatorFontForDepth(depth, 0.2), accentOperatorColor});
            runs.push_back(StyledRun{QStringLiteral("  \u2192  "), typeOperatorFontForDepth(depth, 0.45), accentOperatorColor});
            appendRuns(runs, typeRunsForNode(typeToFrom->returnType(), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
        } else if (const std::shared_ptr<iw::TypeUnionNode> unionNode = std::dynamic_pointer_cast<iw::TypeUnionNode>(node)) {
            for (std::size_t index = 0; index < unionNode->types().size(); index += 1) {
                if (index > 0) {
                    runs.push_back(StyledRun{QStringLiteral("  \u2223  "), typeOperatorFontForDepth(depth, 0.2), accentOperatorColor});
                }
                appendRuns(runs, typeRunsForNode(unionNode->types().at(index), depth, TypeLayoutContext::UnionMember, typeColor, operatorColor, accentOperatorColor));
            }
        } else if (const std::shared_ptr<iw::RoundParenListNode> roundList = std::dynamic_pointer_cast<iw::RoundParenListNode>(node)) {
            appendRuns(runs, delimitedTypeRuns(roundList->elements(), QStringLiteral("("), QStringLiteral(")"), QStringLiteral(", "), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
        } else if (const std::shared_ptr<iw::SquareParenListNode> squareList = std::dynamic_pointer_cast<iw::SquareParenListNode>(node)) {
            appendRuns(runs, delimitedTypeRuns(squareList->elements(), QStringLiteral("["), QStringLiteral("]"), QStringLiteral(" "), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
        } else if (const std::shared_ptr<iw::CurlyParenListNode> curlyList = std::dynamic_pointer_cast<iw::CurlyParenListNode>(node)) {
            appendRuns(runs, delimitedTypeRuns(curlyList->elements(), QStringLiteral("{"), QStringLiteral("}"), QStringLiteral(", "), depth, TypeLayoutContext::TopLevel, typeColor, operatorColor, accentOperatorColor));
        } else {
            runs.push_back(StyledRun{signatureTextForAstNode(node), typeFontForDepth(depth), typeColor});
        }

        if (wrapArrow || wrapUnion) {
            runs.push_back(StyledRun{QStringLiteral(")"), typeOperatorFontForDepth(depth, 0.1), operatorColor});
        }
        return runs;
    }

    qreal lineWidthForRuns(const std::vector<StyledRun> &runs) const {
        qreal width = 0.0;
        for (const StyledRun &run : runs) {
            width += QFontMetricsF(run.font).horizontalAdvance(run.text);
        }
        return width;
    }

    void addLine(std::vector<LineLayout> &lines, qreal &currentY, qreal &contentRight, const std::vector<StyledRun> &runs, qreal indent) {
        if (runs.empty()) {
            return;
        }

        const qreal x = FUNCTION_SIGNATURE_PANEL_PADDING + indent;
        qreal maxAscent = 0.0;
        qreal maxDescent = 0.0;
        qreal currentX = x;

        LineLayout line;
        line.runs.reserve(runs.size());

        for (const StyledRun &run : runs) {
            const QFontMetricsF metrics(run.font);
            maxAscent = std::max(maxAscent, metrics.ascent());
            maxDescent = std::max(maxDescent, metrics.descent());
            line.runs.push_back(TextRunLayout{run.text, run.font, run.color, currentX});
            currentX += metrics.horizontalAdvance(run.text);
        }

        line.baseline = currentY + maxAscent;
        contentRight = std::max(contentRight, currentX);
        currentY += maxAscent + maxDescent + FUNCTION_SIGNATURE_LINE_GAP;
        lines.push_back(std::move(line));
    }

    std::vector<StyledRun> inlineSignatureRuns(const QColor &nameColor, const QColor &operatorColor, const QColor &typeColor) const {
        std::vector<StyledRun> runs;
        const QColor typeAccentColor = astTextColor();
        runs.push_back(StyledRun{m_data.displayName, functionSignatureNameFont(), nameColor});
        runs.push_back(StyledRun{QStringLiteral(" : "), functionSignatureOperatorFont(), operatorColor});
        runs.push_back(StyledRun{QStringLiteral("("), functionSignatureOperatorFont(), operatorColor});

        for (std::size_t index = 0; index < m_data.params.size(); index += 1) {
            const SignatureParamData &param = m_data.params.at(index);
            if (index > 0) {
                runs.push_back(StyledRun{QStringLiteral(", "), functionSignatureOperatorFont(), operatorColor});
            }
            runs.push_back(StyledRun{param.name, functionSignatureIdentifierFont(), nameColor});
            runs.push_back(StyledRun{QStringLiteral(" : "), functionSignatureOperatorFont(), operatorColor});
            appendRuns(runs, typeRunsForNode(param.typeNode, 0, TypeLayoutContext::TopLevel, typeColor, operatorColor, typeAccentColor));
        }

        runs.push_back(StyledRun{QStringLiteral(") \u2192 "), functionSignatureOperatorFont(), operatorColor});
        appendRuns(runs, typeRunsForNode(m_data.returnTypeNode, 0, TypeLayoutContext::TopLevel, typeColor, operatorColor, typeAccentColor));
        return runs;
    }

    std::vector<StyledRun> parameterRuns(const SignatureParamData &param, bool trailingComma, const QColor &nameColor, const QColor &operatorColor, const QColor &typeColor) const {
        std::vector<StyledRun> runs;
        const QColor typeAccentColor = astTextColor();
        runs.push_back(StyledRun{param.name, functionSignatureIdentifierFont(), nameColor});
        runs.push_back(StyledRun{QStringLiteral(" : "), functionSignatureOperatorFont(), operatorColor});
        appendRuns(runs, typeRunsForNode(param.typeNode, 0, TypeLayoutContext::TopLevel, typeColor, operatorColor, typeAccentColor));
        if (trailingComma) {
            runs.push_back(StyledRun{QStringLiteral(","), functionSignatureOperatorFont(), operatorColor});
        }
        return runs;
    }

    void layoutText() {
        m_lines.clear();

        const QColor labelColor = astKeywordColor();
        const QColor nameColor = astTextColor();
        const QColor operatorColor = astTextColor();
        const QColor typeColor = astTypeColor();
        const QColor typeAccentColor = astTextColor();

        qreal currentY = FUNCTION_SIGNATURE_PANEL_PADDING;
        qreal contentRight = 0.0;
        m_formulaTop = 0.0;

        addLine(m_lines, currentY, contentRight, {StyledRun{m_data.label, functionSignatureLabelFont(), labelColor}}, 0.0);
        currentY += FUNCTION_SIGNATURE_LABEL_GAP - FUNCTION_SIGNATURE_LINE_GAP;
        m_formulaTop = currentY;

        const std::vector<StyledRun> inlineRuns = inlineSignatureRuns(nameColor, operatorColor, typeColor);
        if (lineWidthForRuns(inlineRuns) <= FUNCTION_SIGNATURE_INLINE_WIDTH_LIMIT) {
            addLine(m_lines, currentY, contentRight, inlineRuns, 0.0);
        } else {
            addLine(
                m_lines,
                currentY,
                contentRight,
                {
                    StyledRun{m_data.displayName, functionSignatureNameFont(), nameColor},
                    StyledRun{QStringLiteral(" :"), functionSignatureOperatorFont(), operatorColor}
                },
                0.0);

            if (m_data.params.empty()) {
                std::vector<StyledRun> returnRuns = {
                    StyledRun{QStringLiteral("() \u2192 "), functionSignatureOperatorFont(), operatorColor},
                };
                appendRuns(returnRuns, typeRunsForNode(m_data.returnTypeNode, 0, TypeLayoutContext::TopLevel, typeColor, operatorColor, typeAccentColor));
                addLine(
                    m_lines,
                    currentY,
                    contentRight,
                    returnRuns,
                    FUNCTION_SIGNATURE_BLOCK_INDENT);
            } else {
                addLine(
                    m_lines,
                    currentY,
                    contentRight,
                    {StyledRun{QStringLiteral("("), functionSignatureOperatorFont(), operatorColor}},
                    FUNCTION_SIGNATURE_BLOCK_INDENT);

                for (std::size_t index = 0; index < m_data.params.size(); index += 1) {
                    addLine(
                        m_lines,
                        currentY,
                        contentRight,
                        parameterRuns(m_data.params.at(index), index + 1 < m_data.params.size(), nameColor, operatorColor, typeColor),
                        FUNCTION_SIGNATURE_HANGING_INDENT);
                }

                std::vector<StyledRun> returnRuns = {
                    StyledRun{QStringLiteral(") \u2192 "), functionSignatureOperatorFont(), operatorColor},
                };
                appendRuns(returnRuns, typeRunsForNode(m_data.returnTypeNode, 0, TypeLayoutContext::TopLevel, typeColor, operatorColor, typeAccentColor));
                addLine(
                    m_lines,
                    currentY,
                    contentRight,
                    returnRuns,
                    FUNCTION_SIGNATURE_BLOCK_INDENT);
            }
        }

        currentY -= FUNCTION_SIGNATURE_LINE_GAP;
        const qreal totalWidth = std::max(FUNCTION_SIGNATURE_MIN_WIDTH, contentRight + FUNCTION_SIGNATURE_PANEL_PADDING);
        const qreal totalHeight = currentY + FUNCTION_SIGNATURE_PANEL_PADDING;
        m_bounds = QRectF(0.0, 0.0, totalWidth, totalHeight);
    }

    FunctionSignatureCardData m_data;
    QColor m_accent;
    QRectF m_bounds;
    std::vector<LineLayout> m_lines;
    qreal m_formulaTop = 0.0;
};

class FunctionSignatureStructuredGraphicsItem : public AstGraphicsItem {
public:
    FunctionSignatureStructuredGraphicsItem(const iw::AstNodePtr &node, const FunctionSignatureCardData &signatureData, const iw::AstNodePtr &bodyNode, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent),
          m_signatureItem(new FunctionSignatureTextGraphicsItem(signatureData, accentColor(), this)) {
        if (bodyNode) {
            m_bodyItem = createAstGraphicsItemInternal(bodyNode, this);
        }
        layout();
    }

    void refreshLayout() override {
        layout();
        update();
    }

    QPointF connectionAnchor() const override {
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, m_signatureItem->boundingRect().height() * 0.5);
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing, true);

        const QColor borderColor = astTextColor();
        QColor bodyColor = astBackgroundColor();

        painter->setPen(QPen(borderColor, 1.3));
        painter->setBrush(QBrush(bodyColor));
        painter->drawRect(boundingRect());

        if (!m_bodyItem) {
            return;
        }

        const qreal separatorY = FUNCTION_CARD_PADDING + m_signatureItem->boundingRect().height() + (FUNCTION_CARD_GAP * 0.5);
        QPen separatorPen(borderColor, 1.0);
        separatorPen.setStyle(Qt::DashLine);
        painter->setPen(separatorPen);
        painter->drawLine(
            QPointF(FUNCTION_CARD_PADDING, separatorY),
            QPointF(boundingRect().width() - FUNCTION_CARD_PADDING, separatorY));
    }

private:
    void layout() {
        const QRectF signatureBounds = m_signatureItem->boundingRect();
        const QRectF bodyBounds = m_bodyItem ? m_bodyItem->boundingRect() : QRectF();
        const qreal contentWidth = std::max(signatureBounds.width(), bodyBounds.width());
        const qreal totalWidth = contentWidth + (FUNCTION_CARD_PADDING * 2.0);
        qreal totalHeight = (FUNCTION_CARD_PADDING * 2.0) + signatureBounds.height();
        if (m_bodyItem) {
            totalHeight += FUNCTION_CARD_GAP + bodyBounds.height();
        }

        setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));
        m_signatureItem->setPos(FUNCTION_CARD_PADDING, FUNCTION_CARD_PADDING);
        if (m_bodyItem) {
            m_bodyItem->setPos(FUNCTION_CARD_PADDING, FUNCTION_CARD_PADDING + signatureBounds.height() + FUNCTION_CARD_GAP);
        }
    }

    FunctionSignatureTextGraphicsItem *m_signatureItem = nullptr;
    AstGraphicsItem *m_bodyItem = nullptr;
};

class AstTrivialGraphicsItem : public AstGraphicsItem {
public:
    explicit AstTrivialGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent),
          m_isLiteral(isLiteralNodeType(node->type())) {
        const QFontMetricsF metrics(trivialFont());
        QString text = labelText();
        text.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
        text.replace(QChar('\r'), QChar('\n'));
        text.replace(QChar('\t'), QStringLiteral("    "));
        m_lines = text.split(QChar('\n'), Qt::KeepEmptyParts);
        if (m_lines.isEmpty()) {
            m_lines.push_back(QString());
        }
        qreal width = 1.0;
        for (const QString &line : m_lines) {
            width = std::max(width, metrics.horizontalAdvance(line));
        }
        m_textX = m_isLiteral ? TRIVIAL_LITERAL_X_PADDING : 0.0;
        m_textBaseline = metrics.ascent() + (m_isLiteral ? TRIVIAL_LITERAL_Y_PADDING : 0.0);
        m_firstLineCenterY = m_textBaseline - metrics.ascent() + (metrics.height() * 0.5);
        m_lineSpacing = metrics.lineSpacing();
        width += m_isLiteral ? (TRIVIAL_LITERAL_X_PADDING * 2.0) : 0.0;
        qreal height = std::max<qreal>(
            1.0,
            metrics.height() + (static_cast<qreal>(m_lines.size() - 1) * m_lineSpacing));
        height += m_isLiteral ? (TRIVIAL_LITERAL_Y_PADDING * 2.0) : 0.0;
        setBounds(QRectF(0.0, 0.0, width, height));
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::TextAntialiasing, true);

        const QColor textColor = m_isLiteral ? astStringColor() : accentColor();
        painter->setFont(trivialFont());
        painter->setPen(textColor);

        if (m_isLiteral) {
            QPen borderPen(textColor, TRIVIAL_LITERAL_BORDER_WIDTH);
            painter->setPen(borderPen);
            painter->setBrush(astBackgroundColor());
            const qreal borderInset = borderPen.widthF() * 0.5;
            painter->drawRect(boundingRect().adjusted(borderInset, borderInset, -borderInset, -borderInset));
            painter->setPen(textColor);
        }

        for (qsizetype index = 0; index < m_lines.size(); index += 1) {
            painter->drawText(QPointF(m_textX, m_textBaseline + (static_cast<qreal>(index) * m_lineSpacing)), m_lines.at(index));
        }
    }

    QPointF connectionAnchor() const override {
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, m_firstLineCenterY);
    }

private:
    QStringList m_lines;
    bool m_isLiteral = false;
    qreal m_textX = 0.0;
    qreal m_textBaseline = 0.0;
    qreal m_firstLineCenterY = 0.0;
    qreal m_lineSpacing = 0.0;
};

class AstInlineFormulaGraphicsItem : public AstGraphicsItem {
public:
    explicit AstInlineFormulaGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent) {
        layoutText();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::TextAntialiasing, true);
        for (const RunLayout &run : m_runs) {
            painter->setFont(run.font);
            painter->setPen(run.color);
            painter->drawText(QPointF(run.x, m_baseline), run.text);
        }
    }

    QPointF connectionAnchor() const override {
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, m_firstLineCenterY);
    }

private:
    struct StyledRun final {
        QString text;
        QFont font;
        QColor color;
    };

    struct RunLayout final {
        QString text;
        QFont font;
        QColor color;
        qreal x = 0.0;
    };

    QFont formulaIdentifierFont() const {
        return functionSignatureIdentifierFont();
    }

    QFont formulaTextFont() const {
        return functionSignatureTypeFont();
    }

    QFont formulaOperatorFont() const {
        return functionSignatureOperatorFont();
    }

    void appendTextRun(std::vector<StyledRun> &runs, const QString &text, const QFont &font, const QColor &color) const {
        if (text.isEmpty()) {
            return;
        }
        runs.push_back(StyledRun{text, font, color});
    }

    std::vector<StyledRun> buildRuns() const {
        const QColor nameColor = astTextColor();
        const QColor operatorColor = astTextColor();
        const QColor formulaColor = astTypeColor();
        const QColor accentOperatorColor = astTextColor();

        if (const std::shared_ptr<iw::TypeVarBindNode> bindNode = std::dynamic_pointer_cast<iw::TypeVarBindNode>(node())) {
            return {
                StyledRun{bindNode->identifier()->name(), formulaIdentifierFont(), nameColor},
                StyledRun{QStringLiteral(" : "), formulaOperatorFont(), operatorColor},
                StyledRun{signatureTextForAstNode(bindNode->typeExpression()), formulaTextFont(), formulaColor}
            };
        }

        if (const std::shared_ptr<iw::TypeToFromNode> typeToFrom = std::dynamic_pointer_cast<iw::TypeToFromNode>(node())) {
            std::vector<StyledRun> runs;
            appendTextRun(runs, QStringLiteral("("), formulaOperatorFont(), accentOperatorColor);
            for (std::size_t index = 0; index < typeToFrom->paramTypes().size(); index += 1) {
                if (index > 0) {
                    appendTextRun(runs, QStringLiteral(", "), formulaOperatorFont(), operatorColor);
                }
                appendTextRun(runs, signatureTextForAstNode(typeToFrom->paramTypes().at(index)), formulaTextFont(), formulaColor);
            }
            appendTextRun(runs, QStringLiteral(")"), formulaOperatorFont(), accentOperatorColor);
            appendTextRun(runs, QStringLiteral(" \u2192 "), formulaOperatorFont(), accentOperatorColor);
            appendTextRun(runs, signatureTextForAstNode(typeToFrom->returnType()), formulaTextFont(), formulaColor);
            return runs;
        }

        if (const std::shared_ptr<iw::TypeUnionNode> unionNode = std::dynamic_pointer_cast<iw::TypeUnionNode>(node())) {
            std::vector<StyledRun> runs;
            for (std::size_t index = 0; index < unionNode->types().size(); index += 1) {
                if (index > 0) {
                    appendTextRun(runs, QStringLiteral(" \u2223 "), formulaOperatorFont(), accentOperatorColor);
                }
                appendTextRun(runs, signatureTextForAstNode(unionNode->types().at(index)), formulaTextFont(), formulaColor);
            }
            return runs;
        }

        if (const std::shared_ptr<iw::GenericCallNode> genericCall = std::dynamic_pointer_cast<iw::GenericCallNode>(node())) {
            std::vector<StyledRun> runs;
            QString calleeText = signatureTextForAstNode(genericCall->callee());
            if (shouldWrapGenericCallCalleeText(genericCall->callee())) {
                calleeText = QStringLiteral("(%1)").arg(calleeText);
            }
            appendTextRun(runs, calleeText, formulaIdentifierFont(), nameColor);
            appendTextRun(runs, QStringLiteral("\u27e8"), formulaOperatorFont(), accentOperatorColor);
            for (std::size_t index = 0; index < genericCall->typeArgs().size(); index += 1) {
                if (index > 0) {
                    appendTextRun(runs, QStringLiteral(", "), formulaOperatorFont(), operatorColor);
                }
                appendTextRun(runs, signatureTextForAstNode(genericCall->typeArgs().at(index)), formulaTextFont(), formulaColor);
            }
            appendTextRun(runs, QStringLiteral("\u27e9"), formulaOperatorFont(), accentOperatorColor);
            return runs;
        }

        return {StyledRun{signatureTextForAstNode(node()), formulaTextFont(), formulaColor}};
    }

    void layoutText() {
        const std::vector<StyledRun> styledRuns = buildRuns();
        qreal currentX = INLINE_FORMULA_X_PADDING;
        qreal maxAscent = 0.0;
        qreal maxDescent = 0.0;

        m_runs.clear();
        m_runs.reserve(styledRuns.size());
        for (const StyledRun &run : styledRuns) {
            const QFontMetricsF metrics(run.font);
            maxAscent = std::max(maxAscent, metrics.ascent());
            maxDescent = std::max(maxDescent, metrics.descent());
            m_runs.push_back(RunLayout{run.text, run.font, run.color, currentX});
            currentX += metrics.horizontalAdvance(run.text);
        }

        m_baseline = INLINE_FORMULA_Y_PADDING + maxAscent;
        m_firstLineCenterY = INLINE_FORMULA_Y_PADDING + ((maxAscent + maxDescent) * 0.5);
        setBounds(QRectF(
            0.0,
            0.0,
            std::max<qreal>(1.0, currentX + INLINE_FORMULA_X_PADDING),
            std::max<qreal>(1.0, INLINE_FORMULA_Y_PADDING + maxAscent + maxDescent + INLINE_FORMULA_Y_PADDING)));
    }

    qreal m_baseline = 0.0;
    qreal m_firstLineCenterY = 0.0;
    std::vector<RunLayout> m_runs;
};

class AstStructuredGraphicsItem : public AstGraphicsItem {
public:
    explicit AstStructuredGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr);

    void refreshLayout() override {
        layoutChildren();
        update();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override;
    QPointF connectionAnchor() const override;

protected:
    const std::vector<AstGraphicsItem *> &childItems() const {
        return m_childItems;
    }

private:
    void layoutChildren();

    std::vector<AstGraphicsItem *> m_childItems;
    qreal m_headerHeight = 0.0;
    qreal m_contentTop = 0.0;
    qreal m_dividerX = -1.0;
    QPointF m_leftAnchor;
    QPointF m_rightAnchor;
    bool m_hasLeftAnchor = false;
    bool m_hasRightAnchor = false;
};

AstGraphicsItem *createAstGraphicsItemInternal(const iw::AstNodePtr &node, QGraphicsItem *parent);

AstStructuredGraphicsItem::AstStructuredGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent)
    : AstGraphicsItem(node, parent) {
    const iw::AstNodeList children = node->childNodes();
    m_childItems.reserve(children.size());
    for (const iw::AstNodePtr &child : children) {
        m_childItems.push_back(createAstGraphicsItemInternal(child, this));
    }
    layoutChildren();
}

void AstStructuredGraphicsItem::layoutChildren() {
    const QFontMetricsF headerMetrics(headerFont());
    m_headerHeight = headerMetrics.height() + (HEADER_Y_PADDING * 2.0);
    m_contentTop = STRUCTURED_PADDING + m_headerHeight + STRUCTURED_CONNECTOR_VERTICAL_GAP;

    qreal leftWidth = 0.0;
    qreal leftHeight = 0.0;
    qreal rightWidth = 0.0;
    qreal rightHeight = 0.0;

    if (!m_childItems.empty()) {
        const QRectF leftBounds = m_childItems.front()->boundingRect();
        leftWidth = leftBounds.width();
        leftHeight = leftBounds.height();
    }

    qreal stackedRightHeight = 0.0;
    for (std::size_t index = 1; index < m_childItems.size(); index += 1) {
        AstGraphicsItem *child = m_childItems.at(index);
        const QRectF childBounds = child->boundingRect();
        rightWidth = std::max(rightWidth, childBounds.width());
        stackedRightHeight += childBounds.height();
        if (index + 1 < m_childItems.size()) {
            stackedRightHeight += ROW_GAP;
        }
    }
    rightHeight = stackedRightHeight;

    const bool hasLeftColumn = !m_childItems.empty();
    const bool hasRightColumn = m_childItems.size() > 1;
    qreal contentWidth = 0.0;
    if (hasLeftColumn) {
        contentWidth += STRUCTURED_CONNECTOR_TARGET_GAP + leftWidth;
    }
    if (hasRightColumn) {
        if (hasLeftColumn) {
            contentWidth += COLUMN_GAP;
        }
        contentWidth += rightWidth;
    }
    contentWidth = std::max(contentWidth, MIN_BODY_WIDTH);

    const qreal minimumWidth = headerMetrics.horizontalAdvance(labelText()) + (HEADER_X_PADDING * 2.0);
    const qreal totalWidth = std::max(minimumWidth, contentWidth + (STRUCTURED_PADDING * 2.0));
    const qreal bodyWidth = totalWidth - (STRUCTURED_PADDING * 2.0);
    const qreal bodyHeight = std::max(leftHeight, rightHeight);
    const qreal totalHeight = m_contentTop + bodyHeight + STRUCTURED_PADDING;
    setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));

    qreal leftX = STRUCTURED_PADDING + STRUCTURED_CONNECTOR_TARGET_GAP;
    if (hasLeftColumn && !hasRightColumn) {
        leftX += (bodyWidth - leftWidth) * 0.5;
    }

    const qreal leftY = m_contentTop + std::max(0.0, (bodyHeight - leftHeight) * 0.5);
    if (hasLeftColumn) {
        m_childItems.front()->setPos(leftX, leftY);
        m_leftAnchor = m_childItems.front()->pos() + m_childItems.front()->connectionAnchor();
        m_hasLeftAnchor = true;
    } else {
        m_hasLeftAnchor = false;
    }

    if (hasRightColumn) {
        const qreal rightX = STRUCTURED_PADDING + STRUCTURED_CONNECTOR_TARGET_GAP + leftWidth + COLUMN_GAP;
        qreal currentRightY = m_contentTop;
        for (std::size_t index = 1; index < m_childItems.size(); index += 1) {
            AstGraphicsItem *child = m_childItems.at(index);
            child->setPos(rightX, currentRightY);
            currentRightY += child->boundingRect().height() + ROW_GAP;
        }

        m_dividerX = STRUCTURED_PADDING + STRUCTURED_CONNECTOR_TARGET_GAP + leftWidth + (COLUMN_GAP * 0.5);
        m_rightAnchor = m_childItems.at(1)->pos() + m_childItems.at(1)->connectionAnchor();
        m_hasRightAnchor = true;
    } else {
        m_dividerX = -1.0;
        m_hasRightAnchor = false;
    }
}

void AstStructuredGraphicsItem::paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) {
    painter->setRenderHint(QPainter::Antialiasing, true);

    const QColor borderColor = astTextColor();
    QColor bodyColor = astBackgroundColor();

    painter->setPen(QPen(borderColor, 1.3));
    painter->setBrush(QBrush(bodyColor));
    painter->drawRect(boundingRect());

    painter->save();
    painter->setClipRect(boundingRect());
    painter->fillRect(QRectF(0.0, 0.0, boundingRect().width(), m_headerHeight), astBackgroundColor());
    painter->restore();

    painter->setPen(QPen(borderColor, 1.0));
    painter->drawLine(QPointF(0.0, m_headerHeight), QPointF(boundingRect().width(), m_headerHeight));

    painter->setFont(headerFont());
    painter->setPen(astTextColor());
    painter->drawText(
        QRectF(HEADER_X_PADDING, 0.0, boundingRect().width() - (HEADER_X_PADDING * 2.0), m_headerHeight),
        Qt::AlignLeft | Qt::AlignVCenter,
        labelText());

    if (m_dividerX > 0.0) {
        QPen dividerPen(borderColor, 1.0);
        dividerPen.setStyle(Qt::DashLine);
        painter->setPen(dividerPen);
        painter->drawLine(QPointF(m_dividerX, m_contentTop), QPointF(m_dividerX, boundingRect().height() - STRUCTURED_PADDING));
    }

    const QPointF titleAnchor(boundingRect().width() * 0.5, m_headerHeight);
    QPen connectorPen(borderColor, 1.0);
    connectorPen.setJoinStyle(Qt::MiterJoin);
    const qreal fanoutY = m_headerHeight + (STRUCTURED_CONNECTOR_VERTICAL_GAP * 0.5);
    std::vector<OrthogonalRoute> routes;
    if (m_hasLeftAnchor) {
        routes.push_back(OrthogonalRoute{
            routePointsForExtractedBlock(titleAnchor, m_leftAnchor.x() - STRUCTURED_CONNECTOR_TARGET_GAP, fanoutY, m_leftAnchor),
        });
    }
    if (m_hasRightAnchor) {
        routes.push_back(OrthogonalRoute{
            routePointsForExtractedBlock(titleAnchor, m_rightAnchor.x() - STRUCTURED_CONNECTOR_TARGET_GAP, fanoutY, m_rightAnchor),
        });
    }
    paintOrthogonalRoutes(painter, routes, connectorPen);
}

QPointF AstStructuredGraphicsItem::connectionAnchor() const {
    return QPointF(-NODE_CONNECTION_PORT_OFFSET, std::max<qreal>(1.0, m_headerHeight * 0.5));
}

class FunctionCallNodeGraphicsItem final : public AstGraphicsItem {
public:
    explicit FunctionCallNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr);

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override;
    QPointF connectionAnchor() const override;

private:
    struct ArgumentSlot final {
        AstGraphicsItem *item = nullptr;
        bool extracted = false;
        bool renderInlineAsText = false;
        QString inlineText;
        QString leadingSyntaxText;
        QString trailingSyntaxText;
        QString detailLabel;
        QRectF leadingSyntaxRect;
        QRectF inlineRect;
        QRectF trailingSyntaxRect;
        QRectF detailLabelRect;
        qreal routeLaneX = 0.0;
        qreal routeFanoutY = 0.0;
        QPointF targetAnchor;
    };

    void layoutCallNode();
    void layoutSpecialCallNode();
    void paintSpecialCallNode(QPainter *painter) const;
    bool usesInlineSpecialCallSyntax() const;
    qreal argumentSlotOperandWidth(const ArgumentSlot &slot) const;
    qreal argumentSlotTotalWidth(const ArgumentSlot &slot, const QFontMetricsF &syntaxMetrics) const;
    bool shouldExtractArgument(const iw::AstNodePtr &node, const AstGraphicsItem *item) const;
    bool shouldRenderInlineAsText(const iw::AstNodePtr &node) const;
    QString inlineTextForCallee(const iw::AstNodePtr &callee) const;
    QString inlineTextForArgument(const iw::AstNodePtr &argument) const;
    QFont inlineFontForNode(const iw::AstNodePtr &node, bool callee) const;
    QColor inlineColorForNode(const iw::AstNodePtr &node, bool callee) const;
    qreal inlineReferenceHeightForNode(const iw::AstNodePtr &node, bool callee) const;

    AstGraphicsItem *m_calleeItem = nullptr;
    std::vector<ArgumentSlot> m_argumentSlots;
    QString m_calleeText;
    QRectF m_calleeTextRect;
    QRectF m_mainCaptionRect;
    QRectF m_mainBoxRect;
    std::vector<QString> m_betweenSyntaxTexts;
    std::vector<QRectF> m_betweenSyntaxRects;
    QRectF m_detailCaptionRect;
    qreal m_detailTreeX = 0.0;
    qreal m_detailLabelWidth = 0.0;
    qreal m_inlineContentTop = 0.0;
    qreal m_inlineContentHeight = 0.0;
    qreal m_parenReferenceHeight = 0.0;
    qreal m_parenBaselineY = 0.0;
    qreal m_openParenWidth = 0.0;
    qreal m_closeParenWidth = 0.0;
    qreal m_openBraceWidth = 0.0;
    qreal m_closeBraceWidth = 0.0;
    qreal m_syntaxBaselineY = 0.0;
    const BuiltinOperatorInfo *m_builtinOperatorInfo = nullptr;
    SpecialCallSyntax m_specialCallSyntax = SpecialCallSyntax::None;
    bool m_calleeUsesInlineText = false;
    bool m_hasInlineCalleeItem = false;
    bool m_hasExtractedArgs = false;
};

FunctionCallNodeGraphicsItem::FunctionCallNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent)
    : AstGraphicsItem(node, parent) {
    const std::shared_ptr<iw::FunctionCallNode> callNode = std::dynamic_pointer_cast<iw::FunctionCallNode>(node);
    Q_ASSERT(callNode != nullptr);
    m_builtinOperatorInfo = builtinOperatorInfoForCall(callNode);
    m_specialCallSyntax = specialCallSyntaxForCall(callNode);

    m_calleeItem = createAstGraphicsItemInternal(callNode->callee(), this);
    m_hasInlineCalleeItem = !usesInlineSpecialCallSyntax() && canRenderNodeAsInlineMathItem(callNode->callee());
    m_calleeUsesInlineText = !usesInlineSpecialCallSyntax() && !m_hasInlineCalleeItem;
    m_calleeItem->setVisible(m_hasInlineCalleeItem);
    m_calleeText = inlineTextForCallee(callNode->callee());

    m_argumentSlots.reserve(callNode->args().size());
    for (std::size_t index = 0; index < callNode->args().size(); index += 1) {
        const iw::AstNodePtr &argument = callNode->args().at(index);
        AstGraphicsItem *argumentItem = createAstGraphicsItemInternal(argument, this);

        ArgumentSlot slot;
        slot.item = argumentItem;
        slot.detailLabel = QStringLiteral("arg %1").arg(index + 1);
        slot.extracted = shouldExtractArgument(argument, argumentItem);
        slot.renderInlineAsText = !slot.extracted && shouldRenderInlineAsText(argument);
        slot.inlineText = slot.renderInlineAsText ? inlineTextForArgument(argument) : QString();

        switch (m_specialCallSyntax) {
        case SpecialCallSyntax::IndexGet:
            if (index == 1) {
                slot.leadingSyntaxText = QStringLiteral("[");
                slot.trailingSyntaxText = QStringLiteral("]");
            }
            break;
        case SpecialCallSyntax::IndexSet:
            if (index == 1) {
                slot.leadingSyntaxText = QStringLiteral("[");
                slot.trailingSyntaxText = QStringLiteral("] := ");
            } else if (index == 2) {
                slot.trailingSyntaxText = QStringLiteral(";");
            }
            break;
        case SpecialCallSyntax::MemberGet:
            if (index > 0) {
                slot.leadingSyntaxText = QStringLiteral(".");
            }
            break;
        case SpecialCallSyntax::MemberSet:
            if (index == 1) {
                slot.leadingSyntaxText = QStringLiteral(".");
                slot.trailingSyntaxText = QStringLiteral(" := ");
            }
            break;
        case SpecialCallSyntax::None:
            break;
        }

        const bool shouldWrap = m_builtinOperatorInfo != nullptr
            ? shouldWrapBuiltinOperatorArgument(*m_builtinOperatorInfo, argument, index > 0)
            : shouldWrapSpecialCallArgument(m_specialCallSyntax, argument, index);
        if (shouldWrap) {
            slot.leadingSyntaxText += QStringLiteral("(");
            slot.trailingSyntaxText.prepend(QStringLiteral(")"));
        }
        slot.item->setVisible(slot.extracted || !slot.renderInlineAsText);
        m_argumentSlots.push_back(slot);
    }

    if (m_builtinOperatorInfo != nullptr) {
        if (m_builtinOperatorInfo->name == QStringLiteral("not")) {
            if (!m_argumentSlots.empty()) {
                m_argumentSlots.front().leadingSyntaxText = m_builtinOperatorInfo->symbol + m_argumentSlots.front().leadingSyntaxText;
            }
        } else {
            m_betweenSyntaxTexts.assign(
                m_argumentSlots.size() > 0 ? m_argumentSlots.size() - 1 : 0,
                m_builtinOperatorInfo->symbol);
        }
    }

    m_hasExtractedArgs = std::any_of(
        m_argumentSlots.begin(),
        m_argumentSlots.end(),
        [](const ArgumentSlot &slot) { return slot.extracted; });

    layoutCallNode();
}

bool FunctionCallNodeGraphicsItem::shouldExtractArgument(const iw::AstNodePtr &node, const AstGraphicsItem *item) const {
    if (!canRenderNodeAsInlineMathLayout(node)) {
        return true;
    }
    if (canRenderNodeAsInlineMathItem(node)) {
        return itemExceedsInlineLimits(item, CALL_INLINE_EXTRACTION_WIDTH_LIMIT, CALL_INLINE_EXTRACTION_AREA_LIMIT);
    }
    return false;
}

bool FunctionCallNodeGraphicsItem::shouldRenderInlineAsText(const iw::AstNodePtr &node) const {
    return canRenderNodeAsInlineMathText(node);
}

QString FunctionCallNodeGraphicsItem::inlineTextForCallee(const iw::AstNodePtr &callee) const {
    if (canRenderNodeAsInlineMathText(callee)) {
        return inlineMathTextForNode(callee);
    }
    return QStringLiteral("call");
}

QString FunctionCallNodeGraphicsItem::inlineTextForArgument(const iw::AstNodePtr &argument) const {
    return inlineMathTextForNode(argument);
}

QFont FunctionCallNodeGraphicsItem::inlineFontForNode(const iw::AstNodePtr &node, bool callee) const {
    Q_UNUSED(callee);
    if (callee && node->type() == iw::AstNodeType::IdentifierNode) {
        return functionSignatureNameFont();
    }
    if (node->type() == iw::AstNodeType::IdentifierNode) {
        return functionSignatureIdentifierFont();
    }
    return functionSignatureTypeFont();
}

QColor FunctionCallNodeGraphicsItem::inlineColorForNode(const iw::AstNodePtr &node, bool callee) const {
    if (node && node->type() == iw::AstNodeType::TextDatabaseReferenceNode) {
        return astStringColor();
    }
    if (node && node->type() == iw::AstNodeType::NumberLiteralNode) {
        return astNumberColor();
    }
    if (callee) {
        return astTextColor();
    }
    return astTextColor();
}

bool FunctionCallNodeGraphicsItem::usesInlineSpecialCallSyntax() const {
    return m_builtinOperatorInfo != nullptr || m_specialCallSyntax != SpecialCallSyntax::None;
}

qreal FunctionCallNodeGraphicsItem::inlineReferenceHeightForNode(const iw::AstNodePtr &node, bool callee) const {
    if (!node) {
        return QFontMetricsF(callSyntaxFont()).height();
    }

    if (const std::shared_ptr<iw::TextDatabaseReferenceNode> textNode = std::dynamic_pointer_cast<iw::TextDatabaseReferenceNode>(node)) {
        QString text = literalDisplayTextForNode(textNode);
        text.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
        text.replace(QChar('\r'), QChar('\n'));
        const qsizetype lineCount = std::max<qsizetype>(1, text.split(QChar('\n'), Qt::KeepEmptyParts).size());
        const QFontMetricsF metrics(trivialFont());
        return metrics.height()
            + (static_cast<qreal>(lineCount - 1) * metrics.lineSpacing())
            + (TRIVIAL_LITERAL_Y_PADDING * 2.0);
    }

    if (canRenderNodeAsInlineMathText(node)) {
        return QFontMetricsF(inlineFontForNode(node, callee)).height();
    }

    if (const std::shared_ptr<iw::FunctionCallNode> callNode = std::dynamic_pointer_cast<iw::FunctionCallNode>(node)) {
        if (!canRenderNodeAsInlineMathItem(node)) {
            return 0.0;
        }

        const QFontMetricsF syntaxMetrics(callSyntaxFont());
        qreal maxChildHeight = 0.0;
        if (builtinOperatorInfoForCall(callNode) == nullptr && specialCallSyntaxForCall(callNode) == SpecialCallSyntax::None) {
            maxChildHeight = inlineReferenceHeightForNode(callNode->callee(), true);
        }
        for (const iw::AstNodePtr &argument : callNode->args()) {
            maxChildHeight = std::max(maxChildHeight, inlineReferenceHeightForNode(argument, false));
        }

        if (builtinOperatorInfoForCall(callNode) != nullptr || specialCallSyntaxForCall(callNode) != SpecialCallSyntax::None) {
            return std::max(std::max(CALL_PLACEHOLDER_SIZE, syntaxMetrics.height()), maxChildHeight);
        }

        const qreal parenReferenceHeight = std::max(syntaxMetrics.height(), maxChildHeight);
        const QFontMetricsF parenMetrics(callParenFont(parenReferenceHeight));
        return std::max(std::max(CALL_PLACEHOLDER_SIZE, syntaxMetrics.height()), std::max(maxChildHeight, parenMetrics.height()));
    }

    if (isInlineFormulaNodeType(node->type())) {
        if (node->type() == iw::AstNodeType::TypeVarBindNode) {
            return std::max(
                QFontMetricsF(inlineFontForNode(node, false)).height(),
                QFontMetricsF(functionSignatureOperatorFont()).height());
        }
        return QFontMetricsF(functionSignatureTypeFont()).height();
    }

    return 0.0;
}

qreal FunctionCallNodeGraphicsItem::argumentSlotOperandWidth(const ArgumentSlot &slot) const {
    if (slot.extracted) {
        return CALL_PLACEHOLDER_SIZE;
    }
    if (slot.renderInlineAsText) {
        return QFontMetricsF(inlineFontForNode(slot.item->node(), false)).horizontalAdvance(slot.inlineText);
    }
    return slot.item->boundingRect().width();
}

qreal FunctionCallNodeGraphicsItem::argumentSlotTotalWidth(const ArgumentSlot &slot, const QFontMetricsF &syntaxMetrics) const {
    return syntaxMetrics.horizontalAdvance(slot.leadingSyntaxText)
        + argumentSlotOperandWidth(slot)
        + syntaxMetrics.horizontalAdvance(slot.trailingSyntaxText);
}

void FunctionCallNodeGraphicsItem::layoutSpecialCallNode() {
    Q_ASSERT(usesInlineSpecialCallSyntax());
    Q_ASSERT(m_argumentSlots.size() >= 2);

    const QFontMetricsF syntaxMetrics(callSyntaxFont());
    m_betweenSyntaxRects.clear();
    m_betweenSyntaxRects.reserve(m_betweenSyntaxTexts.size());

    qreal maxInlineItemHeight = syntaxMetrics.height();
    for (const ArgumentSlot &slot : m_argumentSlots) {
        if (slot.extracted) {
            maxInlineItemHeight = std::max(maxInlineItemHeight, CALL_PLACEHOLDER_SIZE);
        } else if (slot.renderInlineAsText) {
            maxInlineItemHeight = std::max(maxInlineItemHeight, QFontMetricsF(inlineFontForNode(slot.item->node(), false)).height());
        } else {
            maxInlineItemHeight = std::max(maxInlineItemHeight, inlineReferenceHeightForNode(slot.item->node(), false));
        }
    }

    m_parenReferenceHeight = maxInlineItemHeight;
    m_inlineContentHeight = std::max(CALL_PLACEHOLDER_SIZE, maxInlineItemHeight);
    m_openParenWidth = 0.0;
    m_closeParenWidth = 0.0;
    const bool logicalOperator = m_builtinOperatorInfo && isLogicalOperatorName(m_builtinOperatorInfo->name);
    m_openBraceWidth = logicalOperator ? syntaxMetrics.horizontalAdvance(QStringLiteral("{")) : 0.0;
    m_closeBraceWidth = logicalOperator ? syntaxMetrics.horizontalAdvance(QStringLiteral("}")) : 0.0;

    qreal mainContentWidth = m_openBraceWidth + m_closeBraceWidth;
    for (const QString &betweenSyntaxText : m_betweenSyntaxTexts) {
        mainContentWidth += syntaxMetrics.horizontalAdvance(betweenSyntaxText);
    }
    for (const ArgumentSlot &slot : m_argumentSlots) {
        mainContentWidth += argumentSlotTotalWidth(slot, syntaxMetrics);
    }
    const qreal mainWidth = mainContentWidth + (CALL_BOX_X_PADDING * 2.0);
    const qreal mainHeight = m_inlineContentHeight + (CALL_BOX_Y_PADDING * 2.0);

    m_mainCaptionRect = QRectF();
    m_detailCaptionRect = QRectF();
    m_mainBoxRect = QRectF(0.0, 0.0, mainWidth, mainHeight);
    m_inlineContentTop = m_mainBoxRect.top() + CALL_BOX_Y_PADDING;
    m_syntaxBaselineY = m_inlineContentTop + ((m_inlineContentHeight - syntaxMetrics.height()) * 0.5) + syntaxMetrics.ascent();
    m_parenBaselineY = m_syntaxBaselineY;

    qreal currentX = m_mainBoxRect.left() + CALL_BOX_X_PADDING + m_openBraceWidth;
    for (std::size_t index = 0; index < m_argumentSlots.size(); index += 1) {
        ArgumentSlot &slot = m_argumentSlots.at(index);
        if (index > 0 && index - 1 < m_betweenSyntaxTexts.size()) {
            const QString &betweenSyntaxText = m_betweenSyntaxTexts.at(index - 1);
            const qreal betweenSyntaxWidth = syntaxMetrics.horizontalAdvance(betweenSyntaxText);
            m_betweenSyntaxRects.push_back(QRectF(
                currentX,
                m_inlineContentTop + ((m_inlineContentHeight - syntaxMetrics.height()) * 0.5),
                betweenSyntaxWidth,
                syntaxMetrics.height()));
            currentX += betweenSyntaxWidth;
        }

        const qreal leadingWidth = syntaxMetrics.horizontalAdvance(slot.leadingSyntaxText);
        slot.leadingSyntaxRect = QRectF(
            currentX,
            m_inlineContentTop + ((m_inlineContentHeight - syntaxMetrics.height()) * 0.5),
            leadingWidth,
            syntaxMetrics.height());
        currentX += leadingWidth;

        if (slot.extracted) {
            slot.inlineRect = QRectF(
                currentX,
                m_inlineContentTop + ((m_inlineContentHeight - CALL_PLACEHOLDER_SIZE) * 0.5),
                CALL_PLACEHOLDER_SIZE,
                CALL_PLACEHOLDER_SIZE);
            currentX += CALL_PLACEHOLDER_SIZE;
        } else if (slot.renderInlineAsText) {
            const QFontMetricsF textMetrics(inlineFontForNode(slot.item->node(), false));
            const qreal textWidth = textMetrics.horizontalAdvance(slot.inlineText);
            slot.inlineRect = QRectF(
                currentX,
                m_inlineContentTop + ((m_inlineContentHeight - textMetrics.height()) * 0.5),
                textWidth,
                textMetrics.height());
            currentX += textWidth;
        } else {
            const QRectF itemBounds = slot.item->boundingRect();
            slot.inlineRect = QRectF();
            slot.item->setPos(currentX, m_inlineContentTop + ((m_inlineContentHeight - itemBounds.height()) * 0.5));
            currentX += itemBounds.width();
        }

        const qreal trailingWidth = syntaxMetrics.horizontalAdvance(slot.trailingSyntaxText);
        slot.trailingSyntaxRect = QRectF(
            currentX,
            m_inlineContentTop + ((m_inlineContentHeight - syntaxMetrics.height()) * 0.5),
            trailingWidth,
            syntaxMetrics.height());
        currentX += trailingWidth;
    }

    qreal detailBottom = m_mainBoxRect.bottom();
    qreal totalWidth = m_mainBoxRect.right();
    if (m_hasExtractedArgs) {
        const std::size_t extractedCount = static_cast<std::size_t>(std::count_if(
            m_argumentSlots.begin(),
            m_argumentSlots.end(),
            [](const ArgumentSlot &slot) { return slot.extracted; }));
        const qreal routeBandHeight = CALL_ROUTE_FANOUT_GAP
            + (static_cast<qreal>(std::max<std::size_t>(1, extractedCount) - 1) * CALL_ROUTE_LANE_GAP)
            + CALL_ROUTE_TO_DETAIL_GAP;
        const qreal routeSideWidth = CALL_BLOCK_TARGET_GAP
            + (static_cast<qreal>(std::max<std::size_t>(1, extractedCount) - 1) * CALL_ROUTE_LANE_GAP);
        m_detailTreeX = m_mainBoxRect.left() + CALL_BLOCK_INDENT + routeSideWidth;
        qreal currentDetailY = m_mainBoxRect.bottom() + CALL_DETAIL_Y_GAP + routeBandHeight;
        std::size_t extractedIndex = 0;
        qreal maxDetailRight = m_mainBoxRect.right();
        for (ArgumentSlot &slot : m_argumentSlots) {
            if (!slot.extracted) {
                continue;
            }

            slot.item->setVisible(true);
            slot.item->setPos(m_detailTreeX, currentDetailY);
            const QRectF detailBounds = slot.item->boundingRect();
            slot.targetAnchor = slot.item->pos() + slot.item->connectionAnchor();
            slot.detailLabelRect = QRectF();
            slot.routeLaneX = slot.targetAnchor.x()
                - CALL_BLOCK_TARGET_GAP
                - (static_cast<qreal>(extractedIndex) * CALL_ROUTE_LANE_GAP);
            slot.routeFanoutY = m_mainBoxRect.bottom()
                + CALL_DETAIL_Y_GAP
                + CALL_ROUTE_FANOUT_GAP
                + (static_cast<qreal>(extractedIndex) * CALL_ROUTE_LANE_GAP);

            maxDetailRight = std::max(maxDetailRight, m_detailTreeX + detailBounds.width());
            currentDetailY += detailBounds.height() + CALL_DETAIL_ROW_GAP;
            extractedIndex += 1;
        }
        detailBottom = currentDetailY - CALL_DETAIL_ROW_GAP;
        totalWidth = std::max(totalWidth, maxDetailRight + CALL_OUTER_MARGIN);
    } else {
        m_detailTreeX = 0.0;
        m_detailLabelWidth = 0.0;
    }

    const qreal totalHeight = std::max(m_mainBoxRect.bottom(), detailBottom) + (m_hasExtractedArgs ? CALL_OUTER_MARGIN : 0.0);
    setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));
}

void FunctionCallNodeGraphicsItem::layoutCallNode() {
    if (usesInlineSpecialCallSyntax()) {
        layoutSpecialCallNode();
        return;
    }

    const QFontMetricsF syntaxMetrics(callSyntaxFont());

    qreal maxInlineItemHeight = 0.0;
    if (m_hasInlineCalleeItem) {
        maxInlineItemHeight = std::max(maxInlineItemHeight, inlineReferenceHeightForNode(m_calleeItem->node(), true));
    } else if (m_calleeUsesInlineText) {
        maxInlineItemHeight = std::max(maxInlineItemHeight, QFontMetricsF(inlineFontForNode(m_calleeItem->node(), true)).height());
    }
    for (const ArgumentSlot &slot : m_argumentSlots) {
        if (!slot.extracted) {
            if (slot.renderInlineAsText) {
                maxInlineItemHeight = std::max(maxInlineItemHeight, QFontMetricsF(inlineFontForNode(slot.item->node(), false)).height());
            } else {
                maxInlineItemHeight = std::max(maxInlineItemHeight, inlineReferenceHeightForNode(slot.item->node(), false));
            }
        }
    }

    m_parenReferenceHeight = std::max(syntaxMetrics.height(), maxInlineItemHeight);
    const qreal targetInlineHeight = std::max(std::max(CALL_PLACEHOLDER_SIZE, syntaxMetrics.height()), maxInlineItemHeight);
    const QFont parenFont = callParenFont(m_parenReferenceHeight);
    const QFontMetricsF parenMetrics(parenFont);
    m_inlineContentHeight = std::max(targetInlineHeight, parenMetrics.height());
    const QFont calleeFont = inlineFontForNode(m_calleeItem->node(), true);
    const QFontMetricsF calleeMetrics(calleeFont);
    const qreal calleeWidth = m_hasInlineCalleeItem
        ? m_calleeItem->boundingRect().width()
        : calleeMetrics.horizontalAdvance(m_calleeText);
    m_openParenWidth = parenMetrics.horizontalAdvance(QStringLiteral("("));
    const qreal commaWidth = syntaxMetrics.horizontalAdvance(QStringLiteral(", "));
    m_closeParenWidth = parenMetrics.horizontalAdvance(QStringLiteral(")"));

    qreal mainContentWidth = calleeWidth + m_openParenWidth + m_closeParenWidth;
    for (std::size_t index = 0; index < m_argumentSlots.size(); index += 1) {
        ArgumentSlot &slot = m_argumentSlots.at(index);
        if (index > 0) {
            mainContentWidth += commaWidth;
        }

        qreal slotWidth = CALL_PLACEHOLDER_SIZE;
        if (!slot.extracted) {
            if (slot.renderInlineAsText) {
                slotWidth = QFontMetricsF(inlineFontForNode(slot.item->node(), false)).horizontalAdvance(slot.inlineText);
            } else {
                slotWidth = slot.item->boundingRect().width();
            }
        }
        mainContentWidth += slotWidth;
    }
    const qreal mainWidth = mainContentWidth + (CALL_BOX_X_PADDING * 2.0);
    const qreal mainHeight = m_inlineContentHeight + (CALL_BOX_Y_PADDING * 2.0);
    const qreal mainX = CALL_OUTER_MARGIN;
    const qreal mainY = CALL_OUTER_MARGIN;

    m_mainCaptionRect = QRectF();
    m_mainBoxRect = QRectF(mainX, mainY, mainWidth, mainHeight);
    m_inlineContentTop = m_mainBoxRect.top() + CALL_BOX_Y_PADDING;
    m_syntaxBaselineY = m_inlineContentTop + ((m_inlineContentHeight - syntaxMetrics.height()) * 0.5) + syntaxMetrics.ascent();
    m_parenBaselineY = m_inlineContentTop + ((m_inlineContentHeight - parenMetrics.height()) * 0.5) + parenMetrics.ascent();

    qreal currentX = m_mainBoxRect.left() + CALL_BOX_X_PADDING;
    if (m_hasInlineCalleeItem) {
        m_calleeTextRect = QRectF();
        const QRectF calleeBounds = m_calleeItem->boundingRect();
        m_calleeItem->setPos(currentX, m_inlineContentTop + ((m_inlineContentHeight - calleeBounds.height()) * 0.5));
        currentX += calleeBounds.width();
    } else {
        m_calleeTextRect = QRectF(
            currentX,
            m_inlineContentTop + ((m_inlineContentHeight - calleeMetrics.height()) * 0.5),
            calleeWidth,
            calleeMetrics.height());
        currentX += calleeWidth;
    }
    currentX += m_openParenWidth;

    for (std::size_t index = 0; index < m_argumentSlots.size(); index += 1) {
        ArgumentSlot &slot = m_argumentSlots.at(index);
        if (index > 0) {
            currentX += commaWidth;
        }

        if (slot.extracted) {
            slot.inlineRect = QRectF(
                currentX,
                m_inlineContentTop + ((m_inlineContentHeight - CALL_PLACEHOLDER_SIZE) * 0.5),
                CALL_PLACEHOLDER_SIZE,
                CALL_PLACEHOLDER_SIZE);
            currentX += CALL_PLACEHOLDER_SIZE;
            continue;
        }

        if (slot.renderInlineAsText) {
            const QFontMetricsF textMetrics(inlineFontForNode(slot.item->node(), false));
            const qreal textWidth = textMetrics.horizontalAdvance(slot.inlineText);
            slot.inlineRect = QRectF(
                currentX,
                m_inlineContentTop + ((m_inlineContentHeight - textMetrics.height()) * 0.5),
                textWidth,
                textMetrics.height());
            currentX += textWidth;
            continue;
        }

        const QRectF itemBounds = slot.item->boundingRect();
        slot.inlineRect = QRectF();
        slot.item->setPos(currentX, m_inlineContentTop + ((m_inlineContentHeight - itemBounds.height()) * 0.5));
        currentX += itemBounds.width();
    }

    qreal detailBottom = m_mainBoxRect.bottom();
    qreal totalWidth = m_mainBoxRect.right() + CALL_OUTER_MARGIN;

    if (m_hasExtractedArgs) {
        const std::size_t extractedCount = static_cast<std::size_t>(std::count_if(
            m_argumentSlots.begin(),
            m_argumentSlots.end(),
            [](const ArgumentSlot &slot) { return slot.extracted; }));
        const qreal routeBandHeight = CALL_ROUTE_FANOUT_GAP
            + (static_cast<qreal>(std::max<std::size_t>(1, extractedCount) - 1) * CALL_ROUTE_LANE_GAP)
            + CALL_ROUTE_TO_DETAIL_GAP;
        const qreal routeSideWidth = CALL_BLOCK_TARGET_GAP
            + (static_cast<qreal>(std::max<std::size_t>(1, extractedCount) - 1) * CALL_ROUTE_LANE_GAP);
        m_detailTreeX = m_mainBoxRect.left() + CALL_BLOCK_INDENT + routeSideWidth;
        m_detailCaptionRect = QRectF();

        qreal currentDetailY = m_mainBoxRect.bottom() + CALL_DETAIL_Y_GAP + routeBandHeight;
        std::size_t extractedIndex = 0;
        qreal maxDetailRight = m_mainBoxRect.right();
        for (ArgumentSlot &slot : m_argumentSlots) {
            if (!slot.extracted) {
                continue;
            }

            slot.item->setVisible(true);
            slot.item->setPos(m_detailTreeX, currentDetailY);
            const QRectF detailBounds = slot.item->boundingRect();
            slot.targetAnchor = slot.item->pos() + slot.item->connectionAnchor();
            slot.detailLabelRect = QRectF();
            slot.routeLaneX = slot.targetAnchor.x()
                - CALL_BLOCK_TARGET_GAP
                - (static_cast<qreal>(extractedIndex) * CALL_ROUTE_LANE_GAP);
            slot.routeFanoutY = m_mainBoxRect.bottom()
                + CALL_DETAIL_Y_GAP
                + CALL_ROUTE_FANOUT_GAP
                + (static_cast<qreal>(extractedIndex) * CALL_ROUTE_LANE_GAP);

            maxDetailRight = std::max(maxDetailRight, m_detailTreeX + detailBounds.width());
            currentDetailY += detailBounds.height() + CALL_DETAIL_ROW_GAP;
            extractedIndex += 1;
        }

        detailBottom = currentDetailY - CALL_DETAIL_ROW_GAP;
        totalWidth = std::max(totalWidth, maxDetailRight + CALL_OUTER_MARGIN);
    } else {
        m_detailCaptionRect = QRectF();
        m_detailTreeX = 0.0;
        m_detailLabelWidth = 0.0;
    }

    const qreal totalHeight = std::max(m_mainBoxRect.bottom(), detailBottom) + CALL_OUTER_MARGIN;
    setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));
}

void FunctionCallNodeGraphicsItem::paintSpecialCallNode(QPainter *painter) const {
    Q_ASSERT(usesInlineSpecialCallSyntax());

    const QColor borderColor = astTextColor();
    const QColor textColor = astTextColor();
    const bool logicalOperator = m_builtinOperatorInfo && isLogicalOperatorName(m_builtinOperatorInfo->name);
    const QColor operatorColor = logicalOperator ? astLogicalKeywordColor() : astTextColor();

    painter->setFont(callSyntaxFont());
    painter->setPen(operatorColor);
    if (logicalOperator) {
        painter->drawText(QPointF(m_mainBoxRect.left() + CALL_BOX_X_PADDING, m_syntaxBaselineY), QStringLiteral("{"));
        painter->drawText(QPointF(m_mainBoxRect.right() - CALL_BOX_X_PADDING - m_closeBraceWidth, m_syntaxBaselineY), QStringLiteral("}"));
    }
    for (std::size_t index = 0; index < m_betweenSyntaxRects.size(); index += 1) {
        painter->drawText(QPointF(m_betweenSyntaxRects.at(index).left(), m_syntaxBaselineY), m_betweenSyntaxTexts.at(index));
    }

    std::vector<OrthogonalRoute> routes;
    const std::size_t extractedCount = static_cast<std::size_t>(std::count_if(
        m_argumentSlots.begin(),
        m_argumentSlots.end(),
        [](const ArgumentSlot &slot) { return slot.extracted; }));
    routes.reserve(extractedCount);

    for (const ArgumentSlot &slot : m_argumentSlots) {
        painter->setFont(callSyntaxFont());
        painter->setPen(operatorColor);
        if (!slot.leadingSyntaxText.isEmpty()) {
            painter->drawText(QPointF(slot.leadingSyntaxRect.left(), m_syntaxBaselineY), slot.leadingSyntaxText);
        }

        if (slot.extracted) {
            const QRectF placeholderRect = slot.inlineRect;
            QPen placeholderPen(borderColor, 1.3);
            placeholderPen.setStyle(Qt::DashLine);
            painter->setPen(placeholderPen);
            painter->setBrush(Qt::NoBrush);
            painter->drawRect(placeholderRect);

            const QPointF start(slot.inlineRect.center().x(), slot.inlineRect.bottom());
            routes.push_back(OrthogonalRoute{
                routePointsForExtractedBlock(start, slot.routeLaneX, slot.routeFanoutY, slot.targetAnchor),
            });
            painter->setPen(textColor);
        } else if (slot.renderInlineAsText) {
            const QFont textFont = inlineFontForNode(slot.item->node(), false);
            const QFontMetricsF textMetrics(textFont);
            painter->setFont(textFont);
            painter->setPen(inlineColorForNode(slot.item->node(), false));
            painter->drawText(QPointF(slot.inlineRect.left(), slot.inlineRect.top() + textMetrics.ascent()), slot.inlineText);
        }

        painter->setFont(callSyntaxFont());
        painter->setPen(operatorColor);
        if (!slot.trailingSyntaxText.isEmpty()) {
            painter->drawText(QPointF(slot.trailingSyntaxRect.left(), m_syntaxBaselineY), slot.trailingSyntaxText);
        }
    }

    QPen routePen(borderColor, 1.2);
    routePen.setJoinStyle(Qt::MiterJoin);
    paintOrthogonalRoutes(painter, routes, routePen);
}

void FunctionCallNodeGraphicsItem::paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) {
    painter->setRenderHint(QPainter::Antialiasing, true);
    painter->setRenderHint(QPainter::TextAntialiasing, true);

    if (usesInlineSpecialCallSyntax()) {
        paintSpecialCallNode(painter);
        return;
    }

    const QFontMetricsF syntaxMetrics(callSyntaxFont());
    const QFont parenFont = callParenFont(m_parenReferenceHeight);
    const QColor borderColor = astTextColor();
    const QColor textColor = astTextColor();
    const QColor operatorColor = astTextColor();
    std::vector<OrthogonalRoute> routes;
    const std::size_t extractedCount = static_cast<std::size_t>(std::count_if(
        m_argumentSlots.begin(),
        m_argumentSlots.end(),
        [](const ArgumentSlot &slot) { return slot.extracted; }));
    routes.reserve(extractedCount);

    painter->setFont(callSyntaxFont());
    painter->setPen(operatorColor);
    qreal currentX = m_mainBoxRect.left() + CALL_BOX_X_PADDING;
    if (m_hasInlineCalleeItem) {
        currentX += m_calleeItem->boundingRect().width();
    } else {
        const QFont calleeFont = inlineFontForNode(m_calleeItem->node(), true);
        const QFontMetricsF calleeMetrics(calleeFont);
        painter->setFont(calleeFont);
        painter->setPen(inlineColorForNode(m_calleeItem->node(), true));
        painter->drawText(QPointF(m_calleeTextRect.left(), m_calleeTextRect.top() + calleeMetrics.ascent()), m_calleeText);
        currentX += m_calleeTextRect.width();
    }
    painter->setPen(operatorColor);
    painter->setFont(parenFont);
    painter->drawText(QPointF(currentX, m_parenBaselineY), QStringLiteral("("));
    currentX += m_openParenWidth;
    painter->setFont(callSyntaxFont());

    for (std::size_t index = 0; index < m_argumentSlots.size(); index += 1) {
        const ArgumentSlot &slot = m_argumentSlots.at(index);
        if (index > 0) {
            painter->setPen(operatorColor);
            painter->drawText(QPointF(currentX, m_syntaxBaselineY), QStringLiteral(", "));
            currentX += syntaxMetrics.horizontalAdvance(QStringLiteral(", "));
        }

        if (slot.extracted) {
            const QRectF placeholderRect = slot.inlineRect;
            QPen placeholderPen(borderColor, 1.3);
            placeholderPen.setStyle(Qt::DashLine);
            painter->setPen(placeholderPen);
            painter->setBrush(Qt::NoBrush);
            painter->drawRect(placeholderRect);

            const QPointF start(slot.inlineRect.center().x(), slot.inlineRect.bottom());
            routes.push_back(OrthogonalRoute{
                routePointsForExtractedBlock(start, slot.routeLaneX, slot.routeFanoutY, slot.targetAnchor),
            });
            currentX += CALL_PLACEHOLDER_SIZE;
            painter->setPen(textColor);
            painter->setPen(operatorColor);
            continue;
        }

        if (slot.renderInlineAsText) {
            const QFont textFont = inlineFontForNode(slot.item->node(), false);
            const QFontMetricsF textMetrics(textFont);
            painter->setFont(textFont);
            painter->setPen(inlineColorForNode(slot.item->node(), false));
            painter->drawText(QPointF(slot.inlineRect.left(), slot.inlineRect.top() + textMetrics.ascent()), slot.inlineText);
            currentX += slot.inlineRect.width();
            painter->setFont(callSyntaxFont());
            painter->setPen(operatorColor);
            continue;
        }

        currentX += slot.item->boundingRect().width();
    }

    painter->setPen(operatorColor);
    painter->setFont(parenFont);
    painter->drawText(QPointF(currentX, m_parenBaselineY), QStringLiteral(")"));

    QPen routePen(borderColor, 1.2);
    routePen.setJoinStyle(Qt::MiterJoin);
    paintOrthogonalRoutes(painter, routes, routePen);
}

QPointF FunctionCallNodeGraphicsItem::connectionAnchor() const {
    return QPointF(
        m_mainBoxRect.left() - NODE_CONNECTION_PORT_OFFSET,
        m_inlineContentTop + (m_inlineContentHeight * 0.5));
}

class AssignmentStatementGraphicsItem : public AstGraphicsItem {
public:
    enum class StatementKind {
        DefineVar,
        SetVar,
        LetBind,
    };

    AssignmentStatementGraphicsItem(const iw::AstNodePtr &node, StatementKind statementKind, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent),
          m_statementKind(statementKind) {
        if (m_statementKind == StatementKind::DefineVar) {
            const std::shared_ptr<iw::DvarNode> dvarNode = std::dynamic_pointer_cast<iw::DvarNode>(node);
            Q_ASSERT(dvarNode != nullptr);

            initializeBoundNameAndType(dvarNode->bind());
            m_valueNode = dvarNode->value();
            m_hasTrailingPeriod = false;
        } else if (m_statementKind == StatementKind::SetVar) {
            const std::shared_ptr<iw::SetNode> setNode = std::dynamic_pointer_cast<iw::SetNode>(node);
            Q_ASSERT(setNode != nullptr);

            m_nameText = setNode->identifier()->name();
            m_valueNode = setNode->value();
        }

        m_valueItem = createAstGraphicsItemInternal(m_valueNode, this);
        decideValueLayout();
        layoutStatement();
    }

    AssignmentStatementGraphicsItem(const iw::AstNodePtr &ownerNode, const iw::AstNodePtr &bindNode, const iw::AstNodePtr &valueNode, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(ownerNode, parent),
          m_statementKind(StatementKind::LetBind),
          m_valueNode(valueNode) {
        initializeBoundNameAndType(bindNode);
        m_valueItem = createAstGraphicsItemInternal(m_valueNode, this);
        decideValueLayout();
        layoutStatement();
    }

    void refreshLayout() override {
        decideValueLayout();
        layoutStatement();
        update();
    }

    QPointF connectionAnchor() const override {
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, m_mainLineCenterY);
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing, true);
        painter->setRenderHint(QPainter::TextAntialiasing, true);

        for (const TextRunLayout &run : m_textRuns) {
            painter->setFont(run.font);
            painter->setPen(run.color);
            painter->drawText(QPointF(run.x, run.baseline), run.text);
        }

        if (m_valueLayoutMode != ValueLayoutMode::DetailPlaceholder) {
            return;
        }

        const QColor borderColor = astTextColor();
        QPen placeholderPen(borderColor, 1.2);
        placeholderPen.setStyle(Qt::DashLine);
        painter->setPen(placeholderPen);
        painter->setBrush(Qt::NoBrush);
        painter->drawRect(m_placeholderRect);

        const QPointF start = QPointF(m_placeholderRect.center().x(), m_placeholderRect.bottom());
        const QPointF target = m_valueTargetAnchor;
        const qreal approachX = target.x() - CALL_BLOCK_TARGET_GAP;

        QPen connectorPen(borderColor, 1.2);
        connectorPen.setJoinStyle(Qt::MiterJoin);
        paintOrthogonalRoutes(
            painter,
            {OrthogonalRoute{routePointsForExtractedBlock(start, approachX, m_routeFanoutY, target)}},
            connectorPen);
    }

private:
    enum class ValueLayoutMode {
        InlineText,
        InlineItem,
        DetailPlaceholder,
    };

    struct TextPart final {
        QString text;
        QFont font;
        QColor color;
        qreal width = 0.0;
        qreal height = 0.0;
        qreal ascent = 0.0;
    };

    struct TextRunLayout final {
        QString text;
        QFont font;
        QColor color;
        qreal x = 0.0;
        qreal baseline = 0.0;
    };

    void addTextPart(std::vector<TextPart> &parts, const QString &text, const QFont &font, const QColor &color) const {
        if (text.isEmpty()) {
            return;
        }
        const QFontMetricsF metrics(font);
        parts.push_back(TextPart{text, font, color, metrics.horizontalAdvance(text), metrics.height(), metrics.ascent()});
    }

    void initializeBoundNameAndType(const iw::AstNodePtr &bindNode) {
        if (const iw::TypeVarBindNodePtr typedBindNode = std::dynamic_pointer_cast<iw::TypeVarBindNode>(bindNode)) {
            m_nameText = typedBindNode->identifier()->name();
            m_hasTypeText = true;
            m_typeText = signatureTextForAstNode(typedBindNode->typeExpression());
            return;
        }

        m_nameText = signatureTextForAstNode(bindNode);
        m_hasTypeText = false;
        m_typeText.clear();
    }

    bool canInlineValueAsItem() const {
        if (!m_valueItem || !m_valueNode) {
            return false;
        }
        if (!canRenderNodeAsInlineMathItem(m_valueNode)) {
            return false;
        }
        return !itemExceedsInlineLimits(
            m_valueItem,
            ASSIGNMENT_INLINE_VALUE_WIDTH_LIMIT,
            ASSIGNMENT_INLINE_VALUE_AREA_LIMIT);
    }

    void decideValueLayout() {
        if (!m_valueItem) {
            return;
        }

        if (canRenderNodeAsInlineAssignmentText(m_valueNode)) {
            m_valueLayoutMode = ValueLayoutMode::InlineText;
            m_valueText = inlineAssignmentTextForNode(m_valueNode);
            m_valueItem->setVisible(false);
            return;
        }

        if (canInlineValueAsItem()) {
            m_valueLayoutMode = ValueLayoutMode::InlineItem;
            m_valueText.clear();
            m_valueItem->setVisible(true);
            return;
        }

        m_valueLayoutMode = ValueLayoutMode::DetailPlaceholder;
        m_valueText.clear();
        m_valueItem->setVisible(true);
    }

    void layoutStatement() {
        const QColor keywordColor = astKeywordColor();
        const QColor nameColor = astTextColor();
        const QColor operatorColor = astTextColor();
        const QColor formulaColor = astTypeColor();

        std::vector<TextPart> parts;
        parts.reserve(8);

        if (m_statementKind == StatementKind::DefineVar) {
            addTextPart(parts, QStringLiteral("Var "), assignmentKeywordFont(), keywordColor);
        }
        addTextPart(parts, m_nameText, assignmentIdentifierFont(m_statementKind == StatementKind::DefineVar), nameColor);
        if (m_hasTypeText) {
            addTextPart(parts, QStringLiteral(":"), assignmentOperatorFont(), operatorColor);
            addTextPart(parts, m_typeText, assignmentTypeFont(), formulaColor);
        }
        addTextPart(parts, QStringLiteral(" := "), assignmentOperatorFont(), operatorColor);

        const bool valueInlineAsText = m_valueLayoutMode == ValueLayoutMode::InlineText;
        const bool valueInlineAsItem = m_valueLayoutMode == ValueLayoutMode::InlineItem;
        const bool valueAsPlaceholder = m_valueLayoutMode == ValueLayoutMode::DetailPlaceholder;

        if (valueInlineAsText) {
            addTextPart(parts, m_valueText, assignmentValueFontForNode(m_valueNode), assignmentValueColorForNode(m_valueNode));
        }
        if (m_hasTrailingPeriod) {
            addTextPart(parts, QStringLiteral("."), assignmentOperatorFont(), operatorColor);
        }

        qreal mainLineWidth = 0.0;
        qreal mainLineHeight = 0.0;
        for (const TextPart &part : parts) {
            mainLineWidth += part.width;
            mainLineHeight = std::max(mainLineHeight, part.height);
        }
        if (valueInlineAsItem) {
            const QRectF valueBounds = m_valueItem->boundingRect();
            mainLineWidth += valueBounds.width();
            mainLineHeight = std::max(mainLineHeight, valueBounds.height());
        }
        if (valueAsPlaceholder) {
            mainLineWidth += ASSIGNMENT_PLACEHOLDER_SIZE;
            mainLineHeight = std::max(mainLineHeight, ASSIGNMENT_PLACEHOLDER_SIZE);
        }

        const QRectF detailBounds = valueAsPlaceholder ? m_valueItem->boundingRect() : QRectF();
        const qreal detailWidth = valueAsPlaceholder ? detailBounds.width() : 0.0;
        const qreal detailHeight = valueAsPlaceholder ? detailBounds.height() : 0.0;
        const qreal totalWidth = valueAsPlaceholder
            ? (ASSIGNMENT_PADDING * 2.0) + std::max(mainLineWidth, ASSIGNMENT_DETAIL_X_GAP + detailWidth)
            : (ASSIGNMENT_PADDING * 2.0) + mainLineWidth;
        const qreal totalHeight = valueAsPlaceholder
            ? (ASSIGNMENT_PADDING * 2.0) + mainLineHeight + ASSIGNMENT_DETAIL_Y_GAP + detailHeight
            : (ASSIGNMENT_PADDING * 2.0) + mainLineHeight;

        setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));

        m_textRuns.clear();
        m_textRuns.reserve(parts.size());
        m_placeholderRect = QRectF();
        m_valueTargetAnchor = QPointF();
        m_routeFanoutY = 0.0;

        const qreal mainTop = ASSIGNMENT_PADDING;
        const qreal detailTop = ASSIGNMENT_PADDING + mainLineHeight + ASSIGNMENT_DETAIL_Y_GAP;
        m_mainLineCenterY = mainTop + (mainLineHeight * 0.5);
        qreal currentX = ASSIGNMENT_PADDING;

        for (std::size_t index = 0; index < parts.size(); index += 1) {
            const TextPart &part = parts.at(index);
            m_textRuns.push_back(TextRunLayout{
                part.text,
                part.font,
                part.color,
                currentX,
                mainTop + ((mainLineHeight - part.height) * 0.5) + part.ascent,
            });
            currentX += part.width;

            const bool beforeTrailingPeriod = m_hasTrailingPeriod && index + 1 == parts.size() - 1;
            if (beforeTrailingPeriod) {
                if (valueInlineAsItem) {
                    const QRectF valueBounds = m_valueItem->boundingRect();
                    m_valueItem->setPos(currentX, mainTop + ((mainLineHeight - valueBounds.height()) * 0.5));
                    currentX += valueBounds.width();
                } else if (valueAsPlaceholder) {
                    m_placeholderRect = QRectF(
                        currentX,
                        mainTop + ((mainLineHeight - ASSIGNMENT_PLACEHOLDER_SIZE) * 0.5),
                        ASSIGNMENT_PLACEHOLDER_SIZE,
                        ASSIGNMENT_PLACEHOLDER_SIZE);
                    currentX += ASSIGNMENT_PLACEHOLDER_SIZE;
                }
            }
        }

        if (!m_hasTrailingPeriod) {
            if (valueInlineAsItem) {
                const QRectF valueBounds = m_valueItem->boundingRect();
                m_valueItem->setPos(currentX, mainTop + ((mainLineHeight - valueBounds.height()) * 0.5));
                currentX += valueBounds.width();
            } else if (valueAsPlaceholder) {
                m_placeholderRect = QRectF(
                    currentX,
                    mainTop + ((mainLineHeight - ASSIGNMENT_PLACEHOLDER_SIZE) * 0.5),
                    ASSIGNMENT_PLACEHOLDER_SIZE,
                    ASSIGNMENT_PLACEHOLDER_SIZE);
                currentX += ASSIGNMENT_PLACEHOLDER_SIZE;
            }
        }

        if (valueAsPlaceholder) {
            const qreal detailX = ASSIGNMENT_PADDING + ASSIGNMENT_DETAIL_X_GAP;
            m_valueItem->setPos(detailX, detailTop);
            m_valueTargetAnchor = m_valueItem->pos() + m_valueItem->connectionAnchor();
            m_routeFanoutY = m_placeholderRect.bottom() + ((detailTop - m_placeholderRect.bottom()) * 0.5);
        }
    }

    StatementKind m_statementKind;
    bool m_hasTypeText = false;
    bool m_hasTrailingPeriod = false;
    QString m_nameText;
    QString m_typeText;
    iw::AstNodePtr m_valueNode;
    AstGraphicsItem *m_valueItem = nullptr;
    ValueLayoutMode m_valueLayoutMode = ValueLayoutMode::InlineText;
    QString m_valueText;
    std::vector<TextRunLayout> m_textRuns;
    QRectF m_placeholderRect;
    QPointF m_valueTargetAnchor;
    qreal m_routeFanoutY = 0.0;
    qreal m_mainLineCenterY = 0.0;
};

class DvarNodeGraphicsItem final : public AssignmentStatementGraphicsItem {
public:
    explicit DvarNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AssignmentStatementGraphicsItem(node, StatementKind::DefineVar, parent) {
    }
};

class SetNodeGraphicsItem final : public AssignmentStatementGraphicsItem {
public:
    explicit SetNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AssignmentStatementGraphicsItem(node, StatementKind::SetVar, parent) {
    }
};

class LetBindingGraphicsItem final : public AssignmentStatementGraphicsItem {
public:
    LetBindingGraphicsItem(const iw::AstNodePtr &ownerNode, const iw::AstNodePtr &bindNode, const iw::AstNodePtr &valueNode, QGraphicsItem *parent = nullptr)
        : AssignmentStatementGraphicsItem(ownerNode, bindNode, valueNode, parent) {
    }
};

class InlineTextRunGraphicsItem : public AstGraphicsItem {
public:
    InlineTextRunGraphicsItem(const iw::AstNodePtr &node, std::vector<InlineTextRunSpec> runs, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent),
          m_runs(std::move(runs)) {
        layoutRuns();
    }

    void refreshLayout() override {
        layoutRuns();
        update();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::TextAntialiasing, true);
        for (const PositionedRun &run : m_positionedRuns) {
            painter->setFont(run.font);
            painter->setPen(run.color);
            painter->drawText(QPointF(run.x, run.baseline), run.text);
        }
    }

    QPointF connectionAnchor() const override {
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, m_firstLineCenterY);
    }

private:
    struct PositionedRun final {
        QString text;
        QFont font;
        QColor color;
        qreal x = 0.0;
        qreal baseline = 0.0;
        qreal width = 0.0;
        qreal height = 0.0;
        qreal ascent = 0.0;
    };

    void layoutRuns() {
        m_positionedRuns.clear();
        m_positionedRuns.reserve(m_runs.size());

        qreal totalWidth = 0.0;
        qreal lineHeight = 0.0;
        for (const InlineTextRunSpec &run : m_runs) {
            if (run.text.isEmpty()) {
                continue;
            }
            const QFontMetricsF metrics(run.font);
            PositionedRun positionedRun;
            positionedRun.text = run.text;
            positionedRun.font = run.font;
            positionedRun.color = run.color;
            positionedRun.width = metrics.horizontalAdvance(run.text);
            positionedRun.height = metrics.height();
            positionedRun.ascent = metrics.ascent();
            totalWidth += positionedRun.width;
            lineHeight = std::max(lineHeight, positionedRun.height);
            m_positionedRuns.push_back(positionedRun);
        }

        qreal currentX = 0.0;
        for (PositionedRun &run : m_positionedRuns) {
            run.x = currentX;
            run.baseline = ((lineHeight - run.height) * 0.5) + run.ascent;
            currentX += run.width;
        }
        m_firstLineCenterY = lineHeight * 0.5;

        setBounds(QRectF(0.0, 0.0, totalWidth, lineHeight));
    }

    std::vector<InlineTextRunSpec> m_runs;
    std::vector<PositionedRun> m_positionedRuns;
    qreal m_firstLineCenterY = 0.0;
};

class BracketedBlockGraphicsItem : public AstGraphicsItem {
public:
    explicit BracketedBlockGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent) {
    }

    void refreshLayout() override {
        for (Entry &entry : m_entries) {
            if (entry.kind == EntryKind::Item && entry.item) {
                entry.item->refreshLayout();
            }
        }
        layoutEntries();
        update();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing, true);
        painter->setRenderHint(QPainter::TextAntialiasing, true);

        const QColor bracketColor = astTextColor();
        QPen bracketPen(bracketColor, 1.35);
        bracketPen.setJoinStyle(Qt::MiterJoin);
        painter->setPen(bracketPen);

        const qreal top = BRACKET_BLOCK_PADDING * 0.5;
        const qreal bottom = boundingRect().height() - (BRACKET_BLOCK_PADDING * 0.5);
        const qreal leftX = m_leftBracketX;
        const qreal rightX = m_rightBracketX;

        painter->drawLine(QPointF(leftX + BRACKET_BLOCK_HOOK, top), QPointF(leftX, top));
        paintBracketVertical(painter, leftX, top, bottom);
        painter->drawLine(QPointF(leftX, bottom), QPointF(leftX + BRACKET_BLOCK_HOOK, bottom));

        painter->drawLine(QPointF(rightX - BRACKET_BLOCK_HOOK, top), QPointF(rightX, top));
        paintBracketVertical(painter, rightX, top, bottom);
        painter->drawLine(QPointF(rightX, bottom), QPointF(rightX - BRACKET_BLOCK_HOOK, bottom));

        for (const Entry &entry : m_entries) {
            if (entry.kind != EntryKind::Text) {
                continue;
            }
            painter->setFont(entry.font);
            painter->setPen(entry.color);
            painter->drawText(QPointF(entry.x, entry.baseline), entry.text);
        }
    }

    QPointF connectionAnchor() const override {
        for (const Entry &entry : m_entries) {
            if (entry.kind == EntryKind::Item && entry.item) {
                return QPointF(
                    -NODE_CONNECTION_PORT_OFFSET,
                    entry.item->pos().y() + (entry.item->boundingRect().height() * 0.5));
            }
            if (entry.kind == EntryKind::Text) {
                return QPointF(-NODE_CONNECTION_PORT_OFFSET, entry.baseline - (entry.height * 0.5));
            }
        }
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, std::max<qreal>(1.0, boundingRect().height() * 0.25));
    }

    QPointF exitAnchor() const override {
        return QPointF(
            boundingRect().right() + BRANCH_LEAD_BOX_MARGIN,
            std::max<qreal>(0.0, boundingRect().bottom() + BRANCH_LEAD_BOX_MARGIN - NODE_CONNECTION_PORT_OFFSET));
    }

protected:
    enum class EntryKind {
        Text,
        Item,
    };

    struct Entry final {
        EntryKind kind;
        QString text;
        QFont font;
        QColor color;
        AstGraphicsItem *item = nullptr;
        qreal indent = 0.0;
        qreal x = 0.0;
        qreal baseline = 0.0;
        qreal width = 0.0;
        qreal height = 0.0;
        qreal ascent = 0.0;
    };

    const std::vector<Entry> &entries() const {
        return m_entries;
    }

    virtual void paintBracketVertical(QPainter *painter, qreal x, qreal top, qreal bottom) const {
        painter->drawLine(QPointF(x, top), QPointF(x, bottom));
    }

    void addTextEntry(const QString &text, const QFont &font, const QColor &color, qreal indent = 0.0) {
        m_entries.push_back(Entry{EntryKind::Text, text, font, color, nullptr, indent});
    }

    void addKeywordEntry(const QString &text, qreal indent = 0.0) {
        addTextEntry(text, assignmentKeywordFont(), astKeywordColor(), indent);
    }

    void addItemEntry(AstGraphicsItem *item, qreal indent = 0.0) {
        m_entries.push_back(Entry{EntryKind::Item, QString(), QFont(), QColor(), item, indent});
    }

    void setEntryGap(qreal gap) {
        m_entryGap = gap;
    }

    void layoutEntries() {
        qreal contentWidth = 0.0;
        qreal contentHeight = 0.0;

        for (Entry &entry : m_entries) {
            entry.height = 0.0;
            entry.width = 0.0;
            if (entry.kind == EntryKind::Text) {
                const QFontMetricsF metrics(entry.font);
                entry.width = metrics.horizontalAdvance(entry.text);
                entry.height = metrics.height();
                entry.ascent = metrics.ascent();
            } else if (entry.item) {
                const QRectF itemBounds = entry.item->boundingRect();
                entry.width = itemBounds.width();
                entry.height = itemBounds.height();
            }
            contentWidth = std::max(contentWidth, entry.indent + entry.width);
            contentHeight += entry.height;
        }

        if (!m_entries.empty()) {
            contentHeight += m_entryGap * static_cast<qreal>(m_entries.size() - 1);
        }

        const qreal contentX = BRACKET_BLOCK_PADDING + BRACKET_BLOCK_HOOK + BRACKET_BLOCK_BRACKET_GAP;
        const qreal totalWidth = contentX + contentWidth + BRACKET_BLOCK_BRACKET_GAP + BRACKET_BLOCK_HOOK + BRACKET_BLOCK_PADDING;
        const qreal totalHeight = (BRACKET_BLOCK_PADDING * 2.0) + (BRACKET_BLOCK_VERTICAL_MARGIN * 2.0) + contentHeight;
        setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));

        m_leftBracketX = BRACKET_BLOCK_PADDING;
        m_rightBracketX = totalWidth - BRACKET_BLOCK_PADDING;

        qreal currentY = BRACKET_BLOCK_PADDING + BRACKET_BLOCK_VERTICAL_MARGIN;
        for (Entry &entry : m_entries) {
            const qreal entryX = contentX + entry.indent;
            if (entry.kind == EntryKind::Text) {
                entry.x = entryX;
                entry.baseline = currentY + entry.ascent;
            } else if (entry.item) {
                const QRectF itemBounds = entry.item->boundingRect();
                entry.item->setPos(entryX - itemBounds.left(), currentY - itemBounds.top());
            }
            currentY += entry.height + m_entryGap;
        }
    }

private:
    std::vector<Entry> m_entries;
    qreal m_leftBracketX = 0.0;
    qreal m_rightBracketX = 0.0;
    qreal m_entryGap = BRACKET_BLOCK_ENTRY_GAP;
};

class SeqNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit SeqNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::SeqNode> seqNode = std::dynamic_pointer_cast<iw::SeqNode>(node);
        Q_ASSERT(seqNode != nullptr);

        for (const iw::AstNodePtr &expression : seqNode->expressions()) {
            addItemEntry(createAstGraphicsItemInternal(expression, this));
        }
        layoutEntries();
    }

protected:
    void paintBracketVertical(QPainter *painter, qreal x, qreal top, qreal bottom) const override {
        QPainterPath path;
        const qreal amplitude = 2.0;
        const qreal wavelength = 6.0;
        path.moveTo(x, top);
        const qreal step = 2.0;
        for (qreal y = top + step; y <= bottom; y += step) {
            const qreal waveX = x + (std::sin((y - top) / wavelength * 2.0 * M_PI) * amplitude);
            path.lineTo(waveX, y);
        }
        path.lineTo(x, bottom);
        painter->drawPath(path);
    }
};

class ProgramNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit ProgramNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::ProgramNode> programNode = std::dynamic_pointer_cast<iw::ProgramNode>(node);
        Q_ASSERT(programNode != nullptr);
        setEntryGap(PROGRAM_ENTRY_GAP);

        const QString topLine = programNode->unitId()
            ? QStringLiteral("Program %1").arg(programNode->unitId()->name())
            : QStringLiteral("Program");
        addKeywordEntry(topLine);
        for (const iw::AstNodePtr &expression : programNode->topLevelExpressions()) {
            addItemEntry(createAstGraphicsItemInternal(expression, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(QStringLiteral("End Program"));
        layoutEntries();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *option, QWidget *widget) override {
        BracketedBlockGraphicsItem::paint(painter, option, widget);

        const std::vector<Entry> &programEntries = entries();
        const Entry *previousChild = nullptr;
        QPen separatorPen(astTextColor(), 1.0);
        painter->setPen(separatorPen);
        for (const Entry &entry : programEntries) {
            if (entry.kind != EntryKind::Item || !entry.item) {
                continue;
            }
            if (previousChild) {
                const qreal previousBottom = previousChild->item->pos().y() + previousChild->item->boundingRect().height();
                const qreal nextTop = entry.item->pos().y();
                const qreal y = previousBottom + ((nextTop - previousBottom) * 0.5);
                painter->drawLine(
                    QPointF(PROGRAM_ENTRY_SEPARATOR_MARGIN, y),
                    QPointF(std::max(PROGRAM_ENTRY_SEPARATOR_MARGIN, boundingRect().width() - PROGRAM_ENTRY_SEPARATOR_MARGIN), y));
            }
            previousChild = &entry;
        }
    }
};

class WhileNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit WhileNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::WhileNode> whileNode = std::dynamic_pointer_cast<iw::WhileNode>(node);
        Q_ASSERT(whileNode != nullptr);

        addKeywordEntry(QStringLiteral("While"));
        addItemEntry(createAstGraphicsItemInternal(whileNode->condExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("Then"));
        addItemEntry(createAstGraphicsItemInternal(whileNode->bodyExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("End While"));
        layoutEntries();
    }
};

class IfNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit IfNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::IfNode> ifNode = std::dynamic_pointer_cast<iw::IfNode>(node);
        Q_ASSERT(ifNode != nullptr);

        addKeywordEntry(QStringLiteral("If"));
        addItemEntry(createAstGraphicsItemInternal(ifNode->condExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("Then"));
        addItemEntry(createAstGraphicsItemInternal(ifNode->trueBranchExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("Else"));
        addItemEntry(createAstGraphicsItemInternal(ifNode->falseBranchExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("End If"));
        layoutEntries();
    }
};

class LetNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit LetNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::LetNode> letNode = std::dynamic_pointer_cast<iw::LetNode>(node);
        Q_ASSERT(letNode != nullptr);

        addKeywordEntry(QStringLiteral("Let"));
        for (const iw::LetBinding &binding : letNode->bindings()) {
            addItemEntry(new LetBindingGraphicsItem(node, binding.bind, binding.value, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(QStringLiteral("In"));
        addItemEntry(createAstGraphicsItemInternal(letNode->body(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("End Let"));
        layoutEntries();
    }
};

class LinkedBranchGraphicsItem : public AstGraphicsItem {
public:
    explicit LinkedBranchGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent) {
    }

    void refreshLayout() override {
        if (m_leadItem) {
            m_leadItem->refreshLayout();
        }
        if (m_bodyItem) {
            m_bodyItem->refreshLayout();
        }
        layoutBranch();
        update();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        if (!m_leadItem || !m_bodyItem) {
            return;
        }

        painter->setRenderHint(QPainter::Antialiasing, true);
        QPen leadBoxPen(astTextColor(), 1.0);
        leadBoxPen.setStyle(Qt::DashLine);
        painter->setPen(leadBoxPen);
        painter->setBrush(Qt::NoBrush);
        painter->drawRect(QRectF(m_leadItem->pos(), m_leadItem->boundingRect().size()).adjusted(
            -BRANCH_LEAD_BOX_MARGIN,
            -BRANCH_LEAD_BOX_MARGIN,
            BRANCH_LEAD_BOX_MARGIN,
            BRANCH_LEAD_BOX_MARGIN));

        QPen connectorPen(astTextColor(), 1.15);
        connectorPen.setJoinStyle(Qt::MiterJoin);

        paintOrthogonalRoutes(
            painter,
            {OrthogonalRoute{
                routePointsFromExitToTarget(
                    m_leadAnchor,
                    m_leadAnchor.x() + LINKED_BRANCH_EXIT_RUNOUT,
                    m_bodyAnchor.x() - LINKED_BRANCH_TARGET_GAP,
                    m_routeY,
                    m_bodyAnchor),
            }},
            connectorPen);
    }

    QPointF connectionAnchor() const override {
        if (m_leadItem) {
            return QPointF(
                -NODE_CONNECTION_PORT_OFFSET,
                m_leadItem->pos().y() + (m_leadItem->boundingRect().height() * 0.5));
        }
        return QPointF(-NODE_CONNECTION_PORT_OFFSET, std::max<qreal>(1.0, boundingRect().height() * 0.25));
    }

protected:
    void setLeadItem(AstGraphicsItem *item) {
        m_leadItem = item;
    }

    void setBodyItem(AstGraphicsItem *item) {
        m_bodyItem = item;
    }

    void layoutBranch() {
        if (!m_leadItem || !m_bodyItem) {
            setBounds(QRectF());
            return;
        }

        const QRectF leadBounds = m_leadItem->boundingRect();
        const QRectF bodyBounds = m_bodyItem->boundingRect();
        const qreal leadBoxWidth = leadBounds.width() + (BRANCH_LEAD_BOX_MARGIN * 2.0);
        const qreal leadBoxHeight = leadBounds.height() + (BRANCH_LEAD_BOX_MARGIN * 2.0);
        const qreal bodyX = BRANCH_LEAD_BOX_MARGIN + LINKED_BRANCH_INDENT;
        const qreal routeRight = leadBoxWidth + LINKED_BRANCH_EXIT_RUNOUT;
        const qreal totalWidth = std::max({leadBoxWidth, routeRight, bodyX + bodyBounds.width()});
        const qreal totalHeight = leadBoxHeight + LINKED_BRANCH_ROW_GAP + bodyBounds.height();
        setBounds(QRectF(0.0, 0.0, totalWidth, totalHeight));

        m_leadItem->setPos(BRANCH_LEAD_BOX_MARGIN - leadBounds.left(), BRANCH_LEAD_BOX_MARGIN - leadBounds.top());
        m_bodyItem->setPos(bodyX - bodyBounds.left(), leadBoxHeight + LINKED_BRANCH_ROW_GAP - bodyBounds.top());

        m_leadAnchor = m_leadItem->pos() + m_leadItem->exitAnchor();
        m_bodyAnchor = m_bodyItem->pos() + m_bodyItem->connectionAnchor();
        m_routeY = leadBoxHeight + (LINKED_BRANCH_ROW_GAP * 0.5);
    }

private:
    AstGraphicsItem *m_leadItem = nullptr;
    AstGraphicsItem *m_bodyItem = nullptr;
    QPointF m_leadAnchor;
    QPointF m_bodyAnchor;
    qreal m_routeY = 0.0;
};

class MatchBranchGraphicsItem final : public LinkedBranchGraphicsItem {
public:
    MatchBranchGraphicsItem(const iw::AstNodePtr &ownerNode, const iw::TypeVarBindNodePtr &bindNode, const iw::AstNodePtr &bodyNode, QGraphicsItem *parent = nullptr)
        : LinkedBranchGraphicsItem(ownerNode, parent) {
        setLeadItem(createAstGraphicsItemInternal(bindNode, this));
        setBodyItem(createAstGraphicsItemInternal(bodyNode, this));
        layoutBranch();
    }
};

class CondClauseGraphicsItem final : public LinkedBranchGraphicsItem {
public:
    CondClauseGraphicsItem(const iw::AstNodePtr &ownerNode, const iw::AstNodePtr &condNode, const iw::AstNodePtr &bodyNode, QGraphicsItem *parent = nullptr)
        : LinkedBranchGraphicsItem(ownerNode, parent) {
        if (isCondElseClause(condNode)) {
            setLeadItem(new InlineTextRunGraphicsItem(ownerNode, buildKeywordRuns(QStringLiteral("Else"), accentColor()), this));
        } else {
            setLeadItem(createAstGraphicsItemInternal(condNode, this));
        }
        setBodyItem(createAstGraphicsItemInternal(bodyNode, this));
        layoutBranch();
    }
};

class CondNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit CondNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::CondNode> condNode = std::dynamic_pointer_cast<iw::CondNode>(node);
        Q_ASSERT(condNode != nullptr);

        addKeywordEntry(QStringLiteral("Cond"));
        for (const iw::CondClause &clause : condNode->clauses()) {
            addItemEntry(new CondClauseGraphicsItem(node, clause.cond, clause.body, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(QStringLiteral("End Cond"));
        layoutEntries();
    }
};

class MatchNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit MatchNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        const std::shared_ptr<iw::MatchNode> matchNode = std::dynamic_pointer_cast<iw::MatchNode>(node);
        Q_ASSERT(matchNode != nullptr);

        addKeywordEntry(QStringLiteral("Match"));
        addItemEntry(createAstGraphicsItemInternal(matchNode->unionExpr(), this), BRACKET_BLOCK_INDENT);
        addKeywordEntry(QStringLiteral("Of"));
        for (const iw::MatchBranch &branch : matchNode->branches()) {
            addItemEntry(new MatchBranchGraphicsItem(node, branch.bind, branch.body, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(QStringLiteral("End Match"));
        layoutEntries();
    }
};

class FunctionBlockGraphicsItem : public BracketedBlockGraphicsItem {
public:
    FunctionBlockGraphicsItem(const iw::AstNodePtr &node,
                              const QString &headerKeyword,
                              const QString &footerKeyword,
                              const FunctionSignatureCardData &signatureData,
                              const iw::AstNodePtr &bodyNode,
                              bool hasReturnType,
                              QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        addItemEntry(new InlineTextRunGraphicsItem(node, buildFunctionHeaderRuns(headerKeyword, signatureData, hasReturnType, accentColor()), this));
        if (bodyNode) {
            addItemEntry(createAstGraphicsItemInternal(bodyNode, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(footerKeyword);
        layoutEntries();
    }
};

class FnNodeGraphicsItem final : public FunctionBlockGraphicsItem {
public:
    explicit FnNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : FunctionBlockGraphicsItem(
              node,
              QStringLiteral("Lambda"),
              QStringLiteral("End Lambda"),
              buildFunctionSignatureCardData(
                  QStringLiteral("lambda"),
                  QStringLiteral("\u03bb"),
                  std::dynamic_pointer_cast<iw::FnNode>(node)->params(),
                  std::dynamic_pointer_cast<iw::FnNode>(node)->returnType()),
              std::dynamic_pointer_cast<iw::FnNode>(node)->body(),
              true,
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::FnNode>(node) != nullptr);
    }
};

class DfunNodeGraphicsItem final : public FunctionBlockGraphicsItem {
public:
    explicit DfunNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : FunctionBlockGraphicsItem(
              node,
              QStringLiteral("Function"),
              QStringLiteral("End Function"),
              buildFunctionSignatureCardData(
                  QStringLiteral("function"),
                  std::dynamic_pointer_cast<iw::DfunNode>(node)->name()->name(),
                  std::dynamic_pointer_cast<iw::DfunNode>(node)->params(),
                  std::dynamic_pointer_cast<iw::DfunNode>(node)->returnType()),
              std::dynamic_pointer_cast<iw::DfunNode>(node)->body(),
              true,
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::DfunNode>(node) != nullptr);
    }
};

class DeclaredDfunNodeGraphicsItem final : public BracketedBlockGraphicsItem {
public:
    explicit DeclaredDfunNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::DeclaredDfunNode>(node) != nullptr);
        addItemEntry(new InlineTextRunGraphicsItem(
            node,
            buildDeclareRuns(buildFunctionSignatureCardData(
                QStringLiteral("declaration"),
                std::dynamic_pointer_cast<iw::DeclaredDfunNode>(node)->name()->name(),
                std::dynamic_pointer_cast<iw::DeclaredDfunNode>(node)->params(),
                std::dynamic_pointer_cast<iw::DeclaredDfunNode>(node)->returnType())),
            this));
        layoutEntries();
    }
};

class GenericDfunNodeGraphicsItem final : public FunctionBlockGraphicsItem {
public:
    explicit GenericDfunNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : FunctionBlockGraphicsItem(
              node,
              QStringLiteral("Function"),
              QStringLiteral("End Function"),
              buildFunctionSignatureCardData(
                  QStringLiteral("generic function"),
                  signatureTextForAstNode(std::dynamic_pointer_cast<iw::GenericDfunNode>(node)->genericName()),
                  std::dynamic_pointer_cast<iw::GenericDfunNode>(node)->params(),
                  std::dynamic_pointer_cast<iw::GenericDfunNode>(node)->returnType()),
              std::dynamic_pointer_cast<iw::GenericDfunNode>(node)->body(),
              true,
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::GenericDfunNode>(node) != nullptr);
    }
};

class ClassPropertyNodeGraphicsItem final : public InlineTextRunGraphicsItem {
public:
    explicit ClassPropertyNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : InlineTextRunGraphicsItem(
              node,
              buildPropertyRuns(std::dynamic_pointer_cast<iw::ClassPropertyNode>(node)->bind(), colorForNodeType(node->type())),
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::ClassPropertyNode>(node) != nullptr);
    }
};

class ClassMethodNodeGraphicsItem final : public FunctionBlockGraphicsItem {
public:
    explicit ClassMethodNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : FunctionBlockGraphicsItem(
              node,
              QStringLiteral("Function"),
              QStringLiteral("End Function"),
              buildFunctionSignatureCardData(
                  QStringLiteral("method"),
                  std::dynamic_pointer_cast<iw::ClassMethodNode>(node)->methodName()->name(),
                  std::dynamic_pointer_cast<iw::ClassMethodNode>(node)->params(),
                  std::dynamic_pointer_cast<iw::ClassMethodNode>(node)->returnType()),
              std::dynamic_pointer_cast<iw::ClassMethodNode>(node)->body(),
              true,
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::ClassMethodNode>(node) != nullptr);
    }
};

class ClassConstructorNodeGraphicsItem final : public FunctionBlockGraphicsItem {
public:
    explicit ClassConstructorNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : FunctionBlockGraphicsItem(
              node,
              QStringLiteral("Function"),
              QStringLiteral("End Function"),
              buildFunctionSignatureCardData(
                  QStringLiteral("constructor"),
                  QStringLiteral("constructor"),
                  std::dynamic_pointer_cast<iw::ClassConstructorNode>(node)->params(),
                  iw::AstNodePtr()),
              std::dynamic_pointer_cast<iw::ClassConstructorNode>(node)->body(),
              false,
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::ClassConstructorNode>(node) != nullptr);
    }
};

class ClassBlockGraphicsItem : public BracketedBlockGraphicsItem {
public:
    ClassBlockGraphicsItem(const iw::AstNodePtr &node,
                           const QString &displayName,
                           const std::vector<iw::ClassConstructorNodePtr> &constructors,
                           const std::vector<iw::ClassMethodNodePtr> &methods,
                           const std::vector<iw::ClassPropertyNodePtr> &properties,
                           QGraphicsItem *parent = nullptr)
        : BracketedBlockGraphicsItem(node, parent) {
        addItemEntry(new InlineTextRunGraphicsItem(node, buildClassHeaderRuns(displayName, accentColor()), this));
        for (const iw::ClassConstructorNodePtr &constructorNode : constructors) {
            addItemEntry(createAstGraphicsItemInternal(constructorNode, this), BRACKET_BLOCK_INDENT);
        }
        for (const iw::ClassMethodNodePtr &methodNode : methods) {
            addItemEntry(createAstGraphicsItemInternal(methodNode, this), BRACKET_BLOCK_INDENT);
        }
        for (const iw::ClassPropertyNodePtr &propertyNode : properties) {
            addItemEntry(createAstGraphicsItemInternal(propertyNode, this), BRACKET_BLOCK_INDENT);
        }
        addKeywordEntry(QStringLiteral("End Class"));
        layoutEntries();
    }
};

class ClassNodeGraphicsItem final : public ClassBlockGraphicsItem {
public:
    explicit ClassNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : ClassBlockGraphicsItem(
              node,
              std::dynamic_pointer_cast<iw::ClassNode>(node)->name()->name(),
              std::dynamic_pointer_cast<iw::ClassNode>(node)->constructorNodeList(),
              std::dynamic_pointer_cast<iw::ClassNode>(node)->methodNodeList(),
              std::dynamic_pointer_cast<iw::ClassNode>(node)->propertyNodeList(),
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::ClassNode>(node) != nullptr);
    }
};

class GenericClassNodeGraphicsItem final : public ClassBlockGraphicsItem {
public:
    explicit GenericClassNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : ClassBlockGraphicsItem(
              node,
              signatureTextForAstNode(std::dynamic_pointer_cast<iw::GenericClassNode>(node)->genericName()),
              std::dynamic_pointer_cast<iw::GenericClassNode>(node)->constructorNodeList(),
              std::dynamic_pointer_cast<iw::GenericClassNode>(node)->methodNodeList(),
              std::dynamic_pointer_cast<iw::GenericClassNode>(node)->propertyNodeList(),
              parent) {
        Q_ASSERT(std::dynamic_pointer_cast<iw::GenericClassNode>(node) != nullptr);
    }
};

class ImportNodeGraphicsItem final : public AstGraphicsItem {
public:
    explicit ImportNodeGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr)
        : AstGraphicsItem(node, parent) {
        const std::shared_ptr<iw::ImportNode> importNode = std::dynamic_pointer_cast<iw::ImportNode>(node);
        Q_ASSERT(importNode != nullptr);
        m_keywordText = QStringLiteral("import ");
        m_packageText = importNode->packagePath()->name();
        layoutText();
    }

    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing, true);
        painter->setRenderHint(QPainter::TextAntialiasing, true);

        QPen bracketPen(astTextColor(), 1.35);
        bracketPen.setJoinStyle(Qt::MiterJoin);
        painter->setPen(bracketPen);
        const qreal top = 0.0;
        const qreal bottom = boundingRect().height();
        const qreal leftX = 0.0;
        const qreal rightX = boundingRect().width();
        painter->drawLine(QPointF(leftX + IMPORT_BRACKET_HOOK, top), QPointF(leftX, top));
        painter->drawLine(QPointF(leftX, top), QPointF(leftX, bottom));
        painter->drawLine(QPointF(leftX, bottom), QPointF(leftX + IMPORT_BRACKET_HOOK, bottom));
        painter->drawLine(QPointF(rightX - IMPORT_BRACKET_HOOK, top), QPointF(rightX, top));
        painter->drawLine(QPointF(rightX, top), QPointF(rightX, bottom));
        painter->drawLine(QPointF(rightX, bottom), QPointF(rightX - IMPORT_BRACKET_HOOK, bottom));

        painter->setFont(m_font);
        painter->setPen(astKeywordColor());
        painter->drawText(QPointF(m_textX, m_baseline), m_keywordText);
        painter->setPen(astTextColor());
        painter->drawText(QPointF(m_textX + m_keywordWidth, m_baseline), m_packageText);
    }

private:
    void layoutText() {
        m_font = functionSignatureMathFont();
        const QFontMetricsF metrics(m_font);
        m_keywordWidth = metrics.horizontalAdvance(m_keywordText);
        const qreal packageWidth = metrics.horizontalAdvance(m_packageText);
        m_textX = IMPORT_BRACKET_HOOK + IMPORT_BRACKET_GAP;
        m_baseline = metrics.ascent();
        const qreal width = m_textX + m_keywordWidth + packageWidth + IMPORT_BRACKET_GAP + IMPORT_BRACKET_HOOK;
        setBounds(QRectF(0.0, 0.0, width, metrics.height()));
    }

    QString m_keywordText;
    QString m_packageText;
    QFont m_font;
    qreal m_keywordWidth = 0.0;
    qreal m_textX = 0.0;
    qreal m_baseline = 0.0;
};

#define DECLARE_TRIVIAL_NODE_GRAPHICS_ITEM(ClassName) \
class ClassName final : public AstTrivialGraphicsItem { \
public: \
    explicit ClassName(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr) \
        : AstTrivialGraphicsItem(node, parent) { \
    } \
}

#define DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(ClassName) \
class ClassName final : public AstStructuredGraphicsItem { \
public: \
    explicit ClassName(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr) \
        : AstStructuredGraphicsItem(node, parent) { \
    } \
}

#define DECLARE_INLINE_FORMULA_NODE_GRAPHICS_ITEM(ClassName) \
class ClassName final : public AstInlineFormulaGraphicsItem { \
public: \
    explicit ClassName(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr) \
        : AstInlineFormulaGraphicsItem(node, parent) { \
    } \
}

DECLARE_TRIVIAL_NODE_GRAPHICS_ITEM(IdentifierNodeGraphicsItem);
DECLARE_TRIVIAL_NODE_GRAPHICS_ITEM(TextDatabaseReferenceNodeGraphicsItem);
DECLARE_TRIVIAL_NODE_GRAPHICS_ITEM(NumberLiteralNodeGraphicsItem);

DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(ListNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(AngleParenListNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(SquareParenListNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(CurlyParenListNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(RoundParenListNodeGraphicsItem);
DECLARE_INLINE_FORMULA_NODE_GRAPHICS_ITEM(TypeVarBindNodeGraphicsItem);
DECLARE_INLINE_FORMULA_NODE_GRAPHICS_ITEM(TypeToFromNodeGraphicsItem);
DECLARE_INLINE_FORMULA_NODE_GRAPHICS_ITEM(TypeUnionNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(ExportNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(PublicNodeGraphicsItem);
DECLARE_STRUCTURED_NODE_GRAPHICS_ITEM(GenericNameNodeGraphicsItem);
DECLARE_INLINE_FORMULA_NODE_GRAPHICS_ITEM(GenericCallNodeGraphicsItem);

AstGraphicsItem *createAstGraphicsItemInternal(const iw::AstNodePtr &node, QGraphicsItem *parent) {
    switch (node->type()) {
    case iw::AstNodeType::IdentifierNode:
        return new IdentifierNodeGraphicsItem(node, parent);
    case iw::AstNodeType::TextDatabaseReferenceNode:
        return new TextDatabaseReferenceNodeGraphicsItem(node, parent);
    case iw::AstNodeType::NumberLiteralNode:
        return new NumberLiteralNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ListNode:
        return new ListNodeGraphicsItem(node, parent);
    case iw::AstNodeType::AngleParenListNode:
        return new AngleParenListNodeGraphicsItem(node, parent);
    case iw::AstNodeType::SquareParenListNode:
        return new SquareParenListNodeGraphicsItem(node, parent);
    case iw::AstNodeType::CurlyParenListNode:
        return new CurlyParenListNodeGraphicsItem(node, parent);
    case iw::AstNodeType::RoundParenListNode:
        return new RoundParenListNodeGraphicsItem(node, parent);
    case iw::AstNodeType::FnNode:
        return new FnNodeGraphicsItem(node, parent);
    case iw::AstNodeType::LetNode:
        return new LetNodeGraphicsItem(node, parent);
    case iw::AstNodeType::IfNode:
        return new IfNodeGraphicsItem(node, parent);
    case iw::AstNodeType::WhileNode:
        return new WhileNodeGraphicsItem(node, parent);
    case iw::AstNodeType::CondNode:
        return new CondNodeGraphicsItem(node, parent);
    case iw::AstNodeType::TypeVarBindNode:
        return new TypeVarBindNodeGraphicsItem(node, parent);
    case iw::AstNodeType::TypeToFromNode:
        return new TypeToFromNodeGraphicsItem(node, parent);
    case iw::AstNodeType::TypeUnionNode:
        return new TypeUnionNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ProgramNode:
        return new ProgramNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ImportNode:
        return new ImportNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ExportNode:
        return new ExportNodeGraphicsItem(node, parent);
    case iw::AstNodeType::PublicNode:
        return new PublicNodeGraphicsItem(node, parent);
    case iw::AstNodeType::DvarNode:
        return new DvarNodeGraphicsItem(node, parent);
    case iw::AstNodeType::DfunNode:
        return new DfunNodeGraphicsItem(node, parent);
    case iw::AstNodeType::DeclaredDfunNode:
        return new DeclaredDfunNodeGraphicsItem(node, parent);
    case iw::AstNodeType::SetNode:
        return new SetNodeGraphicsItem(node, parent);
    case iw::AstNodeType::SeqNode:
        return new SeqNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ClassNode:
        return new ClassNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ClassPropertyNode:
        return new ClassPropertyNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ClassMethodNode:
        return new ClassMethodNodeGraphicsItem(node, parent);
    case iw::AstNodeType::ClassConstructorNode:
        return new ClassConstructorNodeGraphicsItem(node, parent);
    case iw::AstNodeType::GenericNameNode:
        return new GenericNameNodeGraphicsItem(node, parent);
    case iw::AstNodeType::GenericClassNode:
        return new GenericClassNodeGraphicsItem(node, parent);
    case iw::AstNodeType::GenericDfunNode:
        return new GenericDfunNodeGraphicsItem(node, parent);
    case iw::AstNodeType::FunctionCallNode:
        return new FunctionCallNodeGraphicsItem(node, parent);
    case iw::AstNodeType::GenericCallNode:
        return new GenericCallNodeGraphicsItem(node, parent);
    case iw::AstNodeType::MatchNode:
        return new MatchNodeGraphicsItem(node, parent);
    }

    return new AstTrivialGraphicsItem(node, parent);
}

} 

AstGraphicsItem::AstGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent)
    : QGraphicsObject(parent),
      m_node(node),
      m_labelText(isTrivialNodeType(node->type()) ? displayTextForNode(node) : node->summaryText()),
      m_accentColor(colorForNodeType(node->type())) {
    setAcceptedMouseButtons(Qt::NoButton);
}

const iw::AstNodePtr &AstGraphicsItem::node() const {
    return m_node;
}

QRectF AstGraphicsItem::boundingRect() const {
    return m_bounds;
}

const QString &AstGraphicsItem::labelText() const {
    return m_labelText;
}

const QColor &AstGraphicsItem::accentColor() const {
    return m_accentColor;
}

void AstGraphicsItem::refreshLayout() {
    update();
}

QPointF AstGraphicsItem::connectionAnchor() const {
    return QPointF(-NODE_CONNECTION_PORT_OFFSET, std::max<qreal>(1.0, boundingRect().height() * 0.25));
}

QPointF AstGraphicsItem::exitAnchor() const {
    return QPointF(
        boundingRect().right() + BRANCH_LEAD_BOX_MARGIN,
        std::max<qreal>(0.0, boundingRect().bottom() + BRANCH_LEAD_BOX_MARGIN - NODE_CONNECTION_PORT_OFFSET));
}

void AstGraphicsItem::setBounds(const QRectF &bounds) {
    prepareGeometryChange();
    m_bounds = bounds;
}

bool AstGraphicsItem::isTrivialNodeType(iw::AstNodeType nodeType) {
    return nodeType == iw::AstNodeType::IdentifierNode
        || nodeType == iw::AstNodeType::TextDatabaseReferenceNode
        || nodeType == iw::AstNodeType::NumberLiteralNode;
}

QString AstGraphicsItem::displayTextForNode(const iw::AstNodePtr &node) {
    if (const iw::IdentifierNodePtr identifierNode = std::dynamic_pointer_cast<iw::IdentifierNode>(node)) {
        return identifierNode->name();
    }
    if (const std::shared_ptr<iw::TextDatabaseReferenceNode> textNode = std::dynamic_pointer_cast<iw::TextDatabaseReferenceNode>(node)) {
        return literalDisplayTextForNode(textNode);
    }
    if (const std::shared_ptr<iw::NumberLiteralNode> numberNode = std::dynamic_pointer_cast<iw::NumberLiteralNode>(node)) {
        return formatDisplayNumber(numberNode->value());
    }
    return node->summaryText();
}

AstGraphicsItem *createAstGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent) {
    return createAstGraphicsItemInternal(node, parent);
}

AstVisTheme lightAstVisTheme() {
    return AstVisTheme{
        Qt::white,
        Qt::black,
        QColor(0, 0, 255),
        QColor(0, 170, 127),
        Qt::red,
        QColor(234, 88, 12),
        Qt::red
    };
}

AstVisTheme darkAstVisTheme() {
    return AstVisTheme{
        Qt::black,
        Qt::white,
        QColor(0, 170, 255),
        QColor(0, 255, 127),
        Qt::red,
        QColor(234, 88, 12),
        Qt::yellow
    };
}

AstVisTheme currentAstVisTheme() {
    return g_astVisTheme;
}

void setCurrentAstVisTheme(const AstVisTheme &theme) {
    g_astVisTheme = theme;
}

QStringList availableMathFontFamilies() {
    return loadedMathFontFamilies();
}

QString currentMathFontFamily() {
    return functionSignatureMathFamily();
}

void setCurrentMathFontFamily(const QString &family) {
    loadedMathFontFamilies();
    if (family.trimmed().isEmpty()) {
        g_selectedMathFontFamily.clear();
        return;
    }
    g_selectedMathFontFamily = family;
}

void setLiteralReferenceDisplayTexts(const QHash<QString, QString> &texts) {
    g_literalReferenceDisplayTexts = texts;
}

LiteralDisplayOptions literalDisplayOptions() {
    return g_literalDisplayOptions;
}

void setLiteralDisplayOptions(const LiteralDisplayOptions &options) {
    g_literalDisplayOptions = options;
}

QString astvisExpressionPreviewForTest(const iw::AstNodePtr &node) {
    return signatureTextForAstNode(node);
}
