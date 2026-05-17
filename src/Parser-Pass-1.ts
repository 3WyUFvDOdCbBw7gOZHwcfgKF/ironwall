
import {
    AbstractToken,
    IdentifierToken,
    NumberToken,
    LParenToken,
    RParenToken,
    BracketKind,
    parseTextDatabaseReferenceName
} from "./lexer";
import {
    annotateAstSource,
    diagnosticError,
    getTokenSource,
    type SourceDocument,
    type SourceRange,
} from "./Diagnostics";
import {
    AstNode,
    IdentifierNode,
    NumberLiteralNode,
    TextDatabaseReferenceNode,
    RoundParenListNode,
    SquareParenListNode,
    CurlyParenListNode,
    AngleParenListNode,
} from "./AstNode";

/**
 * 语法分析第一遍，将 Token 流转换为通用 AST ListNode。
 * @param tokens Token 实例数组
 * @returns AST 根节点
 */
export function parsePass1(tokens: AbstractToken[]): AstNode {
    let currentPosition: number = 0;

    function buildDiagnosticOptionsForToken(token: AbstractToken | undefined): { document?: SourceDocument; range?: SourceRange } {
        if (token === undefined) {
            return {};
        }
        const metadata = getTokenSource(token);
        if (metadata === undefined) {
            return {};
        }
        return {
            document: metadata.document,
            range: metadata.range,
        };
    }

    function buildEofDiagnosticOptions(): { document?: SourceDocument; range?: SourceRange } {
        const lastToken = tokens.length === 0 ? undefined : tokens[tokens.length - 1];
        const lastTokenMetadata = lastToken === undefined ? undefined : getTokenSource(lastToken);
        if (lastTokenMetadata === undefined) {
            return {};
        }
        return {
            document: lastTokenMetadata.document,
            range: {
                startOffset: lastTokenMetadata.range.endOffset,
                endOffset: lastTokenMetadata.range.endOffset + 1,
            },
        };
    }

    function buildBracketListNode(bracketKind: BracketKind, elements: AstNode[], openToken: LParenToken, closeToken: RParenToken): AstNode {
        let node: AstNode;
        switch (bracketKind) {
            case BracketKind.ROUND:
                node = new RoundParenListNode(elements);
                break;
            case BracketKind.SQUARE:
                node = new SquareParenListNode(elements);
                break;
            case BracketKind.CURLY:
                node = new CurlyParenListNode(elements);
                break;
            case BracketKind.ANGLE:
                node = new AngleParenListNode(elements);
                break;
            default:
                throw new Error(`Unexpected bracket kind: ${String(bracketKind)}`);
        }

        const openMetadata = getTokenSource(openToken);
        const closeMetadata = getTokenSource(closeToken);
        if (openMetadata !== undefined && closeMetadata !== undefined) {
            annotateAstSource(node, openMetadata.document, {
                startOffset: openMetadata.range.startOffset,
                endOffset: closeMetadata.range.endOffset,
            });
        }
        return node;
    }

    function annotateNodeFromToken<T extends AstNode>(node: T, token: AbstractToken): T {
        const metadata = getTokenSource(token);
        if (metadata === undefined) {
            return node;
        }
        return annotateAstSource(node, metadata.document, metadata.range) as T;
    }

    /**
     * 解析以 LPAREN 开头、RPAREN 结尾的 token 列表，递归生成 ListNode。
     * @returns ListNode 实例
     * @throws Error 括号不匹配或未闭合时报错
     */
    function parseList(openToken: LParenToken): AstNode {
        currentPosition++; // 跳过 LPAREN
        const childNodes: AstNode[] = [];
        while (currentPosition < tokens.length) {
            const nextToken = tokens[currentPosition];
            if (nextToken instanceof RParenToken) {
                if (nextToken.bracketKind !== openToken.bracketKind) {
                    throw diagnosticError(
                        "parser-pass-1",
                        "MISMATCHED_CLOSING_BRACKET",
                        `Syntax Error: Mismatched closing bracket. Expected ${openToken.bracketKind}, got ${nextToken.bracketKind}.`,
                        {
                            ...buildDiagnosticOptionsForToken(nextToken),
                            details: {
                                expectedBracketKind: openToken.bracketKind,
                                actualBracketKind: nextToken.bracketKind,
                            },
                        }
                    );
                }
                currentPosition++; // 跳过 RPAREN
                return buildBracketListNode(openToken.bracketKind, childNodes, openToken, nextToken);
            }
            childNodes.push(parseToken());
        }
        throw diagnosticError(
            "parser-pass-1",
            "UNCLOSED_BRACKET",
            `Syntax Error: Unclosed ${openToken.bracketKind} bracket.`,
            {
                ...buildDiagnosticOptionsForToken(openToken),
                details: {
                    bracketKind: openToken.bracketKind,
                },
            }
        );
    }

    /**
     * 解析单个 token 为 AST 节点。
     * @returns AstNode 实例
     * @throws Error 非法 token 或意外结束时报错
     */
    function parseToken(): AstNode {
        if (currentPosition >= tokens.length) {
            throw diagnosticError(
                "parser-pass-1",
                "UNEXPECTED_END_OF_INPUT",
                "Syntax Error: Unexpected end of input.",
                buildEofDiagnosticOptions()
            );
        }
        const currentToken: AbstractToken = tokens[currentPosition];
        if (currentToken instanceof LParenToken) {
            return parseList(currentToken);
        } else if (currentToken instanceof IdentifierToken) {
            currentPosition++;
            const textReferenceInfo = parseTextDatabaseReferenceName(currentToken.name);
            if (textReferenceInfo !== null) {
                return annotateNodeFromToken(new TextDatabaseReferenceNode(
                    textReferenceInfo.typeName,
                    textReferenceInfo.entryName,
                    textReferenceInfo.referenceName
                ), currentToken);
            }
            return annotateNodeFromToken(new IdentifierNode(currentToken.name), currentToken);
        } else if (currentToken instanceof NumberToken) {
            currentPosition++;
            return annotateNodeFromToken(new NumberLiteralNode(currentToken.typeName, currentToken.value, currentToken.raw), currentToken);
        } else if (currentToken instanceof RParenToken) {
            throw diagnosticError(
                "parser-pass-1",
                "UNEXPECTED_CLOSING_BRACKET",
                `Syntax Error: Unexpected closing ${currentToken.bracketKind} bracket.`,
                {
                    ...buildDiagnosticOptionsForToken(currentToken),
                    details: {
                        bracketKind: currentToken.bracketKind,
                        tokenIndex: currentPosition,
                    },
                }
            );
        } else {
            throw diagnosticError(
                "parser-pass-1",
                "UNEXPECTED_TOKEN_TYPE",
                "Syntax Error: Unexpected token type. Expected LPAREN, IDENTIFIER, or NUMBER.",
                {
                    ...buildDiagnosticOptionsForToken(currentToken),
                    details: {
                        tokenIndex: currentPosition,
                        tokenKind: "unknown",
                    },
                }
            );
        }
    }

    // 从第一个 token 开始解析
    const astRootNode: AstNode = parseToken();

    // 检查是否所有 token 都被消费，若有剩余则报错
    if (currentPosition !== tokens.length) {
        const nextToken: AbstractToken = tokens[currentPosition];
        throw diagnosticError(
            "parser-pass-1",
            "UNEXPECTED_TRAILING_TOKENS",
            `Syntax Error: Unexpected trailing tokens. Parsed ${currentPosition} tokens, but found ${tokens.length} total. Next token kind: ${nextToken.kind}`,
            {
                ...buildDiagnosticOptionsForToken(nextToken),
                details: {
                    parsedTokenCount: currentPosition,
                    totalTokenCount: tokens.length,
                    nextTokenKind: nextToken.kind,
                },
            }
        );
    }
    return astRootNode;
}

/**
 * 检查 ListNode 括号配对是否合法。
 * @param node AST 节点
 * @throws Error 括号不匹配时报错
 */
export function CheckParenAfterPass1(node: AstNode): void {
    void node;
    return;
}

/**
 * 将通用 ListNode 转换为具体括号类型的 ListNode。
 * @param node AST 节点
 * @returns 转换后的 AST 节点
 */
export function fromGenricListToSpecificList(node: AstNode): AstNode {
    return node;
}