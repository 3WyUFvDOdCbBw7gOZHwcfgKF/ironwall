// Qt Widgets front-end for the Ironwall AST viewer.
#ifndef IW_ASTVIS_QT_APP_MAINWINDOW_H
#define IW_ASTVIS_QT_APP_MAINWINDOW_H

#include <QMainWindow>
#include <QHash>
#include <QStringList>

#include "iwast.h"

class QGraphicsScene;
class QGraphicsView;
class QListWidget;
class QAction;
class QMenu;
class QTabWidget;

class MainWindow final : public QMainWindow {
    Q_OBJECT

public:
    explicit MainWindow(const QString &rootDirectoryPath, QWidget *parent = nullptr);

private slots:
    void closeTab(int index);
    void chooseMathFont();
    void openFolder();
    void closeFolder();
    void showFileDialog();
    void refreshFolder();
    void showHelp();
    void openRecentFolder();
    void clearFolderHistory();
    void restoreDefaultSettings();
    void setLightTheme();
    void setDarkTheme();
    void chooseCustomTheme();
    void updateLiteralDisplayOptions();

private:
    void setRootDirectory(const QString &rootDirectoryPath);
    void clearOpenTabs();
    bool validateFolderFileLimit(const QString &folderPath);
    bool validateOpenFile(const QString &filePath);
    void populateFileList();
    void openFile(const QString &filePath);
    void closeFileTabForPath(const QString &filePath);
    bool isFileOpen(const QString &filePath) const;
    void renderFileInTab(int tabIndex, const QString &filePath);
    void renderAst(QGraphicsScene *scene, QGraphicsView *view, const iw::AstNodePtr &node);
    void rerenderOpenTabs();
    void updateWindowTitle();
    void updateFileMenu();
    void loadFolderHistory();
    void saveFolderHistory() const;
    void addFolderHistory(const QString &folderPath);
    QString folderHistoryFilePath() const;
    void loadSettings();
    void saveSettings() const;
    void updateSettingsActions();
    QString settingsFilePath() const;
    void showParseError(QGraphicsScene *scene, const QString &message);
    QHash<QString, QString> loadLiteralReferenceTexts(const iw::AstNodePtr &node) const;
    QString readUtf8File(const QString &filePath) const;
    QString readUtf8FileWithSha256(const QString &filePath, QString *sha256Hex) const;
    QString sha256ForFile(const QString &filePath) const;

    QString m_rootDirectoryPath;
    QStringList m_folderHistory;
    QStringList m_filePaths;
    QTabWidget *m_tabs;
    QMenu *m_fileMenu = nullptr;
    QMenu *m_folderMenu = nullptr;
    QMenu *m_recentFoldersMenu = nullptr;
    QAction *m_openFolderAction = nullptr;
    QAction *m_closeFolderAction = nullptr;
    QAction *m_selectFileAction = nullptr;
    QAction *m_refreshFolderAction = nullptr;
    QAction *m_clearFolderHistoryAction = nullptr;
    QAction *m_restoreDefaultSettingsAction = nullptr;
    QAction *m_showFullLiteralsAction = nullptr;
    QAction *m_renderLiteralControlsAction = nullptr;
    QAction *m_showLiteralReferencesAction = nullptr;
};

#endif
