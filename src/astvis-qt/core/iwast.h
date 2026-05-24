// Qt AST viewer core: AST node model for the covered Ironwall subset.
#ifndef IW_ASTVIS_QT_CORE_IWAST_H
#define IW_ASTVIS_QT_CORE_IWAST_H

#include <memory>
#include <vector>

#include <QString>

#include "iwtoken.h"

namespace iw {

enum class AstNodeType {
    IdentifierNode,
    TextDatabaseReferenceNode,
    NumberLiteralNode,
    ListNode,
    AngleParenListNode,
    SquareParenListNode,
    CurlyParenListNode,
    RoundParenListNode,
    FnNode,
    LetNode,
    IfNode,
    WhileNode,
    CondNode,
    TypeVarBindNode,
    TypeToFromNode,
    TypeUnionNode,
    ProgramNode,
    ImportNode,
    ExportNode,
    PublicNode,
    DvarNode,
    DfunNode,
    DeclaredDfunNode,
    SetNode,
    SeqNode,
    ClassNode,
    ClassPropertyNode,
    ClassMethodNode,
    ClassConstructorNode,
    GenericNameNode,
    GenericClassNode,
    GenericDfunNode,
    FunctionCallNode,
    GenericCallNode,
    MatchNode,
};

class AstNode;
class IdentifierNode;
class TypeVarBindNode;
class ProgramNode;
class PublicNode;
class ClassConstructorNode;
class ClassMethodNode;
class ClassPropertyNode;
class GenericNameNode;

using AstNodePtr = std::shared_ptr<AstNode>;
using AstNodeList = std::vector<AstNodePtr>;
using IdentifierNodePtr = std::shared_ptr<IdentifierNode>;
using TypeVarBindNodePtr = std::shared_ptr<TypeVarBindNode>;
using PublicNodePtr = std::shared_ptr<PublicNode>;
using ClassConstructorNodePtr = std::shared_ptr<ClassConstructorNode>;
using ClassMethodNodePtr = std::shared_ptr<ClassMethodNode>;
using ClassPropertyNodePtr = std::shared_ptr<ClassPropertyNode>;
using GenericNameNodePtr = std::shared_ptr<GenericNameNode>;

struct LetBinding final {
    AstNodePtr bind;
    AstNodePtr value;
};

struct CondClause final {
    AstNodePtr cond;
    AstNodePtr body;
};

struct MatchBranch final {
    TypeVarBindNodePtr bind;
    AstNodePtr body;
};

class AstNode {
public:
    explicit AstNode(AstNodeType type)
        : m_type(type) {
    }

    virtual ~AstNode() = default;

    AstNodeType type() const {
        return m_type;
    }

    virtual AstNodeList childNodes() const {
        return AstNodeList();
    }

    virtual QString summaryText() const = 0;

private:
    AstNodeType m_type;
};

class IdentifierNode final : public AstNode {
public:
    explicit IdentifierNode(const QString &name)
        : AstNode(AstNodeType::IdentifierNode),
          m_name(name) {
    }

    const QString &name() const {
        return m_name;
    }

    QString summaryText() const override {
        return QStringLiteral("Identifier(%1)").arg(m_name);
    }

private:
    QString m_name;
};

class TextDatabaseReferenceNode final : public AstNode {
public:
    TextDatabaseReferenceNode(const QString &typeName, const QString &entryName, const QString &referenceName)
        : AstNode(AstNodeType::TextDatabaseReferenceNode),
          m_typeName(typeName),
          m_entryName(entryName),
          m_referenceName(referenceName) {
    }

    const QString &typeName() const {
        return m_typeName;
    }

    const QString &entryName() const {
        return m_entryName;
    }

    const QString &referenceName() const {
        return m_referenceName;
    }

    QString summaryText() const override {
        return QStringLiteral("TextDatabaseReference(%1)").arg(m_referenceName);
    }

private:
    QString m_typeName;
    QString m_entryName;
    QString m_referenceName;
};

class NumberLiteralNode final : public AstNode {
public:
    NumberLiteralNode(const QString &typeName, const NumericLiteralValue &value, const QString &raw)
        : AstNode(AstNodeType::NumberLiteralNode),
          m_typeName(typeName),
          m_value(value),
          m_raw(raw) {
    }

    const QString &typeName() const {
        return m_typeName;
    }

    const NumericLiteralValue &value() const {
        return m_value;
    }

    const QString &raw() const {
        return m_raw;
    }

    QString summaryText() const override {
        return QStringLiteral("Number(%1)").arg(m_raw);
    }

private:
    QString m_typeName;
    NumericLiteralValue m_value;
    QString m_raw;
};

class ListNodeBase : public AstNode {
public:
    ListNodeBase(AstNodeType type, const AstNodeList &elements)
        : AstNode(type),
          m_elements(elements) {
    }

    const AstNodeList &elements() const {
        return m_elements;
    }

    AstNodeList childNodes() const override {
        return m_elements;
    }

private:
    AstNodeList m_elements;
};

class RoundParenListNode final : public ListNodeBase {
public:
    explicit RoundParenListNode(const AstNodeList &elements)
        : ListNodeBase(AstNodeType::RoundParenListNode, elements) {
    }

    QString summaryText() const override {
        return QStringLiteral("RoundList");
    }
};

class SquareParenListNode final : public ListNodeBase {
public:
    explicit SquareParenListNode(const AstNodeList &elements)
        : ListNodeBase(AstNodeType::SquareParenListNode, elements) {
    }

    QString summaryText() const override {
        return QStringLiteral("SquareList");
    }
};

class CurlyParenListNode final : public ListNodeBase {
public:
    explicit CurlyParenListNode(const AstNodeList &elements)
        : ListNodeBase(AstNodeType::CurlyParenListNode, elements) {
    }

    QString summaryText() const override {
        return QStringLiteral("CurlyList");
    }
};

class AngleParenListNode final : public ListNodeBase {
public:
    explicit AngleParenListNode(const AstNodeList &elements)
        : ListNodeBase(AstNodeType::AngleParenListNode, elements) {
    }

    QString summaryText() const override {
        return QStringLiteral("AngleList");
    }
};

class ListNode final : public ListNodeBase {
public:
    explicit ListNode(const AstNodeList &elements)
        : ListNodeBase(AstNodeType::ListNode, elements) {
    }

    QString summaryText() const override {
        return QStringLiteral("List");
    }
};

class TypeVarBindNode final : public AstNode {
public:
    TypeVarBindNode(const IdentifierNodePtr &identifier, const AstNodePtr &typeExpression)
        : AstNode(AstNodeType::TypeVarBindNode),
          m_identifier(identifier),
          m_typeExpression(typeExpression) {
    }

    const IdentifierNodePtr &identifier() const {
        return m_identifier;
    }

    const AstNodePtr &typeExpression() const {
        return m_typeExpression;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_identifier, m_typeExpression};
    }

    QString summaryText() const override {
        return QStringLiteral("Bind(%1)").arg(m_identifier->name());
    }

private:
    IdentifierNodePtr m_identifier;
    AstNodePtr m_typeExpression;
};

class TypeToFromNode final : public AstNode {
public:
    TypeToFromNode(const AstNodePtr &returnType, const AstNodeList &paramTypes)
        : AstNode(AstNodeType::TypeToFromNode),
          m_returnType(returnType),
          m_paramTypes(paramTypes) {
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    const AstNodeList &paramTypes() const {
        return m_paramTypes;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_returnType);
        for (const AstNodePtr &paramType : m_paramTypes) {
            nodes.push_back(paramType);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("TypeToFrom");
    }

private:
    AstNodePtr m_returnType;
    AstNodeList m_paramTypes;
};

class TypeUnionNode final : public AstNode {
public:
    explicit TypeUnionNode(const AstNodeList &types)
        : AstNode(AstNodeType::TypeUnionNode),
          m_types(types) {
    }

    const AstNodeList &types() const {
        return m_types;
    }

    AstNodeList childNodes() const override {
        return m_types;
    }

    QString summaryText() const override {
        return QStringLiteral("TypeUnion");
    }

private:
    AstNodeList m_types;
};

class FnNode final : public AstNode {
public:
    FnNode(const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &returnType, const AstNodePtr &body)
        : AstNode(AstNodeType::FnNode),
          m_params(params),
          m_returnType(returnType),
          m_body(body) {
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_returnType);
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Fn");
    }

private:
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_returnType;
    AstNodePtr m_body;
};

class LetNode final : public AstNode {
public:
    LetNode(const std::vector<LetBinding> &bindings, const AstNodePtr &body)
        : AstNode(AstNodeType::LetNode),
          m_bindings(bindings),
          m_body(body) {
    }

    const std::vector<LetBinding> &bindings() const {
        return m_bindings;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const LetBinding &binding : m_bindings) {
            nodes.push_back(binding.bind);
            nodes.push_back(binding.value);
        }
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Let");
    }

private:
    std::vector<LetBinding> m_bindings;
    AstNodePtr m_body;
};

class IfNode final : public AstNode {
public:
    IfNode(const AstNodePtr &condExpr, const AstNodePtr &trueBranchExpr, const AstNodePtr &falseBranchExpr)
        : AstNode(AstNodeType::IfNode),
          m_condExpr(condExpr),
          m_trueBranchExpr(trueBranchExpr),
          m_falseBranchExpr(falseBranchExpr) {
    }

    const AstNodePtr &condExpr() const {
        return m_condExpr;
    }

    const AstNodePtr &trueBranchExpr() const {
        return m_trueBranchExpr;
    }

    const AstNodePtr &falseBranchExpr() const {
        return m_falseBranchExpr;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_condExpr, m_trueBranchExpr, m_falseBranchExpr};
    }

    QString summaryText() const override {
        return QStringLiteral("If");
    }

private:
    AstNodePtr m_condExpr;
    AstNodePtr m_trueBranchExpr;
    AstNodePtr m_falseBranchExpr;
};

class WhileNode final : public AstNode {
public:
    WhileNode(const AstNodePtr &condExpr, const AstNodePtr &bodyExpr)
        : AstNode(AstNodeType::WhileNode),
          m_condExpr(condExpr),
          m_bodyExpr(bodyExpr) {
    }

    const AstNodePtr &condExpr() const {
        return m_condExpr;
    }

    const AstNodePtr &bodyExpr() const {
        return m_bodyExpr;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_condExpr, m_bodyExpr};
    }

    QString summaryText() const override {
        return QStringLiteral("While");
    }

private:
    AstNodePtr m_condExpr;
    AstNodePtr m_bodyExpr;
};

class CondNode final : public AstNode {
public:
    explicit CondNode(const std::vector<CondClause> &clauses)
        : AstNode(AstNodeType::CondNode),
          m_clauses(clauses) {
    }

    const std::vector<CondClause> &clauses() const {
        return m_clauses;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const CondClause &clause : m_clauses) {
            nodes.push_back(clause.cond);
            nodes.push_back(clause.body);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Cond");
    }

private:
    std::vector<CondClause> m_clauses;
};

class ProgramNode final : public AstNode {
public:
    ProgramNode(const IdentifierNodePtr &unitId, const AstNodeList &topLevelExpressions)
        : AstNode(AstNodeType::ProgramNode),
          m_unitId(unitId),
          m_topLevelExpressions(topLevelExpressions) {
    }

    const IdentifierNodePtr &unitId() const {
        return m_unitId;
    }

    const AstNodeList &topLevelExpressions() const {
        return m_topLevelExpressions;
    }

    AstNodeList childNodes() const override {
        return m_topLevelExpressions;
    }

    QString summaryText() const override {
        if (!m_unitId) {
            return QStringLiteral("Program");
        }
        return QStringLiteral("Program(%1)").arg(m_unitId->name());
    }

private:
    IdentifierNodePtr m_unitId;
    AstNodeList m_topLevelExpressions;
};

class ImportNode final : public AstNode {
public:
    explicit ImportNode(const IdentifierNodePtr &packagePath)
        : AstNode(AstNodeType::ImportNode),
          m_packagePath(packagePath) {
    }

    const IdentifierNodePtr &packagePath() const {
        return m_packagePath;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_packagePath};
    }

    QString summaryText() const override {
        return QStringLiteral("Import(%1)").arg(m_packagePath->name());
    }

private:
    IdentifierNodePtr m_packagePath;
};

class ExportNode final : public AstNode {
public:
    explicit ExportNode(const AstNodePtr &inner)
        : AstNode(AstNodeType::ExportNode),
          m_inner(inner) {
    }

    const AstNodePtr &inner() const {
        return m_inner;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_inner};
    }

    QString summaryText() const override {
        return QStringLiteral("Export");
    }

private:
    AstNodePtr m_inner;
};

class PublicNode final : public AstNode {
public:
    explicit PublicNode(const AstNodePtr &inner)
        : AstNode(AstNodeType::PublicNode),
          m_inner(inner) {
    }

    const AstNodePtr &inner() const {
        return m_inner;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_inner};
    }

    QString summaryText() const override {
        return QStringLiteral("Public");
    }

private:
    AstNodePtr m_inner;
};

class SeqNode final : public AstNode {
public:
    explicit SeqNode(const AstNodeList &expressions)
        : AstNode(AstNodeType::SeqNode),
          m_expressions(expressions) {
    }

    const AstNodeList &expressions() const {
        return m_expressions;
    }

    AstNodeList childNodes() const override {
        return m_expressions;
    }

    QString summaryText() const override {
        return QStringLiteral("Block");
    }

private:
    AstNodeList m_expressions;
};

class DvarNode final : public AstNode {
public:
    DvarNode(const AstNodePtr &bind, const AstNodePtr &value)
        : AstNode(AstNodeType::DvarNode),
          m_bind(bind),
          m_value(value) {
    }

    const AstNodePtr &bind() const {
        return m_bind;
    }

    const AstNodePtr &value() const {
        return m_value;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_bind, m_value};
    }

    QString summaryText() const override {
        return QStringLiteral("Var");
    }

private:
    AstNodePtr m_bind;
    AstNodePtr m_value;
};

class DfunNode final : public AstNode {
public:
    DfunNode(const IdentifierNodePtr &name, const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &returnType, const AstNodePtr &body)
        : AstNode(AstNodeType::DfunNode),
          m_name(name),
          m_params(params),
          m_returnType(returnType),
          m_body(body) {
    }

    const IdentifierNodePtr &name() const {
        return m_name;
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_returnType);
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Function(%1)").arg(m_name->name());
    }

private:
    IdentifierNodePtr m_name;
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_returnType;
    AstNodePtr m_body;
};

class DeclaredDfunNode final : public AstNode {
public:
    DeclaredDfunNode(const IdentifierNodePtr &name, const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &returnType)
        : AstNode(AstNodeType::DeclaredDfunNode),
          m_name(name),
          m_params(params),
          m_returnType(returnType) {
    }

    const IdentifierNodePtr &name() const {
        return m_name;
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_returnType);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("DeclaredFunction(%1)").arg(m_name->name());
    }

private:
    IdentifierNodePtr m_name;
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_returnType;
};

class SetNode final : public AstNode {
public:
    SetNode(const IdentifierNodePtr &identifier, const AstNodePtr &value)
        : AstNode(AstNodeType::SetNode),
          m_identifier(identifier),
          m_value(value) {
    }

    const IdentifierNodePtr &identifier() const {
        return m_identifier;
    }

    const AstNodePtr &value() const {
        return m_value;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_identifier, m_value};
    }

    QString summaryText() const override {
        return QStringLiteral("Set(%1)").arg(m_identifier->name());
    }

private:
    IdentifierNodePtr m_identifier;
    AstNodePtr m_value;
};

class ClassPropertyNode final : public AstNode {
public:
    explicit ClassPropertyNode(const TypeVarBindNodePtr &bind)
        : AstNode(AstNodeType::ClassPropertyNode),
          m_bind(bind) {
    }

    const TypeVarBindNodePtr &bind() const {
        return m_bind;
    }

    AstNodeList childNodes() const override {
        return AstNodeList{m_bind};
    }

    QString summaryText() const override {
        return QStringLiteral("Property");
    }

private:
    TypeVarBindNodePtr m_bind;
};

class ClassMethodNode final : public AstNode {
public:
    ClassMethodNode(const IdentifierNodePtr &methodName, const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &returnType, const AstNodePtr &body)
        : AstNode(AstNodeType::ClassMethodNode),
          m_methodName(methodName),
          m_params(params),
          m_returnType(returnType),
          m_body(body) {
    }

    const IdentifierNodePtr &methodName() const {
        return m_methodName;
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_methodName);
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_returnType);
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Method(%1)").arg(m_methodName->name());
    }

private:
    IdentifierNodePtr m_methodName;
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_returnType;
    AstNodePtr m_body;
};

class ClassConstructorNode final : public AstNode {
public:
    ClassConstructorNode(const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &body)
        : AstNode(AstNodeType::ClassConstructorNode),
          m_params(params),
          m_body(body) {
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Constructor");
    }

private:
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_body;
};

class ClassNode final : public AstNode {
public:
    ClassNode(const IdentifierNodePtr &name, const std::vector<ClassConstructorNodePtr> &constructorNodeList, const std::vector<ClassMethodNodePtr> &methodNodeList, const std::vector<ClassPropertyNodePtr> &propertyNodeList, const AstNodeList &memberNodeList)
        : AstNode(AstNodeType::ClassNode),
          m_name(name),
          m_constructorNodeList(constructorNodeList),
          m_methodNodeList(methodNodeList),
          m_propertyNodeList(propertyNodeList),
          m_memberNodeList(memberNodeList) {
    }

    const IdentifierNodePtr &name() const {
        return m_name;
    }

    const std::vector<ClassConstructorNodePtr> &constructorNodeList() const {
        return m_constructorNodeList;
    }

    const std::vector<ClassMethodNodePtr> &methodNodeList() const {
        return m_methodNodeList;
    }

    const std::vector<ClassPropertyNodePtr> &propertyNodeList() const {
        return m_propertyNodeList;
    }

    const AstNodeList &memberNodeList() const {
        return m_memberNodeList;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_name);
        for (const AstNodePtr &memberNode : m_memberNodeList) {
            nodes.push_back(memberNode);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Class(%1)").arg(m_name->name());
    }

private:
    IdentifierNodePtr m_name;
    std::vector<ClassConstructorNodePtr> m_constructorNodeList;
    std::vector<ClassMethodNodePtr> m_methodNodeList;
    std::vector<ClassPropertyNodePtr> m_propertyNodeList;
    AstNodeList m_memberNodeList;
};

class GenericNameNode final : public AstNode {
public:
    GenericNameNode(const IdentifierNodePtr &name, const std::vector<IdentifierNodePtr> &genericTypeArgs)
        : AstNode(AstNodeType::GenericNameNode),
          m_name(name),
          m_genericTypeArgs(genericTypeArgs) {
    }

    const IdentifierNodePtr &name() const {
        return m_name;
    }

    const std::vector<IdentifierNodePtr> &genericTypeArgs() const {
        return m_genericTypeArgs;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_name);
        for (const IdentifierNodePtr &typeArg : m_genericTypeArgs) {
            nodes.push_back(typeArg);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("GenericName(%1)").arg(m_name->name());
    }

private:
    IdentifierNodePtr m_name;
    std::vector<IdentifierNodePtr> m_genericTypeArgs;
};

class GenericClassNode final : public AstNode {
public:
    GenericClassNode(const GenericNameNodePtr &genericName, const std::vector<ClassConstructorNodePtr> &constructorNodeList, const std::vector<ClassMethodNodePtr> &methodNodeList, const std::vector<ClassPropertyNodePtr> &propertyNodeList, const AstNodeList &memberNodeList)
        : AstNode(AstNodeType::GenericClassNode),
          m_genericName(genericName),
          m_constructorNodeList(constructorNodeList),
          m_methodNodeList(methodNodeList),
          m_propertyNodeList(propertyNodeList),
          m_memberNodeList(memberNodeList) {
    }

    const GenericNameNodePtr &genericName() const {
        return m_genericName;
    }

    const std::vector<ClassConstructorNodePtr> &constructorNodeList() const {
        return m_constructorNodeList;
    }

    const std::vector<ClassMethodNodePtr> &methodNodeList() const {
        return m_methodNodeList;
    }

    const std::vector<ClassPropertyNodePtr> &propertyNodeList() const {
        return m_propertyNodeList;
    }

    const AstNodeList &memberNodeList() const {
        return m_memberNodeList;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_genericName);
        for (const AstNodePtr &memberNode : m_memberNodeList) {
            nodes.push_back(memberNode);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("GenericClass(%1)").arg(m_genericName->name()->name());
    }

private:
    GenericNameNodePtr m_genericName;
    std::vector<ClassConstructorNodePtr> m_constructorNodeList;
    std::vector<ClassMethodNodePtr> m_methodNodeList;
    std::vector<ClassPropertyNodePtr> m_propertyNodeList;
    AstNodeList m_memberNodeList;
};

class GenericDfunNode final : public AstNode {
public:
    GenericDfunNode(const GenericNameNodePtr &genericName, const std::vector<TypeVarBindNodePtr> &params, const AstNodePtr &returnType, const AstNodePtr &body)
        : AstNode(AstNodeType::GenericDfunNode),
          m_genericName(genericName),
          m_params(params),
          m_returnType(returnType),
          m_body(body) {
    }

    const GenericNameNodePtr &genericName() const {
        return m_genericName;
    }

    const std::vector<TypeVarBindNodePtr> &params() const {
        return m_params;
    }

    const AstNodePtr &returnType() const {
        return m_returnType;
    }

    const AstNodePtr &body() const {
        return m_body;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_genericName);
        for (const TypeVarBindNodePtr &param : m_params) {
            nodes.push_back(param);
        }
        nodes.push_back(m_returnType);
        nodes.push_back(m_body);
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("GenericFunction(%1)").arg(m_genericName->name()->name());
    }

private:
    GenericNameNodePtr m_genericName;
    std::vector<TypeVarBindNodePtr> m_params;
    AstNodePtr m_returnType;
    AstNodePtr m_body;
};

class FunctionCallNode final : public AstNode {
public:
    FunctionCallNode(const AstNodePtr &callee, const AstNodeList &args)
        : AstNode(AstNodeType::FunctionCallNode),
          m_callee(callee),
          m_args(args) {
    }

    const AstNodePtr &callee() const {
        return m_callee;
    }

    const AstNodeList &args() const {
        return m_args;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_callee);
        for (const AstNodePtr &arg : m_args) {
            nodes.push_back(arg);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("FunctionCall");
    }

private:
    AstNodePtr m_callee;
    AstNodeList m_args;
};

class GenericCallNode final : public AstNode {
public:
    GenericCallNode(const AstNodePtr &callee, const AstNodeList &typeArgs)
        : AstNode(AstNodeType::GenericCallNode),
          m_callee(callee),
          m_typeArgs(typeArgs) {
    }

    const AstNodePtr &callee() const {
        return m_callee;
    }

    const AstNodeList &typeArgs() const {
        return m_typeArgs;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_callee);
        for (const AstNodePtr &typeArg : m_typeArgs) {
            nodes.push_back(typeArg);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("GenericCall");
    }

private:
    AstNodePtr m_callee;
    AstNodeList m_typeArgs;
};

class MatchNode final : public AstNode {
public:
    MatchNode(const AstNodePtr &unionExpr, const std::vector<MatchBranch> &branches)
        : AstNode(AstNodeType::MatchNode),
          m_unionExpr(unionExpr),
          m_branches(branches) {
    }

    const AstNodePtr &unionExpr() const {
        return m_unionExpr;
    }

    const std::vector<MatchBranch> &branches() const {
        return m_branches;
    }

    AstNodeList childNodes() const override {
        AstNodeList nodes;
        nodes.push_back(m_unionExpr);
        for (const MatchBranch &branch : m_branches) {
            nodes.push_back(branch.bind);
            nodes.push_back(branch.body);
        }
        return nodes;
    }

    QString summaryText() const override {
        return QStringLiteral("Match");
    }

private:
    AstNodePtr m_unionExpr;
    std::vector<MatchBranch> m_branches;
};

}

#endif
