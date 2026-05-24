TEMPLATE = subdirs
CONFIG += ordered

SUBDIRS += \
    app \
    tool \
    tests

app.file = app/app.pro
tool.file = tool/tool.pro
tests.file = tests/tests.pro
