
import {
  annotateTokenSource,
  createSourceDocument,
  diagnosticError,
  type SourceDocument,
  type SourceRange,
} from "./Diagnostics";


// Token 类型枚举
export enum TokenType {
  LPAREN,
  RPAREN,
  NUMBER,
  IDENTIFIER,
}

export interface TextDatabaseReferenceInfo {
  readonly typeName: string;
  readonly entryName: string;
  readonly referenceName: string;
}

export interface TypedNumericLiteralInfo {
  readonly typeName: string;
  readonly payload: string;
}

export interface ComplexLiteralValue {
  readonly real: number;
  readonly imag: number;
  readonly realRaw: string;
  readonly imagRaw: string;
}

export enum BracketKind {
  ROUND = "ROUND",
  SQUARE = "SQUARE",
  CURLY = "CURLY",
  ANGLE = "ANGLE",
}

/**
 * 左括号 Token
 */
export class LParenToken {
  readonly kind: TokenType = TokenType.LPAREN;
  bracketKind: BracketKind;
  constructor(bracketKind: BracketKind) {
    this.bracketKind = bracketKind;
  }
}

/**
 * 右括号 Token
 */
export class RParenToken {
  readonly kind: TokenType = TokenType.RPAREN;
  bracketKind: BracketKind;
  constructor(bracketKind: BracketKind) {
    this.bracketKind = bracketKind;
  }
}

/**
 * 数字 Token
 */
export class NumberToken {
  readonly kind: TokenType = TokenType.NUMBER;
  typeName: string;
  value: number | ComplexLiteralValue;
  raw: string;
  constructor(typeName: string, value: number | ComplexLiteralValue, raw: string) {
    this.typeName = typeName;
    this.value = value;
    this.raw = raw;
  }
}

/**
 * 标识符 Token
 */
export class IdentifierToken {
  readonly kind: TokenType = TokenType.IDENTIFIER;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// 联合类型，表示所有 Token 类型
export type AbstractToken =
  | LParenToken
  | RParenToken
  | NumberToken
  | IdentifierToken;

const LEFT_BRACKET_KIND_MAP: ReadonlyMap<string, BracketKind> = new Map([
  ['(', BracketKind.ROUND],
  ['[', BracketKind.SQUARE],
  ['{', BracketKind.CURLY],
  ['<', BracketKind.ANGLE],
]);

const RIGHT_BRACKET_KIND_MAP: ReadonlyMap<string, BracketKind> = new Map([
  [')', BracketKind.ROUND],
  [']', BracketKind.SQUARE],
  ['}', BracketKind.CURLY],
  ['>', BracketKind.ANGLE],
]);

const IDENTIFIER_HEAD_SOURCE = "[a-zA-Z_]";
const IDENTIFIER_BODY_SOURCE = "[a-zA-Z0-9_]*";
const IDENTIFIER_SEGMENT_SOURCE = `${IDENTIFIER_HEAD_SOURCE}${IDENTIFIER_BODY_SOURCE}`;
const PACKAGE_SEGMENT_SOURCE = IDENTIFIER_SEGMENT_SOURCE;
const PACKAGE_PATH_SOURCE = `${PACKAGE_SEGMENT_SOURCE}(?:~${PACKAGE_SEGMENT_SOURCE})*`;
const PACKAGE_QUALIFIED_NAME_SOURCE = `${PACKAGE_PATH_SOURCE}@(${IDENTIFIER_SEGMENT_SOURCE})`;
const MEMBER_CHAIN_SEGMENT_SOURCE = `(?:${IDENTIFIER_SEGMENT_SOURCE}|${PACKAGE_SEGMENT_SOURCE}(?:~${PACKAGE_SEGMENT_SOURCE})*@(?:${IDENTIFIER_SEGMENT_SOURCE}))`;
const IDENTIFIER_PATTERN: RegExp = new RegExp(`^${IDENTIFIER_SEGMENT_SOURCE}$`);
const PACKAGE_PATH_PATTERN: RegExp = new RegExp(`^${PACKAGE_PATH_SOURCE}$`);
const PACKAGE_QUALIFIED_NAME_PATTERN: RegExp = new RegExp(`^${PACKAGE_QUALIFIED_NAME_SOURCE}$`);
const MEMBER_CHAIN_SEGMENT_PATTERN: RegExp = new RegExp(`^${MEMBER_CHAIN_SEGMENT_SOURCE}$`);
const DOTTED_MEMBER_CHAIN_PATTERN: RegExp = new RegExp(`^(?:${MEMBER_CHAIN_SEGMENT_SOURCE})(?:\\.(?:${MEMBER_CHAIN_SEGMENT_SOURCE}))+$`);
const LOCAL_TYPED_REFERENCE_PATTERN: RegExp = new RegExp(`^\\$(${IDENTIFIER_SEGMENT_SOURCE})\\^(${IDENTIFIER_SEGMENT_SOURCE})$`);
const PACKAGE_TYPED_REFERENCE_PATTERN: RegExp = new RegExp(`^(${PACKAGE_SEGMENT_SOURCE}(?:~${PACKAGE_SEGMENT_SOURCE})*)\\$(${IDENTIFIER_SEGMENT_SOURCE})\\^(${IDENTIFIER_SEGMENT_SOURCE})$`);
const INTEGER_PAYLOAD_PATTERN: RegExp = /^(?:0|[1-9][0-9]*|0neg[0-9]+|0x[0-9A-Fa-f]+)$/;
const FLOAT_PAYLOAD_PATTERN: RegExp = /^(?:(?:0neg)?(?:[0-9]+p[0-9]+(?:ep|en)[0-9]+|[0-9]+(?:ep|en)[0-9]+|[0-9]+p[0-9]+|[0-9]+)|inf|0neginf|nan)$/;
const COMPLEX_COMPONENT_PATTERN: RegExp = /^(?:(?:0neg)?(?:[0-9]+p[0-9]+(?:ep|en)[0-9]+|[0-9]+(?:ep|en)[0-9]+|[0-9]+p[0-9]+|0|[1-9][0-9]*)|inf|0neginf|nan)$/;

const INTEGER_TYPE_NAMES: ReadonlySet<string> = new Set(["i5", "i6", "i7", "u5", "u6", "u7"]);
const FLOAT_TYPE_NAMES: ReadonlySet<string> = new Set(["f5", "f6", "f7"]);
const COMPLEX_TYPE_NAMES: ReadonlySet<string> = new Set(["z5", "z6", "z7"]);
const SPECIAL_FLOAT_PAYLOADS: ReadonlySet<string> = new Set(["inf", "0neginf", "nan"]);
const ALLOWED_CHAR_PATTERN: RegExp = /^[a-zA-Z0-9_.$^~@\[\]\(\)\<\>\{\}\s]$/;

interface RawChunk {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface TokenizeOptions {
  readonly filePath?: string;
  readonly document?: SourceDocument;
}

export function parseTextDatabaseReferenceName(name: string): TextDatabaseReferenceInfo | null {
  const localMatch = name.match(LOCAL_TYPED_REFERENCE_PATTERN);
  if (localMatch !== null) {
    if (parseTypedNumericLiteral(name) !== null) {
      return null;
    }
    return {
      typeName: localMatch[2],
      entryName: localMatch[1],
      referenceName: name,
    };
  }

  const packageMatch = name.match(PACKAGE_TYPED_REFERENCE_PATTERN);
  if (packageMatch === null) {
    return null;
  }

  return {
    typeName: packageMatch[3],
    entryName: packageMatch[2],
    referenceName: name,
  };
}

export function isTextDatabaseReferenceName(name: string): boolean {
  return parseTextDatabaseReferenceName(name) !== null;
}

/**
 * 检查字符串是否只包含 V1 词法允许的字符。
 * @param input 输入字符串
 * @returns 是否只包含允许的字符
 */
export function isValidChars(input: string): boolean {
  for (const char of input) {
    if (!ALLOWED_CHAR_PATTERN.test(char)) {
      return false;
    }
  }
  return true;
}

function buildRange(startOffset: number, endOffset: number): SourceRange {
  return { startOffset, endOffset };
}

function findInvalidCharOffset(input: string): number | null {
  for (let index = 0; index < input.length; index += 1) {
    if (!ALLOWED_CHAR_PATTERN.test(input[index])) {
      return index;
    }
  }
  return null;
}

function parseComplexPayload(raw: string): ComplexLiteralValue | null {
  if (!raw.startsWith("0real")) {
    return null;
  }

  const separatorIndex = raw.indexOf("img", 5);
  if (separatorIndex < 0) {
    return null;
  }

  const realRaw = raw.slice(5, separatorIndex);
  const imagRaw = raw.slice(separatorIndex + 3);
  if (!COMPLEX_COMPONENT_PATTERN.test(realRaw) || !COMPLEX_COMPONENT_PATTERN.test(imagRaw)) {
    return null;
  }

  const real = parsePlainNumberPayload(realRaw);
  const imag = parsePlainNumberPayload(imagRaw);
  if (typeof real !== "number" || typeof imag !== "number") {
    return null;
  }

  return { real, imag, realRaw, imagRaw };
}

function parsePlainNumberPayload(raw: string): number | ComplexLiteralValue | null {
  if (raw === 'inf') {
    return Number.POSITIVE_INFINITY;
  }

  if (raw === '0neginf') {
    return Number.NEGATIVE_INFINITY;
  }

  if (raw === 'nan') {
    return Number.NaN;
  }

  if (/^[0-9]+$/.test(raw)) {
    return Number(raw);
  }

  if (/^0x[0-9A-Fa-f]+$/.test(raw)) {
    return parseInt(raw.slice(2), 16);
  }

  if (/^0neg[0-9]+$/.test(raw)) {
    return -Number(raw.slice(4));
  }

  const negativeFiniteMatch = raw.match(/^0neg(.+)$/);
  if (negativeFiniteMatch !== null) {
    const innerRaw = negativeFiniteMatch[1];
    if (/^0x/i.test(innerRaw) || innerRaw === 'inf' || innerRaw === '0neginf' || innerRaw === 'nan') {
      return null;
    }
    const innerValue = parsePlainNumberPayload(innerRaw);
    if (typeof innerValue === "number") {
      return -innerValue;
    }
    return null;
  }

  const floatMatch = raw.match(/^([0-9]+)p([0-9]+)$/);
  if (floatMatch !== null) {
    return Number(`${floatMatch[1]}.${floatMatch[2]}`);
  }

  const scientificMatch = raw.match(/^([0-9]+(?:p[0-9]+)?)(ep|en)([0-9]+)$/);
  if (scientificMatch !== null) {
    const mantissa = parsePlainNumberPayload(scientificMatch[1]);
    if (typeof mantissa !== "number") {
      return null;
    }
    const exponent = Number(scientificMatch[3]);
    return scientificMatch[2] === 'ep'
      ? mantissa * (10 ** exponent)
      : mantissa * (10 ** (-exponent));
  }

  const complexValue = parseComplexPayload(raw);
  if (complexValue !== null) {
    return complexValue;
  }

  return null;
}

export function parseTypedNumericLiteral(name: string): TypedNumericLiteralInfo | null {
  const match = name.match(/^\$(.+)\^([a-zA-Z][a-zA-Z0-9_]*)$/);
  if (match === null) {
    return null;
  }

  const payload = match[1];
  const typeName = match[2];
  const isSpecialFloatPayload = FLOAT_TYPE_NAMES.has(typeName) && SPECIAL_FLOAT_PAYLOADS.has(payload);
  if (IDENTIFIER_PATTERN.test(payload) && !isSpecialFloatPayload) {
    return null;
  }

  if (INTEGER_TYPE_NAMES.has(typeName) && INTEGER_PAYLOAD_PATTERN.test(payload) && parsePlainNumberPayload(payload) !== null) {
    return { typeName, payload };
  }

  if (FLOAT_TYPE_NAMES.has(typeName) && FLOAT_PAYLOAD_PATTERN.test(payload) && parsePlainNumberPayload(payload) !== null) {
    return { typeName, payload };
  }

  if (COMPLEX_TYPE_NAMES.has(typeName) && parseComplexPayload(payload) !== null) {
    return { typeName, payload };
  }

  return null;
}

export function buildNumberTokenFromRaw(raw: string): NumberToken {
  const typedNumeric: TypedNumericLiteralInfo | null = parseTypedNumericLiteral(raw);
  if (typedNumeric === null) {
    throw new Error(`Invalid typed numeric literal: ${raw}`);
  }
  const numericValue: number | ComplexLiteralValue | null = parsePlainNumberPayload(typedNumeric.payload);
  if (numericValue === null) {
    throw new Error(`Invalid typed numeric literal payload: ${raw}`);
  }
  return new NumberToken(typedNumeric.typeName, numericValue, raw);
}

function isIdentifierChunk(chunk: string): boolean {
  return IDENTIFIER_PATTERN.test(chunk)
    || PACKAGE_PATH_PATTERN.test(chunk)
    || PACKAGE_QUALIFIED_NAME_PATTERN.test(chunk)
    || isTextDatabaseReferenceName(chunk);
}

export function isMemberChainSegmentText(chunk: string): boolean {
  return MEMBER_CHAIN_SEGMENT_PATTERN.test(chunk) && parseTextDatabaseReferenceName(chunk) === null;
}

function isDottedMemberChainChunk(chunk: string): boolean {
  return DOTTED_MEMBER_CHAIN_PATTERN.test(chunk) && chunk.split('.').every(isMemberChainSegmentText);
}

/**
 * 第一遍：分割输入为原始 chunk。
 * @param input 输入字符串
 * @returns 字符串块数组
 */
function splitInputIntoRawChunks(input: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  let i: number = 0;
  while (i < input.length) {
    const c: string = input[i];
    if ("()[]{}<>".includes(c)) {
      chunks.push({ text: c, startOffset: i, endOffset: i + 1 });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      const start: number = i;
      while (
        i < input.length &&
        !/\s/.test(input[i]) &&
        !"()[]{}<>".includes(input[i])
      ) {
        i++;
      }
      const chunk: string = input.slice(start, i);
      chunks.push({ text: chunk, startOffset: start, endOffset: i });
    }
  }
  return chunks;
}

/**
 * 第二遍：把 a.b.c 这类成员访问糖展开成嵌套 cm_get 调用。
 * @param chunks 原始 chunk 数组
 * @returns 展开后的 chunk 数组
 */
function buildSyntheticChunk(text: string, sourceChunk: RawChunk): RawChunk {
  return {
    text,
    startOffset: sourceChunk.startOffset,
    endOffset: sourceChunk.endOffset,
  };
}

function expandDottedMemberChainChunk(chunk: RawChunk): RawChunk[] {
  const segments: RawChunk[] = [];
  let segmentStart = chunk.startOffset;
  for (const segmentText of chunk.text.split('.')) {
    const segmentEnd = segmentStart + segmentText.length;
    segments.push({ text: segmentText, startOffset: segmentStart, endOffset: segmentEnd });
    segmentStart = segmentEnd + 1;
  }

  let expressionChunks: RawChunk[] = [segments[0]];
  for (const segment of segments.slice(1)) {
    expressionChunks = [
      buildSyntheticChunk('(', chunk),
      buildSyntheticChunk('cm_get', chunk),
      ...expressionChunks,
      segment,
      buildSyntheticChunk(')', chunk),
    ];
  }
  return expressionChunks;
}

function expandDottedMemberChainChunks(chunks: RawChunk[]): RawChunk[] {
  const expandedChunks: RawChunk[] = [];
  for (const chunk of chunks) {
    if (!isDottedMemberChainChunk(chunk.text)) {
      expandedChunks.push(chunk);
      continue;
    }
    expandedChunks.push(...expandDottedMemberChainChunk(chunk));
  }
  return expandedChunks;
}

/**
 * 第三遍：将 chunk 字符串数组转换为 Token 实例数组。
 * @param chunks 字符串块数组
 * @returns Token 实例数组
 */
export function chunksToTokens(chunks: RawChunk[], document: SourceDocument): AbstractToken[] {
  const tokens: AbstractToken[] = [];
  for (const chunk of chunks) {
    let token: AbstractToken;
    if (LEFT_BRACKET_KIND_MAP.has(chunk.text)) {
      token = new LParenToken(LEFT_BRACKET_KIND_MAP.get(chunk.text)!);
    } else if (RIGHT_BRACKET_KIND_MAP.has(chunk.text)) {
      token = new RParenToken(RIGHT_BRACKET_KIND_MAP.get(chunk.text)!);
    } else {
      const typedNumeric = parseTypedNumericLiteral(chunk.text);
      if (typedNumeric !== null) {
        token = buildNumberTokenFromRaw(chunk.text);
      } else if (isIdentifierChunk(chunk.text)) {
        token = new IdentifierToken(chunk.text);
      } else {
        throw diagnosticError("lexer", "INVALID_TOKEN_CHUNK", `Invalid token chunk: ${chunk.text}`, {
          document,
          range: buildRange(chunk.startOffset, chunk.endOffset),
          details: {
            chunk: chunk.text,
          },
        });
      }
    }
    annotateTokenSource(token, document, buildRange(chunk.startOffset, chunk.endOffset));
    tokens.push(token);
  }
  return tokens;
}

/**
 * 入口函数：将输入字符串分词为 Token 流
 * @param input 输入字符串
 * @returns Token 实例数组
 */
export function tokenize(input: string, options: TokenizeOptions = {}): AbstractToken[] {
  const document = options.document ?? createSourceDocument(input, options.filePath);
  const invalidCharOffset = findInvalidCharOffset(input);
  if (invalidCharOffset !== null) {
    throw diagnosticError("lexer", "INVALID_CHARACTER", `Invalid character: ${JSON.stringify(input[invalidCharOffset])}`, {
      document,
      range: buildRange(invalidCharOffset, invalidCharOffset + 1),
      details: {
        character: input[invalidCharOffset],
        charCode: input.charCodeAt(invalidCharOffset),
      },
    });
  }

  const rawChunks: RawChunk[] = splitInputIntoRawChunks(input);
  const dottedExpandedChunks: RawChunk[] = expandDottedMemberChainChunks(rawChunks);
  return chunksToTokens(dottedExpandedChunks, document);
}

/**
 * 按顺序打印 Token 信息
 * @param tokens Token 实例数组
 */
export function printTokens(tokens: AbstractToken[]): void {
  for (const token of tokens) {
    if (token instanceof LParenToken) {
      console.log(`LPAREN(${token.bracketKind})`);
    } else if (token instanceof RParenToken) {
      console.log(`RPAREN(${token.bracketKind})`);
    } else if (token instanceof NumberToken) {
      console.log(`NUMBER(${token.raw} => ${typeof token.value === "number" ? token.value : `0real${token.value.realRaw}img${token.value.imagRaw}`})`);
    } else if (token instanceof IdentifierToken) {
      console.log(`IDENTIFIER(${token.name})`);
    } else {
      console.log('UNKNOWN_TOKEN');
    }
  }
}

/**
 * 按顺序打印 chunk 信息
 * @param chunks 字符串块数组
 */
export function printChunks(chunks: string[]): void {
  for (const chunk of chunks) {
    console.log(`chunk: ${chunk}`);
  }
}
