// Qt AST viewer core: shared token/AST JSON serializers for TS/C++ frontend parity.
#ifndef IW_ASTVIS_QT_CORE_IWFRONTENDJSON_H
#define IW_ASTVIS_QT_CORE_IWFRONTENDJSON_H

#include <QString>

#include "iwast.h"
#include "iwlexer.h"

namespace iw {

QString dumpTokensToJsonText(const TokenList &tokens);
QString dumpAstToJsonText(const AstNodePtr &node);
QString dumpFrontendBundleToJsonText(const TokenList &tokens, const AstNodePtr &ast);

}

#endif