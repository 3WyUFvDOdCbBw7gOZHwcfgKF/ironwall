// Qt AST viewer tool: CLI for dumping shared frontend JSON from stdin.
#include <cstdio>

#include <QByteArray>
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

struct CliOptions final {
    OutputMode outputMode = OutputMode::Ast;
    QString inputFilePath;
};

CliOptions parseCliOptions(const QStringList &arguments) {
    CliOptions options;
    for (qsizetype index = 1; index < arguments.size(); index += 1) {
        const QString &argument = arguments.at(index);
        if (argument == QStringLiteral("--ast")) {
            options.outputMode = OutputMode::Ast;
            continue;
        }
        if (argument == QStringLiteral("--tokens")) {
            options.outputMode = OutputMode::Tokens;
            continue;
        }
        if (argument == QStringLiteral("--bundle")) {
            options.outputMode = OutputMode::Bundle;
            continue;
        }
        if (argument == QStringLiteral("--input-file")) {
            if (index + 1 >= arguments.size()) {
                throw std::runtime_error("--input-file expects a path");
            }
            index += 1;
            options.inputFilePath = arguments.at(index);
            continue;
        }
        throw std::runtime_error(QStringLiteral("Unsupported argument: %1").arg(argument).toStdString());
    }
    return options;
}

QString readInputFileText(const QString &filePath) {
    QFile inputFile(filePath);
    if (!inputFile.open(QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error(QStringLiteral("Failed to read input file: %1").arg(filePath).toStdString());
    }
    return QString::fromUtf8(inputFile.readAll());
}

QString readStdInText() {
    QByteArray bytes;
    char buffer[4096];
    while (true) {
        const std::size_t readCount = std::fread(buffer, 1, sizeof(buffer), stdin);
        if (readCount > 0) {
            bytes.append(buffer, static_cast<qsizetype>(readCount));
        }
        if (readCount < sizeof(buffer)) {
            if (std::ferror(stdin)) {
                throw std::runtime_error("Failed to read stdin");
            }
            break;
        }
    }
    return QString::fromUtf8(bytes);
}

QString readInputText(const QString &inputFilePath) {
    if (!inputFilePath.isEmpty()) {
        return readInputFileText(inputFilePath);
    }
    return readStdInText();
}

}

int main(int argc, char *argv[]) {
    QStringList arguments;
    for (int index = 0; index < argc; index += 1) {
        arguments.push_back(QString::fromLocal8Bit(argv[index]));
    }

    QCoreApplication app(argc, argv);
    QTextStream stdOut(stdout);
    QTextStream stdErr(stderr);

    try {
        const CliOptions options = parseCliOptions(arguments);
        const QString source = readInputText(options.inputFilePath);
        const iw::TokenList tokens = iw::tokenize(source);

        if (options.outputMode == OutputMode::Tokens) {
            stdOut << iw::dumpTokensToJsonText(tokens);
            return 0;
        }

        const iw::AstNodePtr ast = iw::parse(tokens);
        if (options.outputMode == OutputMode::Bundle) {
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
