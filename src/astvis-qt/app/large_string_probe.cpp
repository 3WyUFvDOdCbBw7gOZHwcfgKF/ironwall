// Standalone probe for rendering very large string literal references.
#include "astgraphicsitems.h"

#include <memory>

#include <QApplication>
#include <QCommandLineParser>
#include <QDebug>
#include <QDir>
#include <QFileInfo>
#include <QGraphicsScene>
#include <QHash>
#include <QImage>
#include <QPainter>
#include <QString>

namespace {

struct LargeStringCase final {
    QString name;
    QString content;
};

QString repeatedPattern(const QString &pattern, qsizetype count) {
    QString text;
    text.reserve(pattern.size() * count);
    for (qsizetype index = 0; index < count; index += 1) {
        text += pattern;
    }
    return text;
}

QImage renderNodeToImage(const iw::AstNodePtr &node, QRectF *sceneRectOut) {
    QGraphicsScene scene;
    std::unique_ptr<AstGraphicsItem> item(createAstGraphicsItem(node));
    item->setPos(8.0, 8.0);
    scene.addItem(item.get());
    item->refreshLayout();

    const QRectF sceneRect = scene.itemsBoundingRect().adjusted(-8.0, -8.0, 8.0, 8.0);
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
    scene.removeItem(item.get());
    return image;
}

QImage scaledPreview(const QImage &image, int maxSide) {
    if (image.width() <= maxSide && image.height() <= maxSide) {
        return image;
    }
    return image.scaled(maxSide, maxSide, Qt::KeepAspectRatio, Qt::SmoothTransformation);
}

bool writeCaseImage(const LargeStringCase &testCase, const QString &outputDirectoryPath) {
    const QString referenceName = QStringLiteral("$%1^s3").arg(testCase.name);
    setLiteralReferenceDisplayTexts(QHash<QString, QString>{{referenceName, testCase.content}});

    const iw::AstNodePtr node = std::make_shared<iw::TextDatabaseReferenceNode>(
        QStringLiteral("s3"),
        testCase.name,
        referenceName);

    QRectF sceneRect;
    const QImage image = renderNodeToImage(node, &sceneRect);
    const QString basePath = QDir(outputDirectoryPath).filePath(QStringLiteral("large-string-%1").arg(testCase.name));
    const bool fullSaved = image.save(basePath + QStringLiteral(".png"));
    const bool previewSaved = scaledPreview(image, 1600).save(basePath + QStringLiteral("-preview.png"));

    qInfo().noquote()
        << QStringLiteral("%1: chars=%2 scene=%3x%4 full=%5 preview=%6")
               .arg(testCase.name)
               .arg(testCase.content.size())
               .arg(sceneRect.width(), 0, 'f', 1)
               .arg(sceneRect.height(), 0, 'f', 1)
               .arg(QFileInfo(basePath + QStringLiteral(".png")).absoluteFilePath())
               .arg(QFileInfo(basePath + QStringLiteral("-preview.png")).absoluteFilePath());

    return fullSaved && previewSaved;
}

}

int main(int argc, char *argv[]) {
    QApplication app(argc, argv);
    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Render large orange-box string literal probes."));
    parser.addHelpOption();
    parser.addPositionalArgument(QStringLiteral("output-dir"), QStringLiteral("Directory for generated PNG files."));
    parser.process(app);

    const QString outputDirectoryPath = parser.positionalArguments().isEmpty()
        ? QDir::currentPath()
        : parser.positionalArguments().first();
    QDir().mkpath(outputDirectoryPath);

    const QList<LargeStringCase> cases = {
        LargeStringCase{QStringLiteral("wide-256"), repeatedPattern(QStringLiteral("0123456789abcdef"), 16)},
        LargeStringCase{QStringLiteral("wide-2048"), repeatedPattern(QStringLiteral("0123456789abcdef"), 128)},
        LargeStringCase{QStringLiteral("escaped-newlines"), repeatedPattern(QStringLiteral("line\\n"), 180)},
        LargeStringCase{QStringLiteral("punctuation-4096"), repeatedPattern(QStringLiteral("path/to/file::{key=value}; "), 170)},
    };

    bool ok = true;
    for (const LargeStringCase &testCase : cases) {
        ok = writeCaseImage(testCase, outputDirectoryPath) && ok;
    }

    return ok ? 0 : 1;
}
