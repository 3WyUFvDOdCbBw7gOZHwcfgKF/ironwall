QT += widgets
CONFIG += c++20 warn_on
TEMPLATE = app
TARGET = astvis-qt

ASTVIS_BUILD_ROOT = $$clean_path($$PWD/../../../build-astvis-qt)
ASTVIS_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$ASTVIS_BUILD_ROOT/bin
OBJECTS_DIR = $$ASTVIS_BUILD_ROOT/app/obj
MOC_DIR = $$ASTVIS_BUILD_ROOT/app/moc
RCC_DIR = $$ASTVIS_BUILD_ROOT/app/rcc
UI_DIR = $$ASTVIS_BUILD_ROOT/app/ui

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$ASTVIS_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

INCLUDEPATH += ../core

HEADERS += \
    ../core/iwast.h \
    ../core/iwformatter.h \
    ../core/iwlexer.h \
    ../core/iwparser.h \
    ../core/iwtoken.h \
    astgraphicsitems.h \
    mainwindow.h

SOURCES += \
    ../core/iwformatter.cpp \
    ../core/iwlexer.cpp \
    ../core/iwparser.cpp \
    astgraphicsitems.cpp \
    main.cpp \
    mainwindow.cpp
