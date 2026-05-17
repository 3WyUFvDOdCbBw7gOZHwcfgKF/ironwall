// Qt AST viewer core: Ironwall lexer interfaces.
#ifndef IW_ASTVIS_QT_CORE_IWLEXER_H
#define IW_ASTVIS_QT_CORE_IWLEXER_H

#include <optional>

#include <QVector>

#include "iwtoken.h"

namespace iw {

class TextDatabaseReferenceInfo final {
public:
    TextDatabaseReferenceInfo(const QString &typeName, const QString &entryName, const QString &referenceName)
        : m_typeName(typeName),
          m_entryName(entryName),
          m_referenceName(referenceName) {
    }

    const QString &typeName() const {
        return m_typeName;
    }

    const QString &entryName() const {
        return m_entryName;
    }

    const QString &referenceName() const {
        return m_referenceName;
    }

private:
    QString m_typeName;
    QString m_entryName;
    QString m_referenceName;
};

class TypedNumericLiteralInfo final {
public:
    TypedNumericLiteralInfo(const QString &typeName, const QString &payload)
        : m_typeName(typeName),
          m_payload(payload) {
    }

    const QString &typeName() const {
        return m_typeName;
    }

    const QString &payload() const {
        return m_payload;
    }

private:
    QString m_typeName;
    QString m_payload;
};

using TokenList = QVector<Token>;

std::optional<TextDatabaseReferenceInfo> parseTextDatabaseReferenceName(const QString &name);
bool isTextDatabaseReferenceName(const QString &name);
std::optional<TypedNumericLiteralInfo> parseTypedNumericLiteral(const QString &name);
bool isMemberChainSegmentText(const QString &chunk);
TokenList tokenize(const QString &input);

}

#endif