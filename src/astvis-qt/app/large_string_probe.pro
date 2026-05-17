QT += widgets
CONFIG += c++20 warn_on
TEMPLATE = app
TARGET = astvis-large-string-probe

ASTVIS_BUILD_ROOT = $$clean_path($$PWD/../../../build-astvis-qt)
ASTVIS_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$ASTVIS_BUILD_ROOT/bin
OBJECTS_DIR = $$ASTVIS_BUILD_ROOT/large-string-probe/obj
MOC_DIR = $$ASTVIS_BUILD_ROOT/large-string-probe/moc
RCC_DIR = $$ASTVIS_BUILD_ROOT/large-string-probe/rcc
UI_DIR = $$ASTVIS_BUILD_ROOT/large-string-probe/ui

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$ASTVIS_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

INCLUDEPATH += ../core

HEADERS += \
    ../core/iwast.h \
    astgraphicsitems.h

SOURCES += \
    astgraphicsitems.cpp \
    large_string_probe.cpp
