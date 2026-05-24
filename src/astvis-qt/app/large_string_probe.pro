QT += widgets
CONFIG += c++20 warn_on
TEMPLATE = app
TARGET = astvis-large-string-probe

IRONWALL_READER_BUILD_ROOT = $$clean_path($$PWD/../../../build-ironwall-reader)
IRONWALL_READER_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$IRONWALL_READER_BUILD_ROOT/bin
OBJECTS_DIR = $$IRONWALL_READER_BUILD_ROOT/large-string-probe/obj
MOC_DIR = $$IRONWALL_READER_BUILD_ROOT/large-string-probe/moc
RCC_DIR = $$IRONWALL_READER_BUILD_ROOT/large-string-probe/rcc
UI_DIR = $$IRONWALL_READER_BUILD_ROOT/large-string-probe/ui

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$IRONWALL_READER_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

INCLUDEPATH += ../core

HEADERS += \
    ../core/iwast.h \
    astgraphicsitems.h

SOURCES += \
    astgraphicsitems.cpp \
    large_string_probe.cpp
