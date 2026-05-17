// Qt AST viewer core: token and numeric literal models.
#ifndef IW_ASTVIS_QT_CORE_IWTOKEN_H
#define IW_ASTVIS_QT_CORE_IWTOKEN_H

#include <QtGlobal>

#include <cmath>

#include <QString>

namespace iw {

enum class TokenType {
    LParen,
    RParen,
    Number,
    Identifier,
};

enum class BracketKind {
    Round,
    Square,
    Curly,
    Angle,
};

class ComplexLiteralValue final {
public:
    ComplexLiteralValue()
        : m_real(0.0),
          m_imag(0.0),
          m_realRaw(),
          m_imagRaw() {
    }

    ComplexLiteralValue(double realValue, double imagValue, const QString &realRawValue, const QString &imagRawValue)
        : m_real(realValue),
          m_imag(imagValue),
          m_realRaw(realRawValue),
          m_imagRaw(imagRawValue) {
    }

    double real() const {
        return m_real;
    }

    double imag() const {
        return m_imag;
    }

    const QString &realRaw() const {
        return m_realRaw;
    }

    const QString &imagRaw() const {
        return m_imagRaw;
    }

    bool operator==(const ComplexLiteralValue &other) const {
        return numbersEqual(m_real, other.m_real)
            && numbersEqual(m_imag, other.m_imag)
            && m_realRaw == other.m_realRaw
            && m_imagRaw == other.m_imagRaw;
    }

    static bool numbersEqual(double left, double right) {
        if (std::isnan(left) && std::isnan(right)) {
            return true;
        }
        return left == right;
    }

private:
    double m_real;
    double m_imag;
    QString m_realRaw;
    QString m_imagRaw;
};

class NumericLiteralValue final {
public:
    NumericLiteralValue()
        : m_isComplex(false),
          m_number(0.0),
          m_complex() {
    }

    explicit NumericLiteralValue(double value)
        : m_isComplex(false),
          m_number(value),
          m_complex() {
    }

    explicit NumericLiteralValue(const ComplexLiteralValue &value)
        : m_isComplex(true),
          m_number(0.0),
          m_complex(value) {
    }

    bool isComplex() const {
        return m_isComplex;
    }

    double number() const {
        Q_ASSERT(!m_isComplex);
        return m_number;
    }

    const ComplexLiteralValue &complex() const {
        Q_ASSERT(m_isComplex);
        return m_complex;
    }

    bool operator==(const NumericLiteralValue &other) const {
        if (m_isComplex != other.m_isComplex) {
            return false;
        }
        if (m_isComplex) {
            return m_complex == other.m_complex;
        }
        return ComplexLiteralValue::numbersEqual(m_number, other.m_number);
    }

private:
    bool m_isComplex;
    double m_number;
    ComplexLiteralValue m_complex;
};

class Token final {
public:
    static Token makeLParen(BracketKind bracketKind) {
        return Token(TokenType::LParen, bracketKind, QString(), NumericLiteralValue(), QString(), QString());
    }

    static Token makeRParen(BracketKind bracketKind) {
        return Token(TokenType::RParen, bracketKind, QString(), NumericLiteralValue(), QString(), QString());
    }

    static Token makeNumber(const QString &typeName, const NumericLiteralValue &value, const QString &raw) {
        return Token(TokenType::Number, BracketKind::Round, typeName, value, raw, QString());
    }

    static Token makeIdentifier(const QString &name) {
        return Token(TokenType::Identifier, BracketKind::Round, QString(), NumericLiteralValue(), QString(), name);
    }

    TokenType kind() const {
        return m_kind;
    }

    BracketKind bracketKind() const {
        return m_bracketKind;
    }

    const QString &typeName() const {
        return m_typeName;
    }

    const NumericLiteralValue &numericValue() const {
        return m_numericValue;
    }

    const QString &raw() const {
        return m_raw;
    }

    const QString &identifierName() const {
        return m_identifierName;
    }

    bool operator==(const Token &other) const {
        return m_kind == other.m_kind
            && m_bracketKind == other.m_bracketKind
            && m_typeName == other.m_typeName
            && m_numericValue == other.m_numericValue
            && m_raw == other.m_raw
            && m_identifierName == other.m_identifierName;
    }

private:
    Token(TokenType kind, BracketKind bracketKind, const QString &typeName, const NumericLiteralValue &numericValue, const QString &raw, const QString &identifierName)
        : m_kind(kind),
          m_bracketKind(bracketKind),
          m_typeName(typeName),
          m_numericValue(numericValue),
          m_raw(raw),
          m_identifierName(identifierName) {
    }

    TokenType m_kind;
    BracketKind m_bracketKind;
    QString m_typeName;
    NumericLiteralValue m_numericValue;
    QString m_raw;
    QString m_identifierName;
};

inline QString bracketKindToText(BracketKind bracketKind) {
    switch (bracketKind) {
    case BracketKind::Round:
        return QStringLiteral("ROUND");
    case BracketKind::Square:
        return QStringLiteral("SQUARE");
    case BracketKind::Curly:
        return QStringLiteral("CURLY");
    case BracketKind::Angle:
        return QStringLiteral("ANGLE");
    }

    Q_UNREACHABLE();
    return QString();
}

inline QString tokenDebugString(const Token &token) {
    switch (token.kind()) {
    case TokenType::LParen:
        return QStringLiteral("LPAREN(%1)").arg(bracketKindToText(token.bracketKind()));
    case TokenType::RParen:
        return QStringLiteral("RPAREN(%1)").arg(bracketKindToText(token.bracketKind()));
    case TokenType::Number:
        return QStringLiteral("NUMBER(%1)").arg(token.raw());
    case TokenType::Identifier:
        return QStringLiteral("IDENTIFIER(%1)").arg(token.identifierName());
    }

    Q_UNREACHABLE();
    return QString();
}

}

#endif