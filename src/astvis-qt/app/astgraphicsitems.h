// GraphicsView-based AST items for the Ironwall AST visualizer.
#ifndef IW_ASTVIS_QT_APP_ASTGRAPHICSITEMS_H
#define IW_ASTVIS_QT_APP_ASTGRAPHICSITEMS_H

#include <QColor>
#include <QGraphicsObject>
#include <QHash>
#include <QPointF>
#include <QStringList>

#include "iwast.h"

class QPainter;
class QStyleOptionGraphicsItem;
class QWidget;

class AstGraphicsItem : public QGraphicsObject {
public:
    explicit AstGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr);
    ~AstGraphicsItem() override = default;

    const iw::AstNodePtr &node() const;
    QRectF boundingRect() const override;
    virtual void refreshLayout();
    virtual QPointF connectionAnchor() const;
    virtual QPointF exitAnchor() const;

protected:
    const QString &labelText() const;
    const QColor &accentColor() const;
    void setBounds(const QRectF &bounds);

    static bool isTrivialNodeType(iw::AstNodeType nodeType);
    static QString displayTextForNode(const iw::AstNodePtr &node);

private:
    iw::AstNodePtr m_node;
    QRectF m_bounds;
    QString m_labelText;
    QColor m_accentColor;
};

AstGraphicsItem *createAstGraphicsItem(const iw::AstNodePtr &node, QGraphicsItem *parent = nullptr);

struct AstVisTheme final {
    QColor backgroundColor;
    QColor textColor;
    QColor keywordColor;
    QColor typeColor;
    QColor numberColor;
    QColor stringColor;
    QColor logicalKeywordColor;
};

struct LiteralDisplayOptions final {
    bool showFullText = false;
    bool renderControlCharacters = false;
    bool showReferenceName = false;
    qsizetype truncateLength = 10;
};

AstVisTheme lightAstVisTheme();
AstVisTheme darkAstVisTheme();
AstVisTheme currentAstVisTheme();
void setCurrentAstVisTheme(const AstVisTheme &theme);
QStringList availableMathFontFamilies();
QString currentMathFontFamily();
void setCurrentMathFontFamily(const QString &family);
void setLiteralReferenceDisplayTexts(const QHash<QString, QString> &texts);
LiteralDisplayOptions literalDisplayOptions();
void setLiteralDisplayOptions(const LiteralDisplayOptions &options);
QString astvisExpressionPreviewForTest(const iw::AstNodePtr &node);

#endif
