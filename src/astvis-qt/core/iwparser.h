// Qt AST viewer core: parser interfaces.
#ifndef IW_ASTVIS_QT_CORE_IWPARSER_H
#define IW_ASTVIS_QT_CORE_IWPARSER_H

#include "iwast.h"
#include "iwlexer.h"

namespace iw {

AstNodePtr parsePass1(const TokenList &tokens);
AstNodePtr parse(const TokenList &tokens);
std::shared_ptr<ProgramNode> parseProgramSource(const QString &source);

}

#endif