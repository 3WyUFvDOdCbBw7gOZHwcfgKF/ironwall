QT += widgets
CONFIG += c++20 warn_on
TEMPLATE = app
TARGET = ironwall-reader

IRONWALL_READER_BUILD_ROOT = $$clean_path($$PWD/../../../build-ironwall-reader)
IRONWALL_READER_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$IRONWALL_READER_BUILD_ROOT/bin
OBJECTS_DIR = $$IRONWALL_READER_BUILD_ROOT/app/obj
MOC_DIR = $$IRONWALL_READER_BUILD_ROOT/app/moc
RCC_DIR = $$IRONWALL_READER_BUILD_ROOT/app/rcc
UI_DIR = $$IRONWALL_READER_BUILD_ROOT/app/ui

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$IRONWALL_READER_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

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
