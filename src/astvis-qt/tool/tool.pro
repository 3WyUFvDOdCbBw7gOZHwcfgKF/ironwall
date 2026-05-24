QT += core
CONFIG += c++20 console warn_on
TEMPLATE = app
TARGET = iw-frontend-json

IRONWALL_READER_BUILD_ROOT = $$clean_path($$PWD/../../../build-ironwall-reader)
IRONWALL_READER_ASSETS_ROOT = $$clean_path($$PWD/../../../assets)

DESTDIR = $$IRONWALL_READER_BUILD_ROOT/bin
OBJECTS_DIR = $$IRONWALL_READER_BUILD_ROOT/tool/obj
MOC_DIR = $$IRONWALL_READER_BUILD_ROOT/tool/moc
RCC_DIR = $$IRONWALL_READER_BUILD_ROOT/tool/rcc
UI_DIR = $$IRONWALL_READER_BUILD_ROOT/tool/ui

QMAKE_POST_LINK += $$escape_expand(\\n\\t)$(COPY_DIR) $$shell_path($$IRONWALL_READER_ASSETS_ROOT/math-font) $$shell_path($$DESTDIR/math-font)

INCLUDEPATH += ../core

HEADERS += \
    ../core/iwast.h \
    ../core/iwfrontendjson.h \
    ../core/iwlexer.h \
    ../core/iwparser.h \
    ../core/iwtoken.h

SOURCES += \
    ../core/iwfrontendjson.cpp \
    ../core/iwlexer.cpp \
    ../core/iwparser.cpp \
    main.cpp
