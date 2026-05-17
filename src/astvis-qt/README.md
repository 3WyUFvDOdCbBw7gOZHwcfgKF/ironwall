# astvis-qt

Qt Widgets project for visualizing a useful subset of the Ironwall AST.

Current scope:

- Lexer parity for the current Ironwall token surface, including dotted member-chain sugar.
- Parser support for pass-1 bracket trees plus the subset needed by the current member-chain formatter tests.
- A small formatter that round-trips the currently covered subset.
- A Qt Widgets viewer that parses source text and renders the AST as a tree.
- QtTest coverage that ports the existing member-chain regression cases and adds a parser structure regression.

Build:

```bash
cd /home/blackcat/dev/ironwall/src/astvis-qt
/home/blackcat/Qt/6.11.0/gcc_64/bin/qmake astvis-qt.pro
make
```

Run the viewer:

```bash
cd /home/blackcat/dev/ironwall/src/astvis-qt
../../build-astvis-qt/bin/astvis-qt
```

Run the tests:

```bash
cd /home/blackcat/dev/ironwall/src/astvis-qt
../../build-astvis-qt/bin/tst_iwcore
```
