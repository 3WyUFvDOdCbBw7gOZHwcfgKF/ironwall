// Qt AST viewer core: Ironwall lexer implementation.
#include "iwlexer.h"

#include <cmath>
#include <stdexcept>

#include <QMap>
#include <QRegularExpression>
#include <QSet>
#include <QStringList>

namespace iw {
namespace {

const QMap<QChar, BracketKind> LEFT_BRACKET_KIND_MAP = {
    {QChar('('), BracketKind::Round},
    {QChar('['), BracketKind::Square},
    {QChar('{'), BracketKind::Curly},
    {QChar('<'), BracketKind::Angle},
};

const QMap<QChar, BracketKind> RIGHT_BRACKET_KIND_MAP = {
    {QChar(')'), BracketKind::Round},
    {QChar(']'), BracketKind::Square},
    {QChar('}'), BracketKind::Curly},
    {QChar('>'), BracketKind::Angle},
};

const QSet<QString> INTEGER_TYPE_NAMES = {
    QStringLiteral("i5"),
    QStringLiteral("i6"),
    QStringLiteral("i7"),
    QStringLiteral("u5"),
    QStringLiteral("u6"),
    QStringLiteral("u7"),
};

const QSet<QString> FLOAT_TYPE_NAMES = {
    QStringLiteral("f5"),
    QStringLiteral("f6"),
    QStringLiteral("f7"),
};

const QSet<QString> COMPLEX_TYPE_NAMES = {
    QStringLiteral("z5"),
    QStringLiteral("z6"),
    QStringLiteral("z7"),
};

const QSet<QString> SPECIAL_FLOAT_PAYLOADS = {
    QStringLiteral("inf"),
    QStringLiteral("0neginf"),
    QStringLiteral("nan"),
};

const QString IDENTIFIER_HEAD_SOURCE = QStringLiteral("[a-zA-Z_]");
const QString IDENTIFIER_BODY_SOURCE = QStringLiteral("[a-zA-Z0-9_]*");
const QString IDENTIFIER_SEGMENT_SOURCE = IDENTIFIER_HEAD_SOURCE + IDENTIFIER_BODY_SOURCE;
const QString PACKAGE_SEGMENT_SOURCE = IDENTIFIER_SEGMENT_SOURCE;
const QString PACKAGE_PATH_SOURCE = QStringLiteral("%1(?:~%1)+").arg(PACKAGE_SEGMENT_SOURCE);
const QString PACKAGE_QUALIFIED_NAME_SOURCE = QStringLiteral("%1@(%2)").arg(PACKAGE_PATH_SOURCE, IDENTIFIER_SEGMENT_SOURCE);
const QString MEMBER_CHAIN_SEGMENT_SOURCE = QStringLiteral("(?:%1|%2(?:~%2)*@(?:%3))")
    .arg(IDENTIFIER_SEGMENT_SOURCE, PACKAGE_SEGMENT_SOURCE, IDENTIFIER_SEGMENT_SOURCE);

const QRegularExpression IDENTIFIER_PATTERN(QStringLiteral("^%1$").arg(IDENTIFIER_SEGMENT_SOURCE));
const QRegularExpression PACKAGE_PATH_PATTERN(QStringLiteral("^%1$").arg(PACKAGE_PATH_SOURCE));
const QRegularExpression PACKAGE_QUALIFIED_NAME_PATTERN(QStringLiteral("^%1$").arg(PACKAGE_QUALIFIED_NAME_SOURCE));
const QRegularExpression MEMBER_CHAIN_SEGMENT_PATTERN(QStringLiteral("^%1$").arg(MEMBER_CHAIN_SEGMENT_SOURCE));
const QRegularExpression DOTTED_MEMBER_CHAIN_PATTERN(QStringLiteral("^(?:%1)(?:\\.(?:%1))+$").arg(MEMBER_CHAIN_SEGMENT_SOURCE));
const QRegularExpression LOCAL_TYPED_REFERENCE_PATTERN(QStringLiteral("^\\$(%1)\\^(%2)$").arg(IDENTIFIER_SEGMENT_SOURCE, IDENTIFIER_SEGMENT_SOURCE));
const QRegularExpression PACKAGE_TYPED_REFERENCE_PATTERN(QStringLiteral("^(%1(?:~%1)*)\\$(%2)\\^(%3)$")
    .arg(PACKAGE_SEGMENT_SOURCE, IDENTIFIER_SEGMENT_SOURCE, IDENTIFIER_SEGMENT_SOURCE));
const QRegularExpression INTEGER_PAYLOAD_PATTERN(QStringLiteral("^(?:0|[1-9][0-9]*|0neg[0-9]+|0x[0-9A-Fa-f]+)$"));
const QRegularExpression FLOAT_PAYLOAD_PATTERN(QStringLiteral("^(?:(?:0neg)?(?:[0-9]+p[0-9]+(?:ep|en)[0-9]+|[0-9]+(?:ep|en)[0-9]+|[0-9]+p[0-9]+|[0-9]+)|inf|0neginf|nan)$"));
const QRegularExpression COMPLEX_COMPONENT_PATTERN(QStringLiteral("^(?:(?:0neg)?(?:[0-9]+p[0-9]+(?:ep|en)[0-9]+|[0-9]+(?:ep|en)[0-9]+|[0-9]+p[0-9]+|0|[1-9][0-9]*)|inf|0neginf|nan)$"));
const QRegularExpression VALID_CHARS_PATTERN(QStringLiteral("^[a-zA-Z0-9_.$^~@\\[\\]\\(\\)\\<\\>\\{\\}\\s]*$"));

QString normalizeInput(const QString &input) {
    return input.simplified();
}

bool isValidChars(const QString &input) {
    return VALID_CHARS_PATTERN.match(input).hasMatch();
}

std::optional<NumericLiteralValue> parsePlainNumberPayload(const QString &raw);

std::optional<ComplexLiteralValue> parseComplexPayload(const QString &raw) {
    if (!raw.startsWith(QStringLiteral("0real"))) {
        return std::nullopt;
    }

    const qsizetype separatorIndex = raw.indexOf(QStringLiteral("img"), 5);
    if (separatorIndex < 0) {
        return std::nullopt;
    }

    const QString realRaw = raw.mid(5, separatorIndex - 5);
    const QString imagRaw = raw.mid(separatorIndex + 3);
    if (!COMPLEX_COMPONENT_PATTERN.match(realRaw).hasMatch() || !COMPLEX_COMPONENT_PATTERN.match(imagRaw).hasMatch()) {
        return std::nullopt;
    }

    const std::optional<NumericLiteralValue> realValue = parsePlainNumberPayload(realRaw);
    const std::optional<NumericLiteralValue> imagValue = parsePlainNumberPayload(imagRaw);
    if (!realValue.has_value() || !imagValue.has_value()) {
        return std::nullopt;
    }
    if (realValue->isComplex() || imagValue->isComplex()) {
        return std::nullopt;
    }

    return ComplexLiteralValue(realValue->number(), imagValue->number(), realRaw, imagRaw);
}

std::optional<NumericLiteralValue> parsePlainNumberPayload(const QString &raw) {
    if (raw == QStringLiteral("inf")) {
        return NumericLiteralValue(std::numeric_limits<double>::infinity());
    }

    if (raw == QStringLiteral("0neginf")) {
        return NumericLiteralValue(-std::numeric_limits<double>::infinity());
    }

    if (raw == QStringLiteral("nan")) {
        return NumericLiteralValue(std::numeric_limits<double>::quiet_NaN());
    }

    if (QRegularExpression(QStringLiteral("^[0-9]+$")).match(raw).hasMatch()) {
        return NumericLiteralValue(raw.toDouble());
    }

    if (QRegularExpression(QStringLiteral("^0x[0-9A-Fa-f]+$")).match(raw).hasMatch()) {
        bool ok = false;
        const qulonglong value = raw.mid(2).toULongLong(&ok, 16);
        if (!ok) {
            return std::nullopt;
        }
        return NumericLiteralValue(static_cast<double>(value));
    }

    if (QRegularExpression(QStringLiteral("^0neg[0-9]+$")).match(raw).hasMatch()) {
        return NumericLiteralValue(-raw.mid(4).toDouble());
    }

    const QRegularExpressionMatch negativeFiniteMatch = QRegularExpression(QStringLiteral("^0neg(.+)$")).match(raw);
    if (negativeFiniteMatch.hasMatch()) {
        const QString innerRaw = negativeFiniteMatch.captured(1);
        if (QRegularExpression(QStringLiteral("^0x"), QRegularExpression::CaseInsensitiveOption).match(innerRaw).hasMatch()
            || innerRaw == QStringLiteral("inf")
            || innerRaw == QStringLiteral("0neginf")
            || innerRaw == QStringLiteral("nan")) {
            return std::nullopt;
        }

        const std::optional<NumericLiteralValue> innerValue = parsePlainNumberPayload(innerRaw);
        if (!innerValue.has_value() || innerValue->isComplex()) {
            return std::nullopt;
        }
        return NumericLiteralValue(-innerValue->number());
    }

    const QRegularExpressionMatch floatMatch = QRegularExpression(QStringLiteral("^([0-9]+)p([0-9]+)$")).match(raw);
    if (floatMatch.hasMatch()) {
        const QString text = QStringLiteral("%1.%2").arg(floatMatch.captured(1), floatMatch.captured(2));
        return NumericLiteralValue(text.toDouble());
    }

    const QRegularExpressionMatch scientificMatch = QRegularExpression(QStringLiteral("^([0-9]+(?:p[0-9]+)?)(ep|en)([0-9]+)$")).match(raw);
    if (scientificMatch.hasMatch()) {
        const std::optional<NumericLiteralValue> mantissa = parsePlainNumberPayload(scientificMatch.captured(1));
        if (!mantissa.has_value() || mantissa->isComplex()) {
            return std::nullopt;
        }
        const double exponent = scientificMatch.captured(3).toDouble();
        const double scale = scientificMatch.captured(2) == QStringLiteral("ep") ? std::pow(10.0, exponent) : std::pow(10.0, -exponent);
        return NumericLiteralValue(mantissa->number() * scale);
    }

    const std::optional<ComplexLiteralValue> complexValue = parseComplexPayload(raw);
    if (complexValue.has_value()) {
        return NumericLiteralValue(*complexValue);
    }

    return std::nullopt;
}

bool isIdentifierChunk(const QString &chunk) {
    return IDENTIFIER_PATTERN.match(chunk).hasMatch()
        || PACKAGE_PATH_PATTERN.match(chunk).hasMatch()
        || PACKAGE_QUALIFIED_NAME_PATTERN.match(chunk).hasMatch()
        || isTextDatabaseReferenceName(chunk);
}

bool isDottedMemberChainChunk(const QString &chunk) {
    if (!DOTTED_MEMBER_CHAIN_PATTERN.match(chunk).hasMatch()) {
        return false;
    }

    const QStringList segments = chunk.split(QChar('.'));
    for (const QString &segment : segments) {
        if (!isMemberChainSegmentText(segment)) {
            return false;
        }
    }
    return true;
}

QStringList splitInputIntoRawChunks(const QString &input) {
    QStringList chunks;
    qsizetype index = 0;
    while (index < input.size()) {
        const QChar current = input.at(index);
        if (LEFT_BRACKET_KIND_MAP.contains(current) || RIGHT_BRACKET_KIND_MAP.contains(current)) {
            chunks.push_back(QString(current));
            index += 1;
            continue;
        }
        if (current.isSpace()) {
            index += 1;
            continue;
        }

        const qsizetype start = index;
        while (index < input.size()) {
            const QChar probe = input.at(index);
            if (probe.isSpace() || LEFT_BRACKET_KIND_MAP.contains(probe) || RIGHT_BRACKET_KIND_MAP.contains(probe)) {
                break;
            }
            index += 1;
        }
        chunks.push_back(input.mid(start, index - start));
    }
    return chunks;
}

QStringList expandDottedMemberChainChunk(const QString &chunk) {
    const QStringList segments = chunk.split(QChar('.'));
    QStringList expressionChunks;
    expressionChunks.push_back(segments.at(0));
    for (qsizetype index = 1; index < segments.size(); index += 1) {
        QStringList nextExpressionChunks;
        nextExpressionChunks.push_back(QStringLiteral("("));
        nextExpressionChunks.push_back(QStringLiteral("cm_get"));
        nextExpressionChunks.append(expressionChunks);
        nextExpressionChunks.push_back(segments.at(index));
        nextExpressionChunks.push_back(QStringLiteral(")"));
        expressionChunks = nextExpressionChunks;
    }
    return expressionChunks;
}

QStringList expandDottedMemberChainChunks(const QStringList &chunks) {
    QStringList expandedChunks;
    for (const QString &chunk : chunks) {
        if (!isDottedMemberChainChunk(chunk)) {
            expandedChunks.push_back(chunk);
            continue;
        }
        expandedChunks.append(expandDottedMemberChainChunk(chunk));
    }
    return expandedChunks;
}

TokenList chunksToTokens(const QStringList &chunks) {
    TokenList tokens;
    for (const QString &chunk : chunks) {
        if (chunk.size() == 1 && LEFT_BRACKET_KIND_MAP.contains(chunk.at(0))) {
            tokens.push_back(Token::makeLParen(LEFT_BRACKET_KIND_MAP.value(chunk.at(0))));
            continue;
        }
        if (chunk.size() == 1 && RIGHT_BRACKET_KIND_MAP.contains(chunk.at(0))) {
            tokens.push_back(Token::makeRParen(RIGHT_BRACKET_KIND_MAP.value(chunk.at(0))));
            continue;
        }

        const std::optional<TypedNumericLiteralInfo> typedNumeric = parseTypedNumericLiteral(chunk);
        if (typedNumeric.has_value()) {
            const std::optional<NumericLiteralValue> numericValue = parsePlainNumberPayload(typedNumeric->payload());
            if (!numericValue.has_value()) {
                throw std::runtime_error("Invalid typed numeric literal");
            }
            tokens.push_back(Token::makeNumber(typedNumeric->typeName(), *numericValue, chunk));
            continue;
        }

        if (isIdentifierChunk(chunk)) {
            tokens.push_back(Token::makeIdentifier(chunk));
            continue;
        }

        throw std::runtime_error("Invalid token chunk");
    }
    return tokens;
}

}

std::optional<TextDatabaseReferenceInfo> parseTextDatabaseReferenceName(const QString &name) {
    const QRegularExpressionMatch localMatch = LOCAL_TYPED_REFERENCE_PATTERN.match(name);
    if (localMatch.hasMatch()) {
        if (parseTypedNumericLiteral(name).has_value()) {
            return std::nullopt;
        }
        return TextDatabaseReferenceInfo(localMatch.captured(2), localMatch.captured(1), name);
    }

    const QRegularExpressionMatch packageMatch = PACKAGE_TYPED_REFERENCE_PATTERN.match(name);
    if (!packageMatch.hasMatch()) {
        return std::nullopt;
    }
    return TextDatabaseReferenceInfo(packageMatch.captured(3), packageMatch.captured(2), name);
}

bool isTextDatabaseReferenceName(const QString &name) {
    return parseTextDatabaseReferenceName(name).has_value();
}

std::optional<TypedNumericLiteralInfo> parseTypedNumericLiteral(const QString &name) {
    const QRegularExpressionMatch match = QRegularExpression(QStringLiteral("^\\$(.+)\\^([a-zA-Z][a-zA-Z0-9_]*)$")).match(name);
    if (!match.hasMatch()) {
        return std::nullopt;
    }

    const QString payload = match.captured(1);
    const QString typeName = match.captured(2);
    const bool isSpecialFloatPayload = FLOAT_TYPE_NAMES.contains(typeName) && SPECIAL_FLOAT_PAYLOADS.contains(payload);
    if (IDENTIFIER_PATTERN.match(payload).hasMatch() && !isSpecialFloatPayload) {
        return std::nullopt;
    }

    if (INTEGER_TYPE_NAMES.contains(typeName) && INTEGER_PAYLOAD_PATTERN.match(payload).hasMatch() && parsePlainNumberPayload(payload).has_value()) {
        return TypedNumericLiteralInfo(typeName, payload);
    }
    if (FLOAT_TYPE_NAMES.contains(typeName) && FLOAT_PAYLOAD_PATTERN.match(payload).hasMatch() && parsePlainNumberPayload(payload).has_value()) {
        return TypedNumericLiteralInfo(typeName, payload);
    }
    if (COMPLEX_TYPE_NAMES.contains(typeName) && parseComplexPayload(payload).has_value()) {
        return TypedNumericLiteralInfo(typeName, payload);
    }

    return std::nullopt;
}

bool isMemberChainSegmentText(const QString &chunk) {
    return MEMBER_CHAIN_SEGMENT_PATTERN.match(chunk).hasMatch() && !parseTextDatabaseReferenceName(chunk).has_value();
}

TokenList tokenize(const QString &input) {
    const QString normalized = normalizeInput(input);
    if (!isValidChars(normalized)) {
        return TokenList();
    }

    try {
        const QStringList rawChunks = splitInputIntoRawChunks(normalized);
        const QStringList expandedChunks = expandDottedMemberChainChunks(rawChunks);
        return chunksToTokens(expandedChunks);
    } catch (...) {
        return TokenList();
    }
}

}