// Qt Widgets entry point for the Ironwall AST viewer.
#include <QApplication>

#include "mainwindow.h"

int main(int argc, char *argv[]) {
    QApplication app(argc, argv);
    const QString rootDirectoryPath = app.arguments().size() > 1
        ? app.arguments().at(1)
        : QString();
    MainWindow window(rootDirectoryPath);
    window.show();
    return app.exec();
}
