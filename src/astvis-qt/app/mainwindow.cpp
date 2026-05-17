// Qt Widgets front-end for the Ironwall AST viewer.
#include "mainwindow.h"

#include "astgraphicsitems.h"

#include <algorithm>
#include <exception>
#include <functional>

#include <QAction>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QColorDialog>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFontMetrics>
#include <QFontDatabase>
#include <QFrame>
#include <QJsonArray>
#include <QGraphicsScene>
#include <QGraphicsTextItem>
#include <QGraphicsView>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QListWidget>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QPainter>
#include <QKeySequence>
#include <QPushButton>
#include <QRegularExpression>
#include <QScrollBar>
#include <QShortcut>
#include <QTabWidget>
#include <QVariant>
#include <QVBoxLayout>
#include <QWidget>

#include "iwlexer.h"
#include "iwparser.h"

namespace {

constexpr int MaxOpenTabs = 30;
constexpr int MaxFolderFileCount = 5000;
constexpr qint64 MaxOpenFileBytes = 100 * 1024;
constexpr int MaxFileDialogWidth = 1000;
constexpr int MaxFileDialogHeight = 500;
constexpr int MinFileDialogWidth = 420;
constexpr int MinFileDialogHeight = 180;

QString packageNameForProgram(const iw::AstNodePtr &node) {
    const std::shared_ptr<iw::ProgramNode> programNode = std::dynamic_pointer_cast<iw::ProgramNode>(node);
    if (!programNode || !programNode->unitId()) {
        return QString();
    }

    const QString unitName = programNode->unitId()->name();
    const qsizetype atIndex = unitName.indexOf(QChar('@'));
    return atIndex >= 0 ? unitName.left(atIndex) : unitName;
}

void collectTextReferences(const iw::AstNodePtr &node, std::vector<std::shared_ptr<iw::TextDatabaseReferenceNode>> &references) {
    if (!node) {
        return;
    }
    if (const std::shared_ptr<iw::TextDatabaseReferenceNode> reference = std::dynamic_pointer_cast<iw::TextDatabaseReferenceNode>(node)) {
        references.push_back(reference);
        return;
    }
    for (const iw::AstNodePtr &child : node->childNodes()) {
        collectTextReferences(child, references);
    }
}

bool isPackageReferenceName(const QString &referenceName) {
    return referenceName.contains(QChar('$')) && !referenceName.startsWith(QChar('$'));
}

QString canonicalReferenceName(const std::shared_ptr<iw::TextDatabaseReferenceNode> &reference, const QString &programPackageName) {
    if (isPackageReferenceName(reference->referenceName())) {
        return reference->referenceName();
    }
    if (programPackageName.isEmpty()) {
        return reference->referenceName();
    }
    return QStringLiteral("%1$%2^%3").arg(programPackageName, reference->entryName(), reference->typeName());
}

QString dbPackageNameFromStem(const QString &stem) {
    const qsizetype dollarIndex = stem.indexOf(QChar('$'));
    if (dollarIndex <= 0) {
        return QString();
    }
    return stem.left(dollarIndex);
}

QString colorButtonStyle(const QColor &color) {
    return QStringLiteral("background-color: %1; color: %2;")
        .arg(color.name(QColor::HexRgb),
             color.lightness() < 128 ? QStringLiteral("#ffffff") : QStringLiteral("#000000"));
}

void updateColorButton(QPushButton *button, const QColor &color) {
    button->setText(color.name(QColor::HexRgb));
    button->setStyleSheet(colorButtonStyle(color));
}

QJsonObject colorObject(const AstVisTheme &theme) {
    QJsonObject object;
    object.insert(QStringLiteral("background"), theme.backgroundColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("text"), theme.textColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("keyword"), theme.keywordColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("type"), theme.typeColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("number"), theme.numberColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("string"), theme.stringColor.name(QColor::HexRgb));
    object.insert(QStringLiteral("logicalKeyword"), theme.logicalKeywordColor.name(QColor::HexRgb));
    return object;
}

void applyColorValue(const QJsonObject &object, const QString &key, QColor *color) {
    const QColor parsed(object.value(key).toString());
    if (parsed.isValid()) {
        *color = parsed;
    }
}

}

MainWindow::MainWindow(const QString &rootDirectoryPath, QWidget *parent)
    : QMainWindow(parent),
      m_rootDirectoryPath(QString()),
      m_tabs(new QTabWidget(this)) {
    resize(1280, 760);
    loadSettings();
    const QString initialRootDirectoryPath = rootDirectoryPath.isEmpty()
        ? QString()
        : QDir(rootDirectoryPath).absolutePath();

    m_fileMenu = menuBar()->addMenu(QStringLiteral("File"));
    m_openFolderAction = m_fileMenu->addAction(QStringLiteral("Open Folder..."));
    m_closeFolderAction = m_fileMenu->addAction(QStringLiteral("Close Folder"));
    m_recentFoldersMenu = m_fileMenu->addMenu(QStringLiteral("Recent Folders"));
    m_clearFolderHistoryAction = m_fileMenu->addAction(QStringLiteral("Clear Folder History"));
    m_fileMenu->addSeparator();
    QAction *exitAction = m_fileMenu->addAction(QStringLiteral("Exit"));

    m_folderMenu = menuBar()->addMenu(QStringLiteral("Folder"));
    m_selectFileAction = m_folderMenu->addAction(QStringLiteral("Select File..."));
    m_refreshFolderAction = m_folderMenu->addAction(QStringLiteral("Refresh"));

    QMenu *viewMenu = menuBar()->addMenu(QStringLiteral("View"));
    QAction *chooseMathFontAction = viewMenu->addAction(QStringLiteral("Choose Math Font..."));
    QMenu *themeMenu = viewMenu->addMenu(QStringLiteral("Theme"));
    QAction *lightThemeAction = themeMenu->addAction(QStringLiteral("Light"));
    QAction *darkThemeAction = themeMenu->addAction(QStringLiteral("Dark"));
    QAction *customThemeAction = themeMenu->addAction(QStringLiteral("Custom..."));
    QMenu *literalMenu = viewMenu->addMenu(QStringLiteral("Orange Box"));
    m_showFullLiteralsAction = literalMenu->addAction(QStringLiteral("Show Full Text"));
    m_showFullLiteralsAction->setCheckable(true);
    m_showFullLiteralsAction->setChecked(literalDisplayOptions().showFullText);
    m_renderLiteralControlsAction = literalMenu->addAction(QStringLiteral("Render Control Characters"));
    m_renderLiteralControlsAction->setCheckable(true);
    m_renderLiteralControlsAction->setChecked(literalDisplayOptions().renderControlCharacters);
    m_showLiteralReferencesAction = literalMenu->addAction(QStringLiteral("Show Reference Name"));
    m_showLiteralReferencesAction->setCheckable(true);
    m_showLiteralReferencesAction->setChecked(literalDisplayOptions().showReferenceName);
    viewMenu->addSeparator();
    m_restoreDefaultSettingsAction = viewMenu->addAction(QStringLiteral("Restore Default Settings"));

    QMenu *helpMenu = menuBar()->addMenu(QStringLiteral("Help"));
    QAction *helpAction = helpMenu->addAction(QStringLiteral("Help"));

    m_selectFileAction->setShortcut(QKeySequence(Qt::Key_F1));

    m_tabs->setTabsClosable(true);
    setCentralWidget(m_tabs);

    connect(m_tabs, &QTabWidget::tabCloseRequested, this, &MainWindow::closeTab);
    connect(m_openFolderAction, &QAction::triggered, this, &MainWindow::openFolder);
    connect(m_closeFolderAction, &QAction::triggered, this, &MainWindow::closeFolder);
    connect(m_selectFileAction, &QAction::triggered, this, &MainWindow::showFileDialog);
    connect(m_refreshFolderAction, &QAction::triggered, this, &MainWindow::refreshFolder);
    connect(m_clearFolderHistoryAction, &QAction::triggered, this, &MainWindow::clearFolderHistory);
    connect(m_restoreDefaultSettingsAction, &QAction::triggered, this, &MainWindow::restoreDefaultSettings);
    connect(exitAction, &QAction::triggered, this, &QWidget::close);
    connect(helpAction, &QAction::triggered, this, &MainWindow::showHelp);
    connect(chooseMathFontAction, &QAction::triggered, this, &MainWindow::chooseMathFont);
    connect(lightThemeAction, &QAction::triggered, this, &MainWindow::setLightTheme);
    connect(darkThemeAction, &QAction::triggered, this, &MainWindow::setDarkTheme);
    connect(customThemeAction, &QAction::triggered, this, &MainWindow::chooseCustomTheme);
    connect(m_showFullLiteralsAction, &QAction::triggered, this, &MainWindow::updateLiteralDisplayOptions);
    connect(m_renderLiteralControlsAction, &QAction::triggered, this, &MainWindow::updateLiteralDisplayOptions);
    connect(m_showLiteralReferencesAction, &QAction::triggered, this, &MainWindow::updateLiteralDisplayOptions);

    loadFolderHistory();
    if (!initialRootDirectoryPath.isEmpty()) {
        setRootDirectory(initialRootDirectoryPath);
    }
    updateWindowTitle();
    updateFileMenu();
    updateSettingsActions();
    saveSettings();
}

void MainWindow::populateFileList() {
    m_filePaths.clear();
    if (m_rootDirectoryPath.isEmpty()) {
        return;
    }

    QDirIterator iterator(
        m_rootDirectoryPath,
        QStringList{QStringLiteral("*.iw")},
        QDir::Files,
        QDirIterator::Subdirectories);
    while (iterator.hasNext()) {
        const QString filePath = iterator.next();
        m_filePaths.append(filePath);
    }

    m_filePaths.sort(Qt::CaseInsensitive);
}

void MainWindow::setRootDirectory(const QString &rootDirectoryPath) {
    const QString absolutePath = QDir(rootDirectoryPath).absolutePath();
    if (absolutePath == m_rootDirectoryPath) {
        return;
    }
    if (!validateFolderFileLimit(absolutePath)) {
        return;
    }

    clearOpenTabs();
    m_rootDirectoryPath = absolutePath;
    addFolderHistory(m_rootDirectoryPath);
    populateFileList();
    updateWindowTitle();
    updateFileMenu();
}

bool MainWindow::validateFolderFileLimit(const QString &folderPath) {
    int fileCount = 0;
    QDirIterator iterator(folderPath, QDir::Files, QDirIterator::Subdirectories);
    while (iterator.hasNext()) {
        iterator.next();
        fileCount += 1;
        if (fileCount > MaxFolderFileCount) {
            QMessageBox::warning(
                this,
                QStringLiteral("Folder Too Large"),
                QStringLiteral("The selected folder contains more than %1 files and cannot be opened.").arg(MaxFolderFileCount));
            return false;
        }
    }
    return true;
}

bool MainWindow::validateOpenFile(const QString &filePath) {
    const QFileInfo fileInfo(filePath);
    if (!fileInfo.exists() || !fileInfo.isFile()) {
        QMessageBox::warning(
            this,
            QStringLiteral("File Not Found"),
            QStringLiteral("The file no longer exists:\n%1").arg(filePath));
        return false;
    }
    if (fileInfo.size() > MaxOpenFileBytes) {
        QMessageBox::warning(
            this,
            QStringLiteral("File Too Large"),
            QStringLiteral("Files larger than 100 KB cannot be opened:\n%1").arg(filePath));
        return false;
    }
    return true;
}

void MainWindow::clearOpenTabs() {
    while (m_tabs->count() > 0) {
        QWidget *page = m_tabs->widget(0);
        m_tabs->removeTab(0);
        delete page;
    }
}

void MainWindow::openFile(const QString &filePath) {
    if (!validateOpenFile(filePath)) {
        return;
    }

    for (int index = 0; index < m_tabs->count(); index += 1) {
        if (m_tabs->widget(index)->property("filePath").toString() == filePath) {
            m_tabs->setCurrentIndex(index);
            return;
        }
    }

    if (m_tabs->count() >= MaxOpenTabs) {
        QMessageBox::warning(
            this,
            QStringLiteral("Tab Limit Reached"),
            QStringLiteral("A maximum of %1 tabs can be open at the same time.").arg(MaxOpenTabs));
        return;
    }

    QWidget *page = new QWidget(m_tabs);
    QVBoxLayout *layout = new QVBoxLayout(page);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);

    QGraphicsScene *scene = new QGraphicsScene(page);
    QGraphicsView *view = new QGraphicsView(page);
    view->setScene(scene);
    view->setRenderHint(QPainter::Antialiasing, true);
    view->setRenderHint(QPainter::TextAntialiasing, true);
    view->setDragMode(QGraphicsView::ScrollHandDrag);
    view->setViewportUpdateMode(QGraphicsView::BoundingRectViewportUpdate);
    view->setBackgroundBrush(currentAstVisTheme().backgroundColor);
    view->setFrameShape(QFrame::NoFrame);
    layout->addWidget(view);

    page->setProperty("filePath", filePath);
    page->setProperty("sha256", QString());
    page->setProperty("scenePtr", QVariant::fromValue(reinterpret_cast<quintptr>(scene)));
    page->setProperty("viewPtr", QVariant::fromValue(reinterpret_cast<quintptr>(view)));

    const int tabIndex = m_tabs->addTab(page, QFileInfo(filePath).fileName());
    m_tabs->setCurrentIndex(tabIndex);
    renderFileInTab(tabIndex, filePath);
}

void MainWindow::closeFileTabForPath(const QString &filePath) {
    for (int index = m_tabs->count() - 1; index >= 0; index -= 1) {
        QWidget *page = m_tabs->widget(index);
        if (page && page->property("filePath").toString() == filePath) {
            closeTab(index);
            return;
        }
    }
}

bool MainWindow::isFileOpen(const QString &filePath) const {
    for (int index = 0; index < m_tabs->count(); index += 1) {
        QWidget *page = m_tabs->widget(index);
        if (page && page->property("filePath").toString() == filePath) {
            return true;
        }
    }
    return false;
}

void MainWindow::closeTab(int index) {
    QWidget *page = m_tabs->widget(index);
    m_tabs->removeTab(index);
    delete page;
}

void MainWindow::openFolder() {
    if (!m_rootDirectoryPath.isEmpty()) {
        return;
    }

    const QString folderPath = QFileDialog::getExistingDirectory(
        this,
        QStringLiteral("Open Folder"),
        m_folderHistory.isEmpty() ? QDir::currentPath() : m_folderHistory.first());
    if (folderPath.isEmpty()) {
        return;
    }
    setRootDirectory(folderPath);
}

void MainWindow::closeFolder() {
    if (m_rootDirectoryPath.isEmpty()) {
        return;
    }

    clearOpenTabs();
    m_rootDirectoryPath.clear();
    m_filePaths.clear();
    updateWindowTitle();
    updateFileMenu();
}

void MainWindow::showFileDialog() {
    if (m_rootDirectoryPath.isEmpty()) {
        return;
    }

    QDialog dialog(this);
    dialog.setWindowTitle(QStringLiteral("Select File"));
    dialog.setMinimumSize(MinFileDialogWidth, MinFileDialogHeight);

    QVBoxLayout *layout = new QVBoxLayout(&dialog);
    layout->setContentsMargins(8, 8, 8, 8);

    QListWidget *fileList = new QListWidget(&dialog);
    layout->addWidget(fileList);

    QDialogButtonBox *buttons = new QDialogButtonBox(QDialogButtonBox::Close, &dialog);
    layout->addWidget(buttons);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);

    QShortcut *closeShortcut = new QShortcut(QKeySequence(Qt::Key_F1), &dialog);
    connect(closeShortcut, &QShortcut::activated, &dialog, &QDialog::reject);

    std::function<void()> rebuildList;
    rebuildList = [this, fileList, &dialog, &rebuildList]() {
        const int scrollValue = fileList->verticalScrollBar()->value();
        fileList->clear();
        const QDir rootDir(m_rootDirectoryPath);
        const QFontMetrics listMetrics(fileList->font());
        int widestPathWidth = 0;
        int rowHeight = 28;
        for (const QString &filePath : m_filePaths) {
            const bool open = isFileOpen(filePath);
            QListWidgetItem *item = new QListWidgetItem(fileList);
            QWidget *row = new QWidget(fileList);
            QHBoxLayout *rowLayout = new QHBoxLayout(row);
            rowLayout->setContentsMargins(6, 3, 6, 3);
            rowLayout->setSpacing(8);

            QLabel *label = new QLabel(rootDir.relativeFilePath(filePath), row);
            label->setTextInteractionFlags(Qt::TextSelectableByMouse);
            QPushButton *button = new QPushButton(open ? QStringLiteral("Close Tab") : QStringLiteral("Open Tab"), row);
            if (open) {
                button->setStyleSheet(QStringLiteral("background-color: #16a34a; color: #ffffff;"));
            }
            button->setMinimumWidth(92);
            rowLayout->addWidget(label, 1);
            rowLayout->addWidget(button);

            item->setSizeHint(row->sizeHint());
            fileList->addItem(item);
            fileList->setItemWidget(item, row);
            widestPathWidth = std::max(widestPathWidth, listMetrics.horizontalAdvance(label->text()));
            rowHeight = std::max(rowHeight, item->sizeHint().height());

            connect(button, &QPushButton::clicked, &dialog, [this, filePath, &rebuildList]() {
                if (isFileOpen(filePath)) {
                    closeFileTabForPath(filePath);
                } else {
                    openFile(filePath);
                }
                rebuildList();
            });
        }

        const int contentWidth = widestPathWidth + 92 + 56 + fileList->verticalScrollBar()->sizeHint().width();
        const int contentHeight = (rowHeight * std::max(1, static_cast<int>(m_filePaths.size()))) + 82;
        dialog.resize(
            std::clamp(contentWidth, MinFileDialogWidth, MaxFileDialogWidth),
            std::clamp(contentHeight, MinFileDialogHeight, MaxFileDialogHeight));
        fileList->verticalScrollBar()->setValue(scrollValue);
    };

    rebuildList();
    dialog.exec();
}

void MainWindow::refreshFolder() {
    if (m_rootDirectoryPath.isEmpty()) {
        return;
    }
    if (!validateFolderFileLimit(m_rootDirectoryPath)) {
        return;
    }

    populateFileList();

    for (int index = m_tabs->count() - 1; index >= 0; index -= 1) {
        QWidget *page = m_tabs->widget(index);
        if (!page) {
            continue;
        }

        const QString filePath = page->property("filePath").toString();
        if (!validateOpenFile(filePath)) {
            closeTab(index);
            continue;
        }

        const QString currentSha256 = sha256ForFile(filePath);
        if (currentSha256.isEmpty()) {
            closeTab(index);
            continue;
        }
        if (currentSha256 != page->property("sha256").toString()) {
            renderFileInTab(index, filePath);
        }
    }
}

void MainWindow::showHelp() {
    QMessageBox::information(
        this,
        QStringLiteral("Help"),
        QStringLiteral(
            "Ironwall AST Visualizer opens an Ironwall source folder and renders .iw files as AST diagrams.\n\n"
            "Basic usage:\n"
            "- Use File > Open Folder to choose a project folder. Only one folder can be open at a time.\n"
            "- Use Folder > Select File or press F1 to open the file picker.\n"
            "- In the file picker, use Open Tab to render a file and Close Tab to close an open file tab.\n"
            "- Use Folder > Refresh to rescan the folder. Changed open files are re-rendered, and missing files are closed.\n"
            "- Use View to choose the theme, math font, and Orange Box display options.\n"
            "- Settings and recent folders are saved next to the application executable."));
}

void MainWindow::openRecentFolder() {
    if (!m_rootDirectoryPath.isEmpty()) {
        return;
    }

    QAction *action = qobject_cast<QAction *>(sender());
    if (!action) {
        return;
    }
    const QString folderPath = action->data().toString();
    if (folderPath.isEmpty()) {
        return;
    }
    if (!QDir(folderPath).exists()) {
        QMessageBox::warning(
            this,
            QStringLiteral("Folder Not Found"),
            QStringLiteral("The folder no longer exists:\n%1").arg(folderPath));
        m_folderHistory.removeAll(folderPath);
        saveFolderHistory();
        updateFileMenu();
        return;
    }
    setRootDirectory(folderPath);
}

void MainWindow::clearFolderHistory() {
    m_folderHistory.clear();
    saveFolderHistory();
    updateFileMenu();
}

void MainWindow::restoreDefaultSettings() {
    setCurrentAstVisTheme(lightAstVisTheme());
    setCurrentMathFontFamily(QString());
    setLiteralDisplayOptions(LiteralDisplayOptions{});
    updateSettingsActions();
    saveSettings();
    rerenderOpenTabs();
}

QString MainWindow::readUtf8File(const QString &filePath) const {
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error(QStringLiteral("Failed to open %1").arg(filePath).toStdString());
    }
    return QString::fromUtf8(file.readAll());
}

QString MainWindow::readUtf8FileWithSha256(const QString &filePath, QString *sha256Hex) const {
    const QFileInfo fileInfo(filePath);
    if (!fileInfo.exists() || !fileInfo.isFile()) {
        throw std::runtime_error(QStringLiteral("File does not exist: %1").arg(filePath).toStdString());
    }
    if (fileInfo.size() > MaxOpenFileBytes) {
        throw std::runtime_error(QStringLiteral("File exceeds the 100 KB limit: %1").arg(filePath).toStdString());
    }

    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        throw std::runtime_error(QStringLiteral("Failed to open %1").arg(filePath).toStdString());
    }

    const QByteArray bytes = file.readAll();
    if (sha256Hex) {
        *sha256Hex = QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
    }
    return QString::fromUtf8(bytes);
}

QString MainWindow::sha256ForFile(const QString &filePath) const {
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) {
        return QString();
    }
    QCryptographicHash hash(QCryptographicHash::Sha256);
    if (!hash.addData(&file)) {
        return QString();
    }
    return QString::fromLatin1(hash.result().toHex());
}

QHash<QString, QString> MainWindow::loadLiteralReferenceTexts(const iw::AstNodePtr &node) const {
    std::vector<std::shared_ptr<iw::TextDatabaseReferenceNode>> references;
    collectTextReferences(node, references);
    if (references.empty()) {
        return {};
    }

    const QString programPackageName = packageNameForProgram(node);
    QHash<QString, bool> needed;
    for (const std::shared_ptr<iw::TextDatabaseReferenceNode> &reference : references) {
        needed.insert(canonicalReferenceName(reference, programPackageName), true);
    }

    QHash<QString, QString> texts;
    QDirIterator iterator(
        m_rootDirectoryPath,
        QStringList{QStringLiteral("*$lit.json")},
        QDir::Files,
        QDirIterator::Subdirectories);
    while (iterator.hasNext()) {
        const QString dbPath = iterator.next();
        const QFileInfo dbInfo(dbPath);
        const QString stem = dbInfo.completeBaseName();
        const QString packageName = dbPackageNameFromStem(stem);
        if (packageName.isEmpty()) {
            continue;
        }

        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(readUtf8File(dbPath).toUtf8(), &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
            continue;
        }

        const QJsonObject object = document.object();
        for (auto entry = object.constBegin(); entry != object.constEnd(); ++entry) {
            if (!entry.value().isString()) {
                continue;
            }
            const QString canonicalName = QStringLiteral("%1$%2").arg(packageName, entry.key());
            if (needed.contains(canonicalName)) {
                texts.insert(canonicalName, entry.value().toString());
            }
        }
    }

    for (const std::shared_ptr<iw::TextDatabaseReferenceNode> &reference : references) {
        const QString canonicalName = canonicalReferenceName(reference, programPackageName);
        if (texts.contains(canonicalName)) {
            texts.insert(reference->referenceName(), texts.value(canonicalName));
        }
    }
    return texts;
}

void MainWindow::renderFileInTab(int tabIndex, const QString &filePath) {
    QWidget *page = m_tabs->widget(tabIndex);
    if (!page) {
        return;
    }

    QGraphicsScene *scene = reinterpret_cast<QGraphicsScene *>(page->property("scenePtr").value<quintptr>());
    QGraphicsView *view = reinterpret_cast<QGraphicsView *>(page->property("viewPtr").value<quintptr>());
    if (!scene || !view) {
        return;
    }

    try {
        QString sha256Hex;
        const QString sourceText = readUtf8FileWithSha256(filePath, &sha256Hex);
        page->setProperty("sha256", sha256Hex);
        const iw::AstNodePtr ast = iw::parseProgramSource(sourceText);
        const QHash<QString, QString> literalTexts = loadLiteralReferenceTexts(ast);
        setLiteralReferenceDisplayTexts(literalTexts);
        renderAst(scene, view, ast);
    } catch (const std::exception &error) {
        showParseError(scene, QString::fromUtf8(error.what()));
    }
}

void MainWindow::chooseMathFont() {
    const QStringList families = availableMathFontFamilies();
    if (families.isEmpty()) {
        QMessageBox::information(
            this,
            QStringLiteral("Choose Math Font"),
            QStringLiteral("No .ttf or .otf math fonts were found in the math-font directory."));
        return;
    }

    QDialog dialog(this);
    dialog.setWindowTitle(QStringLiteral("Choose Math Font"));
    QVBoxLayout *layout = new QVBoxLayout(&dialog);
    layout->setContentsMargins(8, 8, 8, 8);

    QListWidget *fontList = new QListWidget(&dialog);
    fontList->addItems(families);
    const QList<QListWidgetItem *> currentItems = fontList->findItems(currentMathFontFamily(), Qt::MatchExactly);
    if (!currentItems.isEmpty()) {
        fontList->setCurrentItem(currentItems.first());
    } else if (fontList->count() > 0) {
        fontList->setCurrentRow(0);
    }
    layout->addWidget(fontList);

    QDialogButtonBox *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
    layout->addWidget(buttons);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    connect(fontList, &QListWidget::itemDoubleClicked, &dialog, &QDialog::accept);

    if (dialog.exec() != QDialog::Accepted || fontList->currentItem() == nullptr) {
        return;
    }

    setCurrentMathFontFamily(fontList->currentItem()->text());
    saveSettings();
    rerenderOpenTabs();
}

void MainWindow::setLightTheme() {
    setCurrentAstVisTheme(lightAstVisTheme());
    saveSettings();
    rerenderOpenTabs();
}

void MainWindow::setDarkTheme() {
    setCurrentAstVisTheme(darkAstVisTheme());
    saveSettings();
    rerenderOpenTabs();
}

void MainWindow::chooseCustomTheme() {
    AstVisTheme theme = currentAstVisTheme();

    QDialog dialog(this);
    dialog.setWindowTitle(QStringLiteral("Custom Theme"));
    QVBoxLayout *outerLayout = new QVBoxLayout(&dialog);
    outerLayout->setContentsMargins(8, 8, 8, 8);

    QGridLayout *grid = new QGridLayout();
    outerLayout->addLayout(grid);

    struct ColorRow final {
        QString label;
        QColor *color;
    };
    std::vector<ColorRow> rows = {
        ColorRow{QStringLiteral("Background"), &theme.backgroundColor},
        ColorRow{QStringLiteral("Text"), &theme.textColor},
        ColorRow{QStringLiteral("Keyword"), &theme.keywordColor},
        ColorRow{QStringLiteral("Type"), &theme.typeColor},
        ColorRow{QStringLiteral("Number"), &theme.numberColor},
        ColorRow{QStringLiteral("Character / String"), &theme.stringColor},
        ColorRow{QStringLiteral("Logical Keyword"), &theme.logicalKeywordColor},
    };

    for (int row = 0; row < static_cast<int>(rows.size()); row += 1) {
        QLabel *label = new QLabel(rows.at(row).label, &dialog);
        QPushButton *button = new QPushButton(&dialog);
        updateColorButton(button, *rows.at(row).color);
        grid->addWidget(label, row, 0);
        grid->addWidget(button, row, 1);
        connect(button, &QPushButton::clicked, &dialog, [button, color = rows.at(row).color, this]() {
            const QColor selected = QColorDialog::getColor(*color, this, QStringLiteral("Choose Color"));
            if (!selected.isValid()) {
                return;
            }
            *color = selected;
            updateColorButton(button, selected);
        });
    }

    QDialogButtonBox *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
    outerLayout->addWidget(buttons);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);

    if (dialog.exec() != QDialog::Accepted) {
        return;
    }
    setCurrentAstVisTheme(theme);
    saveSettings();
    rerenderOpenTabs();
}

void MainWindow::updateLiteralDisplayOptions() {
    LiteralDisplayOptions options = literalDisplayOptions();
    options.showFullText = m_showFullLiteralsAction && m_showFullLiteralsAction->isChecked();
    options.renderControlCharacters = m_renderLiteralControlsAction && m_renderLiteralControlsAction->isChecked();
    options.showReferenceName = m_showLiteralReferencesAction && m_showLiteralReferencesAction->isChecked();
    options.truncateLength = 10;
    setLiteralDisplayOptions(options);
    saveSettings();
    rerenderOpenTabs();
}

void MainWindow::rerenderOpenTabs() {
    const int currentIndex = m_tabs->currentIndex();
    for (int index = 0; index < m_tabs->count(); index += 1) {
        const QString filePath = m_tabs->widget(index)->property("filePath").toString();
        if (!filePath.isEmpty()) {
            renderFileInTab(index, filePath);
        }
    }
    if (currentIndex >= 0 && currentIndex < m_tabs->count()) {
        m_tabs->setCurrentIndex(currentIndex);
    }
}

void MainWindow::updateWindowTitle() {
    if (m_rootDirectoryPath.isEmpty()) {
        setWindowTitle(QStringLiteral("Ironwall AST Visualizer"));
        return;
    }
    setWindowTitle(QStringLiteral("Ironwall AST Visualizer - %1").arg(m_rootDirectoryPath));
}

void MainWindow::updateFileMenu() {
    const bool hasOpenFolder = !m_rootDirectoryPath.isEmpty();
    if (m_openFolderAction) {
        m_openFolderAction->setEnabled(!hasOpenFolder);
    }
    if (m_closeFolderAction) {
        m_closeFolderAction->setEnabled(hasOpenFolder);
    }
    if (m_selectFileAction) {
        m_selectFileAction->setEnabled(hasOpenFolder);
    }
    if (m_refreshFolderAction) {
        m_refreshFolderAction->setEnabled(hasOpenFolder);
    }
    if (m_clearFolderHistoryAction) {
        m_clearFolderHistoryAction->setEnabled(!m_folderHistory.isEmpty());
    }
    if (!m_recentFoldersMenu) {
        return;
    }

    m_recentFoldersMenu->clear();
    for (const QString &folderPath : m_folderHistory) {
        QAction *action = m_recentFoldersMenu->addAction(folderPath);
        action->setData(folderPath);
        action->setEnabled(!hasOpenFolder);
        connect(action, &QAction::triggered, this, &MainWindow::openRecentFolder);
    }
    if (m_folderHistory.isEmpty()) {
        QAction *emptyAction = m_recentFoldersMenu->addAction(QStringLiteral("(No Recent Folders)"));
        emptyAction->setEnabled(false);
    }
    m_recentFoldersMenu->setEnabled(!hasOpenFolder && !m_folderHistory.isEmpty());
}

void MainWindow::loadFolderHistory() {
    m_folderHistory.clear();

    QFile file(folderHistoryFilePath());
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return;
    }

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return;
    }

    const QJsonArray folders = document.object().value(QStringLiteral("folders")).toArray();
    for (const QJsonValue &value : folders) {
        if (!value.isString()) {
            continue;
        }
        const QString folderPath = QDir(value.toString()).absolutePath();
        if (!m_folderHistory.contains(folderPath)) {
            m_folderHistory.append(folderPath);
        }
    }
}

void MainWindow::saveFolderHistory() const {
    QJsonArray folders;
    for (const QString &folderPath : m_folderHistory) {
        folders.append(folderPath);
    }

    QJsonObject object;
    object.insert(QStringLiteral("folders"), folders);

    QFile file(folderHistoryFilePath());
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate)) {
        return;
    }
    file.write(QJsonDocument(object).toJson(QJsonDocument::Indented));
}

void MainWindow::addFolderHistory(const QString &folderPath) {
    const QString absolutePath = QDir(folderPath).absolutePath();
    m_folderHistory.removeAll(absolutePath);
    m_folderHistory.prepend(absolutePath);
    saveFolderHistory();
    updateFileMenu();
}

QString MainWindow::folderHistoryFilePath() const {
    return QDir(QCoreApplication::applicationDirPath()).filePath(QStringLiteral("astvis-folder-history.json"));
}

void MainWindow::loadSettings() {
    QFile file(settingsFilePath());
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return;
    }

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return;
    }

    const QJsonObject root = document.object();
    AstVisTheme theme = currentAstVisTheme();
    const QJsonObject themeObject = root.value(QStringLiteral("theme")).toObject();
    applyColorValue(themeObject, QStringLiteral("background"), &theme.backgroundColor);
    applyColorValue(themeObject, QStringLiteral("text"), &theme.textColor);
    applyColorValue(themeObject, QStringLiteral("keyword"), &theme.keywordColor);
    applyColorValue(themeObject, QStringLiteral("type"), &theme.typeColor);
    applyColorValue(themeObject, QStringLiteral("number"), &theme.numberColor);
    applyColorValue(themeObject, QStringLiteral("string"), &theme.stringColor);
    applyColorValue(themeObject, QStringLiteral("logicalKeyword"), &theme.logicalKeywordColor);
    setCurrentAstVisTheme(theme);

    const QString mathFontFamily = root.value(QStringLiteral("mathFontFamily")).toString();
    if (!mathFontFamily.isEmpty()) {
        setCurrentMathFontFamily(mathFontFamily);
    }

    LiteralDisplayOptions options = literalDisplayOptions();
    const QJsonObject literalObject = root.value(QStringLiteral("orangeBox")).toObject();
    if (literalObject.contains(QStringLiteral("showFullText"))) {
        options.showFullText = literalObject.value(QStringLiteral("showFullText")).toBool(false);
    }
    if (literalObject.contains(QStringLiteral("renderControlCharacters"))) {
        options.renderControlCharacters = literalObject.value(QStringLiteral("renderControlCharacters")).toBool(false);
    }
    if (literalObject.contains(QStringLiteral("showReferenceName"))) {
        options.showReferenceName = literalObject.value(QStringLiteral("showReferenceName")).toBool(false);
    }
    options.truncateLength = 10;
    setLiteralDisplayOptions(options);
}

void MainWindow::saveSettings() const {
    const LiteralDisplayOptions options = literalDisplayOptions();

    QJsonObject literalObject;
    literalObject.insert(QStringLiteral("showFullText"), options.showFullText);
    literalObject.insert(QStringLiteral("renderControlCharacters"), options.renderControlCharacters);
    literalObject.insert(QStringLiteral("showReferenceName"), options.showReferenceName);
    literalObject.insert(QStringLiteral("truncateLength"), 10);

    QJsonObject root;
    root.insert(QStringLiteral("theme"), colorObject(currentAstVisTheme()));
    root.insert(QStringLiteral("orangeBox"), literalObject);
    root.insert(QStringLiteral("mathFontFamily"), currentMathFontFamily());

    QFile file(settingsFilePath());
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate)) {
        return;
    }
    file.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
}

void MainWindow::updateSettingsActions() {
    const LiteralDisplayOptions options = literalDisplayOptions();
    if (m_showFullLiteralsAction) {
        m_showFullLiteralsAction->setChecked(options.showFullText);
    }
    if (m_renderLiteralControlsAction) {
        m_renderLiteralControlsAction->setChecked(options.renderControlCharacters);
    }
    if (m_showLiteralReferencesAction) {
        m_showLiteralReferencesAction->setChecked(options.showReferenceName);
    }
}

QString MainWindow::settingsFilePath() const {
    return QDir(QCoreApplication::applicationDirPath()).filePath(QStringLiteral("settings.json"));
}

void MainWindow::renderAst(QGraphicsScene *scene, QGraphicsView *view, const iw::AstNodePtr &node) {
    scene->clear();
    view->setBackgroundBrush(currentAstVisTheme().backgroundColor);

    AstGraphicsItem *rootItem = createAstGraphicsItem(node);
    rootItem->setPos(0.0, 0.0);
    scene->addItem(rootItem);

    const QRectF sceneBounds = scene->itemsBoundingRect().adjusted(-12.0, -12.0, 12.0, 12.0);
    scene->setSceneRect(sceneBounds);
    view->horizontalScrollBar()->setValue(view->horizontalScrollBar()->minimum());
    view->verticalScrollBar()->setValue(view->verticalScrollBar()->minimum());
}

void MainWindow::showParseError(QGraphicsScene *scene, const QString &message) {
    scene->clear();
    QGraphicsTextItem *errorText = scene->addText(QStringLiteral("Render failed:\n%1").arg(message));
    errorText->setDefaultTextColor(QColor(164, 36, 36));
    errorText->setPos(0.0, 0.0);
    scene->setSceneRect(scene->itemsBoundingRect());
}
