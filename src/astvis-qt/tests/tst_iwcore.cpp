// QtTest regressions for the Ironwall AST viewer core.
#include <memory>
#include <stdexcept>

#include <QFile>
#include <QGraphicsScene>
#include <QImage>
#include <QPainter>
#include <QTemporaryDir>
#include <QtTest>

#include "astgraphicsitems.h"
#include "iwast.h"
#include "iwformatter.h"
#include "iwlexer.h"
#include "iwparser.h"

namespace {

void compareTokens(const iw::TokenList &actual, const iw::TokenList &expected) {
    QCOMPARE(actual.size(), expected.size());
    for (qsizetype index = 0; index < actual.size(); index += 1) {
        QCOMPARE(actual.at(index) == expected.at(index), true);
    }
}

QString lintFormatSingleFile(const QString &filePath, bool fixFormatting) {
    QFile sourceFile(filePath);
    if (!sourceFile.open(QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error("Failed to open source file.");
    }
    const QString source = QString::fromUtf8(sourceFile.readAll());
    sourceFile.close();

    const QString formatted = iw::formatIw(iw::parseProgramSource(source));
    if (source == formatted) {
        return QStringLiteral("Formatting OK: 1 file(s)");
    }
    if (!fixFormatting) {
        throw std::runtime_error("Formatting mismatch");
    }

    if (!sourceFile.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        throw std::runtime_error("Failed to rewrite source file.");
    }
    sourceFile.write(formatted.toUtf8());
    sourceFile.close();
    return QStringLiteral("Formatting fixed: 1/1 file(s)");
}

QString readUtf8File(const QString &filePath) {
    QFile sourceFile(filePath);
    if (!sourceFile.open(QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error("Failed to open source file.");
    }
    return QString::fromUtf8(sourceFile.readAll());
}

iw::AstNodePtr parseSourceText(const QString &source) {
    return iw::parse(iw::tokenize(source));
}

iw::AstNodePtr parseSourceFile(const QString &filePath) {
    return parseSourceText(readUtf8File(filePath));
}

std::shared_ptr<iw::DfunNode> firstProgramFunction(const iw::AstNodePtr &ast) {
    const std::shared_ptr<iw::ProgramNode> programNode = std::dynamic_pointer_cast<iw::ProgramNode>(ast);
    if (!programNode || programNode->topLevelExpressions().empty()) {
        throw std::runtime_error("Expected a program with at least one top-level function.");
    }

    const std::shared_ptr<iw::DfunNode> functionNode = std::dynamic_pointer_cast<iw::DfunNode>(programNode->topLevelExpressions().front());
    if (!functionNode) {
        throw std::runtime_error("Expected first top-level expression to be a function.");
    }
    return functionNode;
}

std::shared_ptr<iw::DfunNode> findProgramFunction(const iw::AstNodePtr &ast, const QString &name) {
    const std::shared_ptr<iw::ProgramNode> programNode = std::dynamic_pointer_cast<iw::ProgramNode>(ast);
    if (!programNode) {
        throw std::runtime_error("Expected a program node.");
    }

    for (const iw::AstNodePtr &expression : programNode->topLevelExpressions()) {
        const std::shared_ptr<iw::DfunNode> functionNode = std::dynamic_pointer_cast<iw::DfunNode>(expression);
        if (functionNode && functionNode->name()->name() == name) {
            return functionNode;
        }
    }

    throw std::runtime_error(QStringLiteral("Missing function in fixture: %1").arg(name).toStdString());
}

QImage renderAstToImage(const iw::AstNodePtr &ast, QRectF *sceneRectOut = nullptr) {
    QGraphicsScene scene;
    AstGraphicsItem *rootItem = createAstGraphicsItem(ast);
    rootItem->setPos(20.0, 20.0);
    scene.addItem(rootItem);
    rootItem->refreshLayout();

    const QRectF sceneRect = scene.itemsBoundingRect().adjusted(-20.0, -20.0, 20.0, 20.0);
    scene.setSceneRect(sceneRect);

    if (sceneRectOut) {
        *sceneRectOut = sceneRect;
    }

    const QSize imageSize(
        std::max(1, qCeil(sceneRect.width())),
        std::max(1, qCeil(sceneRect.height())));
    QImage image(imageSize, QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::white);

    QPainter painter(&image);
    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setRenderHint(QPainter::TextAntialiasing, true);
    scene.render(&painter, QRectF(QPointF(0.0, 0.0), QSizeF(imageSize)), sceneRect);
    return image;
}

int countNonWhitePixels(const QImage &image) {
    int count = 0;
    for (int y = 0; y < image.height(); y += 1) {
        const QRgb *scanLine = reinterpret_cast<const QRgb *>(image.constScanLine(y));
        for (int x = 0; x < image.width(); x += 1) {
            if (scanLine[x] != qRgb(255, 255, 255)) {
                count += 1;
            }
        }
    }
    return count;
}

}

class IwCoreTest final : public QObject {
    Q_OBJECT

private slots:
    void currentTokenRegressionCases();
    void formatterCollapsesNestedCmGetChains();
    void formatterRoundTripsDirectDotSugar();
    void lintFormatFixesEligibleMemberChainsOnly();
    void parserBuildsExpectedCallTree();
    void parserPreservesPublicAndExportNodes();
    void parserRejectsMismatchedBrackets();
    void functionCallParensTrackChildHeightNotWidth();
    void graphicsRenderNestedCmGetAndCmSetCalls_data();
    void graphicsRenderNestedCmGetAndCmSetCalls();
    void graphicsRenderVisualizationFixtures_data();
    void graphicsRenderVisualizationFixtures();
};

void IwCoreTest::currentTokenRegressionCases() {
    compareTokens(iw::tokenize(QStringLiteral("source-left-right")), iw::TokenList());
    compareTokens(
        iw::tokenize(QStringLiteral("_ffi_symbol")),
        iw::TokenList{iw::Token::makeIdentifier(QStringLiteral("_ffi_symbol"))});
    compareTokens(
        iw::tokenize(QStringLiteral("pkg~name@_ffi_symbol")),
        iw::TokenList{iw::Token::makeIdentifier(QStringLiteral("pkg~name@_ffi_symbol"))});
}

void IwCoreTest::formatterCollapsesNestedCmGetChains() {
    const QString dottedSource = QStringLiteral("{program test~member~sugar@main (function main ([args <array s3>]) to i5 in (cm_get (cm_get data left) right))}");
    const QString expected = QStringLiteral(
        "{program test~member~sugar@main\n"
        "  (function main ([args <array s3>]) to i5 in data.left.right)\n"
        "}\n");
    QCOMPARE(iw::formatIw(iw::parseProgramSource(dottedSource)), expected);
}

void IwCoreTest::formatterRoundTripsDirectDotSugar() {
    const QString source = QStringLiteral("{program test~member~source@main (function main ([args <array s3>]) to i5 in source.left.right)}");
    const QString expected = QStringLiteral(
        "{program test~member~source@main\n"
        "  (function main ([args <array s3>]) to i5 in source.left.right)\n"
        "}\n");
    QCOMPARE(iw::formatIw(iw::parseProgramSource(source)), expected);
}

void IwCoreTest::lintFormatFixesEligibleMemberChainsOnly() {
    QTemporaryDir tempDir;
    QVERIFY(tempDir.isValid());

    const QString filePath = tempDir.path() + QStringLiteral("/test~member~lint@main.iw");
    QFile file(filePath);
    QVERIFY(file.open(QIODevice::WriteOnly | QIODevice::Text));
    file.write(QStringLiteral(
                   "{program test~member~lint@main\n"
                   "(function main ([args <array s3>]) to i5 in\n"
                   "{\n"
                   "((cm_get source set) $0^i5 $1^i5)\n"
                   "(cm_get (cm_get source left) right)\n"
                   "(cm_get (array_get raw $0^i5) value)\n"
                   "}\n"
                   ")\n"
                   "}\n")
                       .toUtf8());
    file.close();

    QCOMPARE(lintFormatSingleFile(filePath, true), QStringLiteral("Formatting fixed: 1/1 file(s)"));

    QVERIFY(file.open(QIODevice::ReadOnly | QIODevice::Text));
    const QString formattedSource = QString::fromUtf8(file.readAll());
    file.close();

    QCOMPARE(
        formattedSource,
        QStringLiteral(
            "{program test~member~lint@main\n"
            "  (function main ([args <array s3>]) to i5 in\n"
            "    {\n"
            "      (source.set $0^i5 $1^i5)\n"
            "      source.left.right\n"
            "      (cm_get (array_get raw $0^i5) value)\n"
            "    }\n"
            "  )\n"
            "}\n"));

    QCOMPARE(lintFormatSingleFile(filePath, false), QStringLiteral("Formatting OK: 1 file(s)"));
}

void IwCoreTest::parserBuildsExpectedCallTree() {
    const std::shared_ptr<iw::ProgramNode> program = iw::parseProgramSource(
        QStringLiteral("{program test~parser@main (function main ([args <array s3>]) to i5 in source.left.right)}"));
    QCOMPARE(program->topLevelExpressions().size(), std::size_t(1));

    const std::shared_ptr<iw::DfunNode> functionNode = std::dynamic_pointer_cast<iw::DfunNode>(program->topLevelExpressions().at(0));
    QVERIFY(functionNode != nullptr);
    QCOMPARE(functionNode->params().size(), std::size_t(1));

    const std::shared_ptr<iw::FunctionCallNode> outerCall = std::dynamic_pointer_cast<iw::FunctionCallNode>(functionNode->body());
    QVERIFY(outerCall != nullptr);
    const std::shared_ptr<iw::IdentifierNode> outerCallee = std::dynamic_pointer_cast<iw::IdentifierNode>(outerCall->callee());
    QVERIFY(outerCallee != nullptr);
    QCOMPARE(outerCallee->name(), QStringLiteral("cm_get"));

    const std::shared_ptr<iw::FunctionCallNode> innerCall = std::dynamic_pointer_cast<iw::FunctionCallNode>(outerCall->args().at(0));
    QVERIFY(innerCall != nullptr);
    const std::shared_ptr<iw::IdentifierNode> lastField = std::dynamic_pointer_cast<iw::IdentifierNode>(outerCall->args().at(1));
    QVERIFY(lastField != nullptr);
    QCOMPARE(lastField->name(), QStringLiteral("right"));

    const std::shared_ptr<iw::IdentifierNode> innerCallee = std::dynamic_pointer_cast<iw::IdentifierNode>(innerCall->callee());
    QVERIFY(innerCallee != nullptr);
    QCOMPARE(innerCallee->name(), QStringLiteral("cm_get"));
}

void IwCoreTest::parserPreservesPublicAndExportNodes() {
    const std::shared_ptr<iw::ProgramNode> program = iw::parseProgramSource(
        QStringLiteral(
            "{program test~public~export@defs "
            "(export (class Counter "
            "(public (property [value i5])) "
            "(public (method read () to i5 in (cm_get self value))) "
            "(constructor ([init i5]) in (cm_set self value init))"
            ")) "
            "(export (function make_counter ([value i5]) to Counter in (class_new Counter value)))"
            "}"));

    QCOMPARE(program->topLevelExpressions().size(), std::size_t(2));

    const std::shared_ptr<iw::ExportNode> exportedClass = std::dynamic_pointer_cast<iw::ExportNode>(program->topLevelExpressions().at(0));
    QVERIFY(exportedClass != nullptr);
    const std::shared_ptr<iw::ClassNode> classNode = std::dynamic_pointer_cast<iw::ClassNode>(exportedClass->inner());
    QVERIFY(classNode != nullptr);
    QCOMPARE(classNode->propertyNodeList().size(), std::size_t(1));
    QCOMPARE(classNode->methodNodeList().size(), std::size_t(1));
    QCOMPARE(classNode->constructorNodeList().size(), std::size_t(1));
    QCOMPARE(classNode->memberNodeList().size(), std::size_t(3));
    QVERIFY(std::dynamic_pointer_cast<iw::PublicNode>(classNode->memberNodeList().at(0)) != nullptr);
    QVERIFY(std::dynamic_pointer_cast<iw::PublicNode>(classNode->memberNodeList().at(1)) != nullptr);
    QVERIFY(std::dynamic_pointer_cast<iw::ClassConstructorNode>(classNode->memberNodeList().at(2)) != nullptr);

    const std::shared_ptr<iw::ExportNode> exportedFunction = std::dynamic_pointer_cast<iw::ExportNode>(program->topLevelExpressions().at(1));
    QVERIFY(exportedFunction != nullptr);
    QVERIFY(std::dynamic_pointer_cast<iw::DfunNode>(exportedFunction->inner()) != nullptr);
}

void IwCoreTest::parserRejectsMismatchedBrackets() {
    bool threw = false;
    try {
        iw::parsePass1(iw::tokenize(QStringLiteral("(source]")));
    } catch (const std::runtime_error &) {
        threw = true;
    }
    QCOMPARE(threw, true);
}

void IwCoreTest::functionCallParensTrackChildHeightNotWidth() {
    const iw::AstNodePtr narrowAst = parseSourceText(
        QStringLiteral("{program test~astvis~paren~narrow@main (function main ([args <array s3>]) to i5 in (emit short_name))}"));
    const iw::AstNodePtr wideAst = parseSourceText(
        QStringLiteral("{program test~astvis~paren~wide@main (function main ([args <array s3>]) to i5 in (emit identifier_name_that_is_extremely_wide_but_has_the_same_line_height))}"));

    const iw::AstNodePtr narrowBody = firstProgramFunction(narrowAst)->body();
    const iw::AstNodePtr wideBody = firstProgramFunction(wideAst)->body();
    QVERIFY(std::dynamic_pointer_cast<iw::FunctionCallNode>(narrowBody) != nullptr);
    QVERIFY(std::dynamic_pointer_cast<iw::FunctionCallNode>(wideBody) != nullptr);

    std::unique_ptr<AstGraphicsItem> narrowItem(createAstGraphicsItem(narrowBody));
    std::unique_ptr<AstGraphicsItem> wideItem(createAstGraphicsItem(wideBody));
    narrowItem->refreshLayout();
    wideItem->refreshLayout();

    QVERIFY(qAbs(narrowItem->boundingRect().height() - wideItem->boundingRect().height()) < 0.25);
}

void IwCoreTest::graphicsRenderNestedCmGetAndCmSetCalls_data() {
    QTest::addColumn<QString>("fixturePath");
    QTest::addColumn<QString>("functionName");
    QTest::addColumn<qreal>("maxBodyHeight");

    const QString fixturePath = QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~member~chain~gallery@main.iw");

    QTest::addRow("deep-cm-get-chain")
        << fixturePath
        << QStringLiteral("deep_cm_get_chain")
        << 70.0;

    QTest::addRow("cm-set-nested-member-lvalue")
        << fixturePath
        << QStringLiteral("cm_set_nested_member_lvalue")
        << 80.0;

    QTest::addRow("cm-set-nested-member-value")
        << fixturePath
        << QStringLiteral("cm_set_nested_member_value")
        << 80.0;

    QTest::addRow("mixed-member-updates")
        << fixturePath
        << QStringLiteral("mixed_member_updates")
        << 260.0;
}

void IwCoreTest::graphicsRenderNestedCmGetAndCmSetCalls() {
    QFETCH(QString, fixturePath);
    QFETCH(QString, functionName);
    QFETCH(qreal, maxBodyHeight);

    const QString absoluteFixturePath = QFINDTESTDATA(qPrintable(fixturePath));
    QVERIFY2(!absoluteFixturePath.isEmpty(), qPrintable(QStringLiteral("Missing fixture: %1").arg(fixturePath)));

    const iw::AstNodePtr body = findProgramFunction(parseSourceFile(absoluteFixturePath), functionName)->body();
    std::unique_ptr<AstGraphicsItem> bodyItem(createAstGraphicsItem(body));
    bodyItem->refreshLayout();

    QVERIFY(bodyItem->boundingRect().width() > 40.0);
    QVERIFY(bodyItem->boundingRect().height() > 18.0);
    QVERIFY2(
        bodyItem->boundingRect().height() < maxBodyHeight,
        qPrintable(QStringLiteral("Unexpectedly tall member-call rendering: %1").arg(bodyItem->boundingRect().height())));

    QRectF sceneRect;
    const QImage image = renderAstToImage(body, &sceneRect);
    QVERIFY(sceneRect.width() > 60.0);
    QVERIFY(sceneRect.height() > 40.0);
    QVERIFY(countNonWhitePixels(image) > 80);
}

void IwCoreTest::graphicsRenderVisualizationFixtures_data() {
    QTest::addColumn<QString>("fixturePath");

    QTest::addRow("cond-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~cond~gallery@main.iw");
    QTest::addRow("match-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~match~gallery@main.iw");
    QTest::addRow("fncall-block-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~fncall~blocks@main.iw");
    QTest::addRow("member-chain-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~member~chain~gallery@main.iw");
    QTest::addRow("member-block-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~member~block~gallery@main.iw");
    QTest::addRow("assignment-block-gallery") << QStringLiteral("../../Test/Fixtures/astvis-visualization/test~astvis~assignment~block~gallery@main.iw");
}

void IwCoreTest::graphicsRenderVisualizationFixtures() {
    QFETCH(QString, fixturePath);

    const QString absoluteFixturePath = QFINDTESTDATA(qPrintable(fixturePath));
    QVERIFY2(!absoluteFixturePath.isEmpty(), qPrintable(QStringLiteral("Missing fixture: %1").arg(fixturePath)));

    QRectF sceneRect;
    const QImage image = renderAstToImage(parseSourceFile(absoluteFixturePath), &sceneRect);

    QVERIFY(sceneRect.width() > 120.0);
    QVERIFY(sceneRect.height() > 120.0);
    QVERIFY(countNonWhitePixels(image) > 400);
}

QTEST_MAIN(IwCoreTest)

#include "tst_iwcore.moc"
