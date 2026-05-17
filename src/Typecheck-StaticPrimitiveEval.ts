import {
    AstNode,
    CondNode,
    DvarNode,
    FunctionCallNode,
    IdentifierNode,
    IfNode,
    LetNode,
    MatchNode,
    NumberLiteralNode,
    SeqNode,
    SetNode,
    TextDatabaseReferenceNode,
    TypeVarBindNode,
    WhileNode
} from "./AstNode";
import { PrimitiveTypeValue, UnionTypeValue, primitiveTypeNames, type TypeValue } from "./Typecheck-Core";

const INTEGER_TYPE_NAMES: ReadonlySet<string> = new Set(["i5", "i6", "i7", "u5", "u6", "u7"]);
const FLOAT_TYPE_NAMES: ReadonlySet<string> = new Set(["f5", "f6", "f7"]);
const CHARACTER_TYPE_NAMES: ReadonlySet<string> = new Set(["c3", "c4", "c5"]);
const STRING_TYPE_NAMES: ReadonlySet<string> = new Set(["s3", "s4", "s5"]);
const COMPLEX_TYPE_NAMES: ReadonlySet<string> = new Set(["z5", "z6", "z7"]);

export class StaticPrimitiveEvalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaticPrimitiveEvalError";
    }
}

export class StaticComplexPayload {
    public readonly real: number;
    public readonly imag: number;

    constructor(real: number, imag: number) {
        this.real = real;
        this.imag = imag;
    }
}

export class StaticPrimitiveValue {
    public readonly typeName: string;
    public readonly numericValue: number | null;
    public readonly booleanValue: boolean | null;
    public readonly textValue: string | null;
    public readonly complexValue: StaticComplexPayload | null;
    public readonly isUnit: boolean;

    private constructor(
        typeName: string,
        numericValue: number | null,
        booleanValue: boolean | null,
        textValue: string | null,
        complexValue: StaticComplexPayload | null,
        isUnit: boolean
    ) {
        this.typeName = typeName;
        this.numericValue = numericValue;
        this.booleanValue = booleanValue;
        this.textValue = textValue;
        this.complexValue = complexValue;
        this.isUnit = isUnit;
    }

    public static numeric(typeName: string, value: number): StaticPrimitiveValue {
        return new StaticPrimitiveValue(typeName, value, null, null, null, false);
    }

    public static boolean(value: boolean): StaticPrimitiveValue {
        return new StaticPrimitiveValue("bool", null, value, null, null, false);
    }

    public static text(typeName: string, value: string): StaticPrimitiveValue {
        return new StaticPrimitiveValue(typeName, null, null, value, null, false);
    }

    public static complex(typeName: string, value: StaticComplexPayload): StaticPrimitiveValue {
        return new StaticPrimitiveValue(typeName, null, null, null, value, false);
    }

    public static unit(): StaticPrimitiveValue {
        return new StaticPrimitiveValue("unit", null, null, null, null, true);
    }

    public expectNumeric(context: string): number {
        if (this.numericValue === null) {
            throw new StaticPrimitiveEvalError(`${context}: expected numeric primitive payload, got ${this.typeName}`);
        }
        return this.numericValue;
    }

    public expectBoolean(context: string): boolean {
        if (this.booleanValue === null) {
            throw new StaticPrimitiveEvalError(`${context}: expected bool payload, got ${this.typeName}`);
        }
        return this.booleanValue;
    }

    public expectText(context: string): string {
        if (this.textValue === null) {
            throw new StaticPrimitiveEvalError(`${context}: expected text payload, got ${this.typeName}`);
        }
        return this.textValue;
    }

    public expectComplex(context: string): StaticComplexPayload {
        if (this.complexValue === null) {
            throw new StaticPrimitiveEvalError(`${context}: expected complex payload, got ${this.typeName}`);
        }
        return this.complexValue;
    }
}

class StaticBinding {
    public readonly name: string;
    public readonly mutable: boolean;
    public value: StaticPrimitiveValue;

    constructor(name: string, value: StaticPrimitiveValue, mutable: boolean) {
        this.name = name;
        this.value = value;
        this.mutable = mutable;
    }
}

class StaticEvalEnv {
    private readonly bindings: Map<string, StaticBinding>;
    private readonly parent: StaticEvalEnv | null;

    constructor(parent: StaticEvalEnv | null = null) {
        this.bindings = new Map<string, StaticBinding>();
        this.parent = parent;
    }

    public createChild(): StaticEvalEnv {
        return new StaticEvalEnv(this);
    }

    public defineMutable(name: string, value: StaticPrimitiveValue): void {
        this.bindings.set(name, new StaticBinding(name, value, true));
    }

    public defineImmutable(name: string, value: StaticPrimitiveValue): void {
        this.bindings.set(name, new StaticBinding(name, value, false));
    }

    public get(name: string): StaticPrimitiveValue | undefined {
        const local: StaticBinding | undefined = this.bindings.get(name);
        if (local !== undefined) {
            return local.value;
        }
        return this.parent?.get(name);
    }

    public assign(name: string, value: StaticPrimitiveValue): void {
        const local: StaticBinding | undefined = this.bindings.get(name);
        if (local !== undefined) {
            if (!local.mutable) {
                throw new StaticPrimitiveEvalError(`static evaluation cannot assign to immutable binding '${name}'`);
            }
            local.value = value;
            return;
        }
        if (this.parent !== null) {
            this.parent.assign(name, value);
            return;
        }
        throw new StaticPrimitiveEvalError(`static evaluation cannot assign to unknown binding '${name}'`);
    }
}

function isPrimitiveTypeValue(type: TypeValue): type is PrimitiveTypeValue {
    return type instanceof PrimitiveTypeValue;
}

export function isAllowedTopLevelGlobalType(type: TypeValue): boolean {
    if (isPrimitiveTypeValue(type)) {
        return true;
    }
    if (!(type instanceof UnionTypeValue)) {
        return false;
    }
    return type.types.some((member) => isPrimitiveTypeValue(member));
}

function isIntegerTypeName(typeName: string): boolean {
    return INTEGER_TYPE_NAMES.has(typeName);
}

function isFloatTypeName(typeName: string): boolean {
    return FLOAT_TYPE_NAMES.has(typeName);
}

function isCharacterTypeName(typeName: string): boolean {
    return CHARACTER_TYPE_NAMES.has(typeName);
}

function isStringTypeName(typeName: string): boolean {
    return STRING_TYPE_NAMES.has(typeName);
}

function isComplexTypeName(typeName: string): boolean {
    return COMPLEX_TYPE_NAMES.has(typeName);
}

function isPrimitivePayloadValue(value: StaticPrimitiveValue): boolean {
    return primitiveTypeNames.has(value.typeName);
}

function roundHalfAwayFromZero(value: number): number {
    return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

function isSignedIntegerTypeName(typeName: string): boolean {
    return typeName === "i5" || typeName === "i6" || typeName === "i7";
}

function integerConversionBitWidth(typeName: string): number {
    switch (typeName) {
        case "i5":
        case "u5":
            return 32;
        case "i6":
        case "i7":
        case "u6":
        case "u7":
            return 64;
        case "c3":
            return 8;
        case "c4":
            return 16;
        case "c5":
            return 32;
        default:
            throw new StaticPrimitiveEvalError(`unsupported integer conversion width '${typeName}'`);
    }
}

function floatConversionBitWidth(typeName: string): number {
    switch (typeName) {
        case "f5":
            return 32;
        case "f6":
        case "f7":
            return 64;
        default:
            throw new StaticPrimitiveEvalError(`unsupported float conversion width '${typeName}'`);
    }
}

function normalizeUnsignedBits(value: bigint, bitWidth: number): bigint {
    const modulus: bigint = 1n << BigInt(bitWidth);
    let normalized: bigint = value % modulus;
    if (normalized < 0n) {
        normalized += modulus;
    }
    return normalized;
}

function reinterpretSignedBits(value: bigint, bitWidth: number): bigint {
    const normalized: bigint = normalizeUnsignedBits(value, bitWidth);
    const signBit: bigint = 1n << BigInt(bitWidth - 1);
    return (normalized & signBit) === 0n ? normalized : normalized - (1n << BigInt(bitWidth));
}

function float32ToBits(value: number): bigint {
    const buffer: ArrayBuffer = new ArrayBuffer(4);
    const view: DataView = new DataView(buffer);
    view.setFloat32(0, value, true);
    return BigInt(view.getUint32(0, true));
}

function bitsToFloat32(bits: bigint): number {
    const buffer: ArrayBuffer = new ArrayBuffer(4);
    const view: DataView = new DataView(buffer);
    view.setUint32(0, Number(normalizeUnsignedBits(bits, 32)), true);
    return view.getFloat32(0, true);
}

function float64ToBits(value: number): bigint {
    const buffer: ArrayBuffer = new ArrayBuffer(8);
    const view: DataView = new DataView(buffer);
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
}

function bitsToFloat64(bits: bigint): number {
    const buffer: ArrayBuffer = new ArrayBuffer(8);
    const view: DataView = new DataView(buffer);
    view.setBigUint64(0, normalizeUnsignedBits(bits, 64), true);
    return view.getFloat64(0, true);
}

function numericValueToBits(sourceTypeName: string, source: StaticPrimitiveValue, context: string): bigint | null {
    if (isIntegerTypeName(sourceTypeName)) {
        const numericValue: bigint = BigInt(source.expectNumeric(context));
        return normalizeUnsignedBits(numericValue, integerConversionBitWidth(sourceTypeName));
    }
    if (isCharacterTypeName(sourceTypeName)) {
        const textValue: string = source.expectText(context);
        const charValue: bigint = BigInt(textValue.charCodeAt(0));
        return normalizeUnsignedBits(charValue, integerConversionBitWidth(sourceTypeName));
    }
    if (isFloatTypeName(sourceTypeName)) {
        const numericValue: number = source.expectNumeric(context);
        if (sourceTypeName === "f5") {
            return float32ToBits(numericValue);
        }
        return float64ToBits(numericValue);
    }
    return null;
}

function bitsToFloatValue(targetTypeName: string, bits: bigint): number {
    if (targetTypeName === "f5") {
        return bitsToFloat32(bits);
    }
    return bitsToFloat64(bits);
}

function toIntegerShiftOperand(value: number): bigint {
    return BigInt(Math.trunc(value));
}

function evaluateIntegerBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (args.length !== 2) {
        return null;
    }
    const leftTypeName: string = args[0].typeName;
    const rightTypeName: string = args[1].typeName;
    if (leftTypeName !== rightTypeName || !isIntegerTypeName(leftTypeName)) {
        return null;
    }
    const left: number = args[0].expectNumeric(`${name} left operand`);
    const right: number = args[1].expectNumeric(`${name} right operand`);

    switch (name) {
        case "add":
            return StaticPrimitiveValue.numeric(leftTypeName, left + right);
        case "sub":
            return StaticPrimitiveValue.numeric(leftTypeName, left - right);
        case "mul":
            return StaticPrimitiveValue.numeric(leftTypeName, left * right);
        case "div":
            return StaticPrimitiveValue.numeric(leftTypeName, Math.trunc(left / right));
        case "mod":
            return StaticPrimitiveValue.numeric(leftTypeName, left % right);
        case "le":
            return StaticPrimitiveValue.boolean(left <= right);
        case "lt":
            return StaticPrimitiveValue.boolean(left < right);
        case "ge":
            return StaticPrimitiveValue.boolean(left >= right);
        case "gt":
            return StaticPrimitiveValue.boolean(left > right);
        case "eq":
            return StaticPrimitiveValue.boolean(left === right);
        case "neq":
            return StaticPrimitiveValue.boolean(left !== right);
        case "bwand":
            return StaticPrimitiveValue.numeric(leftTypeName, Number(toIntegerShiftOperand(left) & toIntegerShiftOperand(right)));
        case "bwor":
            return StaticPrimitiveValue.numeric(leftTypeName, Number(toIntegerShiftOperand(left) | toIntegerShiftOperand(right)));
        case "bwxor":
            return StaticPrimitiveValue.numeric(leftTypeName, Number(toIntegerShiftOperand(left) ^ toIntegerShiftOperand(right)));
        case "ls":
            return StaticPrimitiveValue.numeric(leftTypeName, Number(toIntegerShiftOperand(left) << toIntegerShiftOperand(right)));
        case "rs":
            return StaticPrimitiveValue.numeric(leftTypeName, Number(toIntegerShiftOperand(left) >> toIntegerShiftOperand(right)));
        default:
            return null;
    }
}

function evaluateFloatBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (args.length !== 2) {
        return null;
    }
    const leftTypeName: string = args[0].typeName;
    const rightTypeName: string = args[1].typeName;
    if (leftTypeName !== rightTypeName || !isFloatTypeName(leftTypeName)) {
        return null;
    }
    const left: number = args[0].expectNumeric(`${name} left operand`);
    const right: number = args[1].expectNumeric(`${name} right operand`);

    switch (name) {
        case "add":
            return StaticPrimitiveValue.numeric(leftTypeName, left + right);
        case "sub":
            return StaticPrimitiveValue.numeric(leftTypeName, left - right);
        case "mul":
            return StaticPrimitiveValue.numeric(leftTypeName, left * right);
        case "div":
            return StaticPrimitiveValue.numeric(leftTypeName, left / right);
        case "mod":
            return StaticPrimitiveValue.numeric(leftTypeName, left % right);
        case "le":
            return StaticPrimitiveValue.boolean(left <= right);
        case "lt":
            return StaticPrimitiveValue.boolean(left < right);
        case "ge":
            return StaticPrimitiveValue.boolean(left >= right);
        case "gt":
            return StaticPrimitiveValue.boolean(left > right);
        case "eq":
            return StaticPrimitiveValue.boolean(left === right);
        case "neq":
            return StaticPrimitiveValue.boolean(left !== right);
        default:
            return null;
    }
}

function evaluateCharacterBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (args.length !== 2) {
        return null;
    }
    const leftTypeName: string = args[0].typeName;
    const rightTypeName: string = args[1].typeName;
    if (leftTypeName !== rightTypeName || !isCharacterTypeName(leftTypeName)) {
        return null;
    }
    const leftText: string = args[0].expectText(`${name} left operand`);
    const rightText: string = args[1].expectText(`${name} right operand`);
    const leftCode: number = leftText.charCodeAt(0);
    const rightCode: number = rightText.charCodeAt(0);

    switch (name) {
        case "le":
            return StaticPrimitiveValue.boolean(leftCode <= rightCode);
        case "lt":
            return StaticPrimitiveValue.boolean(leftCode < rightCode);
        case "ge":
            return StaticPrimitiveValue.boolean(leftCode >= rightCode);
        case "gt":
            return StaticPrimitiveValue.boolean(leftCode > rightCode);
        case "eq":
            return StaticPrimitiveValue.boolean(leftCode === rightCode);
        case "neq":
            return StaticPrimitiveValue.boolean(leftCode !== rightCode);
        default:
            return null;
    }
}

function evaluateBooleanBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (name === "not") {
        if (args.length !== 1 || args[0].typeName !== "bool") {
            return null;
        }
        return StaticPrimitiveValue.boolean(!args[0].expectBoolean(`${name} operand`));
    }
    if (args.length !== 2) {
        return null;
    }
    if (args[0].typeName !== "bool" || args[1].typeName !== "bool") {
        return null;
    }
    const left: boolean = args[0].expectBoolean(`${name} left operand`);
    const right: boolean = args[1].expectBoolean(`${name} right operand`);

    switch (name) {
        case "and":
            return StaticPrimitiveValue.boolean(left && right);
        case "or":
            return StaticPrimitiveValue.boolean(left || right);
        case "xor":
            return StaticPrimitiveValue.boolean(left !== right);
        default:
            return null;
    }
}

function evaluateTextBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    const builtinMatch: RegExpMatchArray | null = name.match(/^(s[345])_(new|get|set|length)$/);
    if (builtinMatch === null) {
        return null;
    }
    const stringTypeName: string = builtinMatch[1];
    const action: string = builtinMatch[2];
    const charTypeName: string = `c${stringTypeName.slice(1)}`;

    if (action === "new") {
        if (args.length === 1 && args[0].typeName === stringTypeName) {
            return StaticPrimitiveValue.text(stringTypeName, args[0].expectText(`${name} source text`));
        }
        if (args.length === 2 && args[0].typeName === "i5" && args[1].typeName === charTypeName) {
            const length: number = args[0].expectNumeric(`${name} length`);
            const fillChar: string = args[1].expectText(`${name} fill character`);
            return StaticPrimitiveValue.text(stringTypeName, fillChar.repeat(Math.trunc(length)));
        }
        return null;
    }

    if (action === "get") {
        if (args.length !== 2 || args[0].typeName !== stringTypeName || args[1].typeName !== "i5") {
            return null;
        }
        const source: string = args[0].expectText(`${name} source text`);
        const index: number = Math.trunc(args[1].expectNumeric(`${name} index`));
        return StaticPrimitiveValue.text(charTypeName, source[index] ?? "");
    }

    if (action === "set") {
        if (args.length !== 3 || args[0].typeName !== stringTypeName || args[1].typeName !== "i5" || args[2].typeName !== charTypeName) {
            return null;
        }
        const source: string = args[0].expectText(`${name} source text`);
        const index: number = Math.trunc(args[1].expectNumeric(`${name} index`));
        const replacement: string = args[2].expectText(`${name} replacement character`);
        const characters: string[] = source.split("");
        characters[index] = replacement;
        return StaticPrimitiveValue.text(stringTypeName, characters.join(""));
    }

    if (action === "length") {
        if (args.length !== 1 || args[0].typeName !== stringTypeName) {
            return null;
        }
        return StaticPrimitiveValue.numeric("i5", args[0].expectText(`${name} source text`).length);
    }

    return null;
}

function evaluateIwMathBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (name === "iw_i5_to_f5" && args.length === 1 && args[0].typeName === "i5") {
        return StaticPrimitiveValue.numeric("f5", args[0].expectNumeric(`${name} value`));
    }

    const roundingMatch: RegExpMatchArray | null = name.match(/^iw_(round|floor|ceil|trunc)_(f[567])$/);
    if (roundingMatch !== null && args.length === 1 && args[0].typeName === roundingMatch[2]) {
        const value: number = args[0].expectNumeric(`${name} value`);
        switch (roundingMatch[1]) {
            case "round":
                return StaticPrimitiveValue.numeric("i5", roundHalfAwayFromZero(value));
            case "floor":
                return StaticPrimitiveValue.numeric("i5", Math.floor(value));
            case "ceil":
                return StaticPrimitiveValue.numeric("i5", Math.ceil(value));
            case "trunc":
                return StaticPrimitiveValue.numeric("i5", Math.trunc(value));
            default:
                return null;
        }
    }

    const unaryFloatMatch: RegExpMatchArray | null = name.match(/^iw_(sin|cos|sqrt)_(f[567])$/);
    if (unaryFloatMatch !== null && args.length === 1 && args[0].typeName === unaryFloatMatch[2]) {
        const value: number = args[0].expectNumeric(`${name} value`);
        switch (unaryFloatMatch[1]) {
            case "sin":
                return StaticPrimitiveValue.numeric(unaryFloatMatch[2], Math.sin(value));
            case "cos":
                return StaticPrimitiveValue.numeric(unaryFloatMatch[2], Math.cos(value));
            case "sqrt":
                return StaticPrimitiveValue.numeric(unaryFloatMatch[2], Math.sqrt(value));
            default:
                return null;
        }
    }

    const atan2Match: RegExpMatchArray | null = name.match(/^iw_atan2_(f[567])$/);
    if (atan2Match !== null && args.length === 2 && args[0].typeName === atan2Match[1] && args[1].typeName === atan2Match[1]) {
        const y: number = args[0].expectNumeric(`${name} y`);
        const x: number = args[1].expectNumeric(`${name} x`);
        return StaticPrimitiveValue.numeric(atan2Match[1], Math.atan2(y, x));
    }

    return null;
}

function convertValueScalarValue(targetTypeName: string, source: StaticPrimitiveValue, sourceTypeName: string, name: string): StaticPrimitiveValue | null {
    if (source.typeName !== sourceTypeName) {
        return null;
    }

    if (isIntegerTypeName(targetTypeName)) {
        if (!isIntegerTypeName(sourceTypeName) && !isFloatTypeName(sourceTypeName) && !isCharacterTypeName(sourceTypeName)) {
            return null;
        }
        const numericValue: bigint = isCharacterTypeName(sourceTypeName)
            ? BigInt(source.expectText(`${name} value`).charCodeAt(0))
            : isFloatTypeName(sourceTypeName)
                ? BigInt(Math.trunc(source.expectNumeric(`${name} value`)))
                : BigInt(source.expectNumeric(`${name} value`));
        const bitWidth: number = integerConversionBitWidth(targetTypeName);
        const unsignedBits: bigint = normalizeUnsignedBits(numericValue, bitWidth);
        const resultValue: bigint = isSignedIntegerTypeName(targetTypeName)
            ? reinterpretSignedBits(unsignedBits, bitWidth)
            : unsignedBits;
        return StaticPrimitiveValue.numeric(targetTypeName, Number(resultValue));
    }

    if (isFloatTypeName(targetTypeName)) {
        if (isIntegerTypeName(sourceTypeName) || isFloatTypeName(sourceTypeName)) {
            return StaticPrimitiveValue.numeric(targetTypeName, source.expectNumeric(`${name} value`));
        }
        return null;
    }

    return null;
}

function convertBinaryScalarValue(targetTypeName: string, source: StaticPrimitiveValue, sourceTypeName: string, name: string): StaticPrimitiveValue | null {
    if (source.typeName !== sourceTypeName) {
        return null;
    }

    const sourceBits: bigint | null = numericValueToBits(sourceTypeName, source, `${name} value`);
    if (sourceBits === null) {
        return null;
    }

    if (isIntegerTypeName(targetTypeName)) {
        const bitWidth: number = integerConversionBitWidth(targetTypeName);
        const copiedBits: bigint = normalizeUnsignedBits(sourceBits, bitWidth);
        const resultValue: bigint = isSignedIntegerTypeName(targetTypeName)
            ? reinterpretSignedBits(copiedBits, bitWidth)
            : copiedBits;
        return StaticPrimitiveValue.numeric(targetTypeName, Number(resultValue));
    }

    if (isFloatTypeName(targetTypeName)) {
        const bitWidth: number = floatConversionBitWidth(targetTypeName);
        const copiedBits: bigint = normalizeUnsignedBits(sourceBits, bitWidth);
        return StaticPrimitiveValue.numeric(targetTypeName, bitsToFloatValue(targetTypeName, copiedBits));
    }

    return null;
}

function evaluateScalarConversionBuiltin(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue | null {
    if (args.length !== 1) {
        return null;
    }
    const sourceLevelValueMatch: RegExpMatchArray | null = name.match(/^val_to_([a-z0-9]+)$/);
    if (sourceLevelValueMatch !== null) {
        return convertValueScalarValue(sourceLevelValueMatch[1], args[0], args[0].typeName, name);
    }

    const sourceLevelBinaryMatch: RegExpMatchArray | null = name.match(/^bin_to_([a-z0-9]+)$/);
    if (sourceLevelBinaryMatch !== null) {
        return convertBinaryScalarValue(sourceLevelBinaryMatch[1], args[0], args[0].typeName, name);
    }

    const valueConversionMatch: RegExpMatchArray | null = name.match(/^iw_ty_to_([a-z0-9]+)_([a-z0-9]+)$/);
    if (valueConversionMatch !== null) {
        return convertValueScalarValue(valueConversionMatch[1], args[0], valueConversionMatch[2], name);
    }

    const binaryConversionMatch: RegExpMatchArray | null = name.match(/^iw_bin_to_([a-z0-9]+)_([a-z0-9]+)$/);
    if (binaryConversionMatch !== null) {
        return convertBinaryScalarValue(binaryConversionMatch[1], args[0], binaryConversionMatch[2], name);
    }

    return null;
}

function evaluateBuiltinCall(name: string, args: readonly StaticPrimitiveValue[]): StaticPrimitiveValue {
    const integerResult: StaticPrimitiveValue | null = evaluateIntegerBuiltin(name, args);
    if (integerResult !== null) {
        return integerResult;
    }

    const floatResult: StaticPrimitiveValue | null = evaluateFloatBuiltin(name, args);
    if (floatResult !== null) {
        return floatResult;
    }

    const charResult: StaticPrimitiveValue | null = evaluateCharacterBuiltin(name, args);
    if (charResult !== null) {
        return charResult;
    }

    const boolResult: StaticPrimitiveValue | null = evaluateBooleanBuiltin(name, args);
    if (boolResult !== null) {
        return boolResult;
    }

    const textResult: StaticPrimitiveValue | null = evaluateTextBuiltin(name, args);
    if (textResult !== null) {
        return textResult;
    }

    const iwMathResult: StaticPrimitiveValue | null = evaluateIwMathBuiltin(name, args);
    if (iwMathResult !== null) {
        return iwMathResult;
    }

    const conversionResult: StaticPrimitiveValue | null = evaluateScalarConversionBuiltin(name, args);
    if (conversionResult !== null) {
        return conversionResult;
    }

    throw new StaticPrimitiveEvalError(`function call '${name}' is not part of the static primitive global initializer subset`);
}

function normalizeStaticBuiltinCallName(name: string): string {
    const lastQualifierIndex: number = name.lastIndexOf("@");
    return lastQualifierIndex >= 0 ? name.slice(lastQualifierIndex + 1) : name;
}

function isSupportedStaticBuiltinCallName(name: string): boolean {
    const normalizedName: string = normalizeStaticBuiltinCallName(name);
    if ([
        "add",
        "sub",
        "mul",
        "div",
        "mod",
        "le",
        "lt",
        "ge",
        "gt",
        "eq",
        "neq",
        "not",
        "and",
        "or",
        "xor",
        "bwand",
        "bwor",
        "bwxor",
        "ls",
        "rs",
        "iw_i5_to_f5"
    ].includes(normalizedName)) {
        return true;
    }
    if (/^(s[345])_(new|get|set|length)$/.test(normalizedName)) {
        return true;
    }
    if (/^iw_(round|floor|ceil|trunc)_(f[567])$/.test(normalizedName)) {
        return true;
    }
    if (/^iw_(sin|cos|sqrt)_(f[567])$/.test(normalizedName)) {
        return true;
    }
    if (/^iw_atan2_(f[567])$/.test(normalizedName)) {
        return true;
    }
    if (/^val_to_([a-z0-9]+)$/.test(normalizedName)) {
        return true;
    }
    if (/^bin_to_([a-z0-9]+)$/.test(normalizedName)) {
        return true;
    }
    if (/^iw_ty_to_([a-z0-9]+)_([a-z0-9]+)$/.test(normalizedName)) {
        return true;
    }
    if (/^iw_bin_to_([a-z0-9]+)_([a-z0-9]+)$/.test(normalizedName)) {
        return true;
    }
    return false;
}

function evaluateIdentifier(node: IdentifierNode, env: StaticEvalEnv): StaticPrimitiveValue {
    if (node.name === "true") {
        return StaticPrimitiveValue.boolean(true);
    }
    if (node.name === "false") {
        return StaticPrimitiveValue.boolean(false);
    }
    if (node.name === "unit") {
        return StaticPrimitiveValue.unit();
    }
    const value: StaticPrimitiveValue | undefined = env.get(node.name);
    if (value !== undefined) {
        return value;
    }
    throw new StaticPrimitiveEvalError(`identifier '${node.name}' is not a static primitive binding`);
}

function evaluateLiteral(node: NumberLiteralNode | TextDatabaseReferenceNode): StaticPrimitiveValue {
    if (node instanceof NumberLiteralNode) {
        if (typeof node.value === "number") {
            return StaticPrimitiveValue.numeric(node.typeName, node.value);
        }
        return StaticPrimitiveValue.complex(
            node.typeName,
            new StaticComplexPayload(node.value.real, node.value.imag)
        );
    }

    if (node.content === null) {
        throw new StaticPrimitiveEvalError(`literal db reference '${node.referenceName}' is unresolved during static global evaluation`);
    }
    if (typeof node.content === "number") {
        return StaticPrimitiveValue.numeric(node.typeName, node.content);
    }
    return StaticPrimitiveValue.text(node.typeName, node.content);
}

function evaluateLet(node: LetNode, env: StaticEvalEnv): StaticPrimitiveValue {
    const localEnv: StaticEvalEnv = env.createChild();
    for (const binding of node.bindings) {
        if (!(binding.bind instanceof TypeVarBindNode)) {
            throw new StaticPrimitiveEvalError("static primitive evaluation only supports typed let bindings");
        }
        const value: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(binding.value, localEnv);
        if (!isPrimitivePayloadValue(value)) {
            throw new StaticPrimitiveEvalError(`let binding '${binding.bind.var.name}' does not resolve to a primitive payload`);
        }
        localEnv.defineImmutable(binding.bind.var.name, value);
    }
    return evaluateStaticPrimitiveExpr(node.body, localEnv);
}

function evaluateCond(node: CondNode, env: StaticEvalEnv): StaticPrimitiveValue {
    for (const clause of node.clausesExprs) {
        if (clause.cond instanceof IdentifierNode && clause.cond.name === "else") {
            return evaluateStaticPrimitiveExpr(clause.body, env);
        }
        const conditionValue: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(clause.cond, env);
        if (conditionValue.expectBoolean("cond clause condition")) {
            return evaluateStaticPrimitiveExpr(clause.body, env);
        }
    }
    throw new StaticPrimitiveEvalError("cond static evaluation requires a matching clause or else branch");
}

function evaluateSeq(node: SeqNode, env: StaticEvalEnv): StaticPrimitiveValue {
    if (node.expressions.length === 0) {
        throw new StaticPrimitiveEvalError("static primitive evaluation requires non-empty seq");
    }
    let result: StaticPrimitiveValue = StaticPrimitiveValue.unit();
    for (const expression of node.expressions) {
        result = evaluateStaticPrimitiveExpr(expression, env);
    }
    return result;
}

function evaluateLocalVar(node: DvarNode, env: StaticEvalEnv): StaticPrimitiveValue {
    if (!(node.bind instanceof TypeVarBindNode)) {
        throw new StaticPrimitiveEvalError("static primitive evaluation only supports typed local var bindings");
    }
    const value: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(node.value, env);
    if (!isPrimitivePayloadValue(value)) {
        throw new StaticPrimitiveEvalError(`local var '${node.bind.var.name}' does not resolve to a primitive payload`);
    }
    env.defineMutable(node.bind.var.name, value);
    return value;
}

function evaluateAssignment(node: SetNode, env: StaticEvalEnv): StaticPrimitiveValue {
    const value: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(node.value, env);
    if (!isPrimitivePayloadValue(value)) {
        throw new StaticPrimitiveEvalError(`assignment to '${node.identifier.name}' does not resolve to a primitive payload`);
    }
    env.assign(node.identifier.name, value);
    return StaticPrimitiveValue.unit();
}

function evaluateCall(node: FunctionCallNode, env: StaticEvalEnv): StaticPrimitiveValue {
    if (!(node.callee instanceof IdentifierNode)) {
        throw new StaticPrimitiveEvalError("static primitive global initializer only supports direct builtin calls");
    }
    const normalizedName: string = normalizeStaticBuiltinCallName(node.callee.name);
    if (!isSupportedStaticBuiltinCallName(normalizedName)) {
        throw new StaticPrimitiveEvalError(`function call '${node.callee.name}' is not part of the static primitive global initializer subset`);
    }
    const args: StaticPrimitiveValue[] = node.args.map((arg) => evaluateStaticPrimitiveExpr(arg, env));
    return evaluateBuiltinCall(normalizedName, args);
}

function evaluateStaticPrimitiveExpr(node: AstNode, env: StaticEvalEnv): StaticPrimitiveValue {
    if (node instanceof IdentifierNode) {
        return evaluateIdentifier(node, env);
    }
    if (node instanceof NumberLiteralNode || node instanceof TextDatabaseReferenceNode) {
        return evaluateLiteral(node);
    }
    if (node instanceof LetNode) {
        return evaluateLet(node, env);
    }
    if (node instanceof IfNode) {
        const conditionValue: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(node.condExpr, env);
        return conditionValue.expectBoolean("if condition")
            ? evaluateStaticPrimitiveExpr(node.trueBranchExpr, env)
            : evaluateStaticPrimitiveExpr(node.falseBranchExpr, env);
    }
    if (node instanceof CondNode) {
        return evaluateCond(node, env);
    }
    if (node instanceof SeqNode) {
        return evaluateSeq(node, env);
    }
    if (node instanceof DvarNode) {
        return evaluateLocalVar(node, env);
    }
    if (node instanceof SetNode) {
        return evaluateAssignment(node, env);
    }
    if (node instanceof FunctionCallNode) {
        return evaluateCall(node, env);
    }
    if (node instanceof WhileNode) {
        throw new StaticPrimitiveEvalError("while is not allowed in a static primitive global initializer");
    }
    if (node instanceof MatchNode) {
        throw new StaticPrimitiveEvalError("match is not allowed in a static primitive global initializer");
    }
    throw new StaticPrimitiveEvalError(`node kind '${node.constructor.name}' is not allowed in a static primitive global initializer`);
}

export function evaluateStaticPrimitiveInitializer(node: AstNode): StaticPrimitiveValue {
    const rootEnv: StaticEvalEnv = new StaticEvalEnv();
    const value: StaticPrimitiveValue = evaluateStaticPrimitiveExpr(node, rootEnv);
    if (!isPrimitivePayloadValue(value)) {
        throw new StaticPrimitiveEvalError(`initializer did not resolve to a primitive payload; got ${value.typeName}`);
    }
    if (isStringTypeName(value.typeName) || isCharacterTypeName(value.typeName)) {
        const textValue: string = value.expectText("static text payload");
        if (isCharacterTypeName(value.typeName) && textValue.length !== 1) {
            throw new StaticPrimitiveEvalError(`character payload '${value.typeName}' must contain exactly one code unit`);
        }
        return value;
    }
    if (isComplexTypeName(value.typeName)) {
        value.expectComplex("static complex payload");
        return value;
    }
    if (value.typeName === "bool") {
        value.expectBoolean("static bool payload");
        return value;
    }
    if (value.typeName === "unit") {
        if (!value.isUnit) {
            throw new StaticPrimitiveEvalError("unit payload must evaluate to unit");
        }
        return value;
    }
    value.expectNumeric("static numeric payload");
    return value;
}
