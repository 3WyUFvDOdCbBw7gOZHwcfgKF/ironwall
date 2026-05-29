QT += core gui widgets testlib
CONFIG += c++20 testcase console warn_on
TEMPLATE = app
TARGET = tst_iwcore

IRONWALL_READER_BUILD_ROOT = $$clean_path($$PWD/../../../build-ironwall-reader)
IRONWALL_READER_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$IRONWALL_READER_BUILD_ROOT/bin
OBJECTS_DIR = $$IRONWALL_READER_BUILD_ROOT/tests/obj
MOC_DIR = $$IRONWALL_READER_BUILD_ROOT/tests/moc
RCC_DIR = $$IRONWALL_READER_BUILD_ROOT/tests/rcc
UI_DIR = $$IRONWALL_READER_BUILD_ROOT/tests/ui

IRONWALL_READER_BUILD_DIRS = \
    $$DESTDIR \
    $$OBJECTS_DIR \
    $$MOC_DIR \
    $$RCC_DIR \
    $$UI_DIR

for(build_dir, IRONWALL_READER_BUILD_DIRS): !mkpath($$build_dir): error("Failed to create build directory: $$build_dir")

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$IRONWALL_READER_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

INCLUDEPATH += ../core ../app

HEADERS += \
    ../app/astgraphicsitems.h \
    ../core/iwast.h \
    ../core/iwformatter.h \
    ../core/iwlexer.h \
    ../core/iwparser.h \
    ../core/iwtoken.h

SOURCES += \
    ../app/astgraphicsitems.cpp \
    ../core/iwformatter.cpp \
    ../core/iwlexer.cpp \
    ../core/iwparser.cpp \
    tst_iwcore.cpp
