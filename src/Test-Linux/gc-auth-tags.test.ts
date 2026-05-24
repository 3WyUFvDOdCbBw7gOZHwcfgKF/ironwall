/* GC tagged-block schema and collision regression. */

import { ok, strictEqual } from "assert";
import { join, resolve } from "path";
import { getBaseLibSourceRoots } from "../BaseLib";
import { performNoOptimizeCBackendLoweringStageCFromArtifacts } from "../Lowering-NoOptimize-Pass-10-PackageBackendIR";
import { loadProgramAst } from "../ModuleLoader";
import { performTypeChecking } from "../Typecheck-Pipeline";
import { hashText } from "../Typecheck-Core";
import {
    debugBuildGcAuthSnapshotFromFinalBackendIR,
    type GcAuthSnapshot,
    type GcAuthSnapshotEntry
} from "../backend-linux/Backend-Linux-C";

interface SyntheticAuthEntry {
    readonly canonicalName: string;
    readonly firstTagHex: string;
    readonly endConfirmationHex: string;
}

const U64_MASK = 0xffffffffffffffffn;
const GC_HASH_COMBINE_CONST = 0x9e3779b97f4a7c15n;
const GC_TAG1_CONFIRMATION_SEED = 0xa5c9d3e17b2f0461n;
const GC_END_CONFIRMATION_SEED = 0x6a09e667f3bcc909n;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test", "Fixtures", "gc-table-collection");
const entryUnitId = "test~gc~table~collection~app@main";
const SYNTHETIC_SAMPLE_COUNT = 100000;
const SYNTHETIC_TABLE_COUNT = 64;

function deterministicHex(namespace: string, seed: string): string {
    return hashText(`${namespace}<${seed}>`);
}

function mixU64BigInt(value: bigint): bigint {
    let mixed: bigint = value & U64_MASK;
    mixed ^= mixed >> 33n;
    mixed = (mixed * 0xff51afd7ed558ccdn) & U64_MASK;
    mixed ^= mixed >> 33n;
    mixed = (mixed * 0xc4ceb9fe1a85ec53n) & U64_MASK;
    mixed ^= mixed >> 33n;
    return mixed & U64_MASK;
}

function combineU64BigInt(state: bigint, word: bigint): bigint {
    return mixU64BigInt((state ^ word ^ GC_HASH_COMBINE_CONST) & U64_MASK);
}

function u64BigIntToHex(value: bigint): string {
    return (value & U64_MASK).toString(16).padStart(16, "0");
}

function confirmation16Hex(structHash48Hex: string): string {
    const confirmation: bigint = mixU64BigInt(BigInt(`0x${structHash48Hex}`) ^ GC_TAG1_CONFIRMATION_SEED) & 0xffffn;
    return confirmation.toString(16).padStart(4, "0");
}

function structUuidHiHex(tableKey: string, canonicalName: string): string {
    return deterministicHex("gc-struct-uuid-hi", `${tableKey}|${canonicalName}`);
}

function structUuidLoHex(tableKey: string, canonicalName: string): string {
    return deterministicHex("gc-struct-uuid-lo", `${tableKey}|${canonicalName}`);
}

function structHash48Hex(tableKey: string, canonicalName: string): string {
    return deterministicHex("gc-struct-uuid-h48", `${structUuidHiHex(tableKey, canonicalName)}|${structUuidLoHex(tableKey, canonicalName)}`).slice(0, 12);
}

function firstTagHex(tableKey: string, canonicalName: string): string {
    const prefixHex: string = structHash48Hex(tableKey, canonicalName);
    return `${prefixHex}${confirmation16Hex(prefixHex)}`;
}

function syntheticSchemaHashHex(tableKey: string, canonicalName: string): string {
    return deterministicHex("gc-auth-test-static-info", `${tableKey}|${canonicalName}`);
}

function endConfirmationHex(tableKey: string, canonicalName: string): string {
    let state: bigint = GC_END_CONFIRMATION_SEED;
    state = combineU64BigInt(state, BigInt(`0x${structUuidHiHex(tableKey, canonicalName)}`));
    state = combineU64BigInt(state, BigInt(`0x${structUuidLoHex(tableKey, canonicalName)}`));
    state = combineU64BigInt(state, BigInt(`0x${syntheticSchemaHashHex(tableKey, canonicalName)}`));
    return u64BigIntToHex(state);
}

function buildSyntheticEntry(tableKey: string, canonicalName: string): SyntheticAuthEntry {
    return {
        canonicalName,
        firstTagHex: firstTagHex(tableKey, canonicalName),
        endConfirmationHex: endConfirmationHex(tableKey, canonicalName)
    };
}

function buildSnapshot(): GcAuthSnapshot {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots()
    });
    performTypeChecking(ast, {
        disableBaseLibAutoLoad: false
    });
    const stageC = performNoOptimizeCBackendLoweringStageCFromArtifacts(ast, {
        disableBaseLibAutoLoad: false,
        entryUnitId,
        requireEntryPoint: true
    });
    return debugBuildGcAuthSnapshotFromFinalBackendIR(stageC.pass10);
}

function lookupEntry(
    entries: readonly GcAuthSnapshotEntry[],
    firstTagValueHex: string,
    endConfirmationValueHex: string
): GcAuthSnapshotEntry | undefined {
    return entries.find((entry) => entry.firstTagHex === firstTagValueHex && entry.endConfirmationHex === endConfirmationValueHex);
}

function validateSnapshot(snapshot: GcAuthSnapshot): void {
    const tableHashes: Set<string> = new Set<string>();
    const finalKeys: Set<string> = new Set<string>();
    for (const table of snapshot.tables) {
        ok(table.uuidHash64Hex.length === 16, `table UUID hash should be 64-bit hex: ${table.key}`);
        ok(!tableHashes.has(table.uuidHash64Hex), `unexpected table UUID hash collision in real snapshot: ${table.key}`);
        tableHashes.add(table.uuidHash64Hex);
    }
    for (const entry of snapshot.entries) {
        strictEqual(entry.firstTagHex.length, 16, `first tag should be 64-bit hex: ${entry.canonicalName}`);
        strictEqual(entry.endConfirmationHex.length, 16, `end confirmation should be 64-bit hex: ${entry.canonicalName}`);
        strictEqual(entry.firstTagConfirmation16Hex, confirmation16Hex(entry.firstTagStructHash48Hex), `first-tag confirmation mismatch: ${entry.canonicalName}`);
        const finalKey: string = `${entry.firstTagHex}|${entry.endConfirmationHex}`;
        ok(!finalKeys.has(finalKey), `unexpected final tagged-block key collision in real snapshot: ${entry.canonicalName}`);
        finalKeys.add(finalKey);
    }
}

function exerciseForcedCollisionLookups(snapshot: GcAuthSnapshot): void {
    const left: GcAuthSnapshotEntry = snapshot.entries[0];
    const right: GcAuthSnapshotEntry | undefined = snapshot.entries.find((entry) => entry.endConfirmationHex !== left.endConfirmationHex);
    if (right === undefined) {
        throw new Error("gc-auth-tags test requires at least two distinct metadata entries");
    }

    const forcedCollisionEntries: readonly GcAuthSnapshotEntry[] = [
        left,
        {
            ...right,
            firstTagHex: left.firstTagHex,
            firstTagStructHash48Hex: left.firstTagStructHash48Hex,
            firstTagConfirmation16Hex: left.firstTagConfirmation16Hex
        }
    ];
    strictEqual(
        lookupEntry(forcedCollisionEntries, left.firstTagHex, right.endConfirmationHex)?.canonicalName,
        right.canonicalName,
        "first-tag collision should be disambiguated by end confirmation"
    );
}

function exerciseSyntheticStress(): void {
    const finalKeys: Set<string> = new Set<string>();
    let finalKeyCollisionCount = 0;

    for (let index = 0; index < SYNTHETIC_SAMPLE_COUNT; index += 1) {
        const tableKey: string = `stress-table-${index % SYNTHETIC_TABLE_COUNT}`;
        const canonicalName: string = `heap:stress:${Math.floor(index / SYNTHETIC_TABLE_COUNT)}:${index % SYNTHETIC_TABLE_COUNT}`;
        const entry: SyntheticAuthEntry = buildSyntheticEntry(tableKey, canonicalName);
        const finalKey: string = `${entry.firstTagHex}|${entry.endConfirmationHex}`;
        if (finalKeys.has(finalKey)) {
            finalKeyCollisionCount += 1;
        } else {
            finalKeys.add(finalKey);
        }
    }

    strictEqual(finalKeyCollisionCount, 0, `synthetic final tagged-block key collisions should be absent in ${SYNTHETIC_SAMPLE_COUNT} samples`);
}

const snapshot: GcAuthSnapshot = buildSnapshot();
validateSnapshot(snapshot);
exerciseForcedCollisionLookups(snapshot);
exerciseSyntheticStress();

process.stdout.write("gc-auth-tags schema and stress ok\n");