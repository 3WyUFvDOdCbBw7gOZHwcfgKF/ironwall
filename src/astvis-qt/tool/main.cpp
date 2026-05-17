// Qt AST viewer tool: CLI for dumping shared frontend JSON from stdin.
#include <cstdio>

#include <QCoreApplication>
#include <QFile>
#include <QTextStream>

#include "../core/iwfrontendjson.h"
#include "../core/iwparser.h"

namespace {

enum class OutputMode {
    Ast,
    Tokens,
    Bundle,
};

OutputMode parseOutputMode(const QStringList &arguments) {
    OutputMode outputMode = OutputMode::Ast;
    for (qsizetype index = 1; index < arguments.size(); index += 1) {
        const QString &argument = arguments.at(index);
        if (argument == QStringLiteral("--ast")) {
            outputMode = OutputMode::Ast;
            continue;
        }
        if (argument == QStringLiteral("--tokens")) {
            outputMode = OutputMode::Tokens;
            continue;
        }
        if (argument == QStringLiteral("--bundle")) {
            outputMode = OutputMode::Bundle;
            continue;
        }
        throw std::runtime_error(QStringLiteral("Unsupported argument: %1").arg(argument).toStdString());
    }
    return outputMode;
}

QString readStdInText() {
    QFile stdInFile;
    if (!stdInFile.open(stdin, QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error("Failed to read stdin");
    }
    return QString::fromUtf8(stdInFile.readAll());
}

}

int main(int argc, char *argv[]) {
    QCoreApplication app(argc, argv);
    QTextStream stdOut(stdout);
    QTextStream stdErr(stderr);

    try {
        const OutputMode outputMode = parseOutputMode(app.arguments());
        const QString source = readStdInText();
        const iw::TokenList tokens = iw::tokenize(source);

        if (outputMode == OutputMode::Tokens) {
            stdOut << iw::dumpTokensToJsonText(tokens);
            return 0;
        }

        const iw::AstNodePtr ast = iw::parse(tokens);
        if (outputMode == OutputMode::Bundle) {
            stdOut << iw::dumpFrontendBundleToJsonText(tokens, ast);
            return 0;
        }

        stdOut << iw::dumpAstToJsonText(ast);
        return 0;
    } catch (const std::exception &error) {
        stdErr << QString::fromUtf8(error.what()) << '\n';
        return 1;
    }
}