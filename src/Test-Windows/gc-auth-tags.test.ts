/* GC auth tag schema and collision regression. */

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
    readonly tableKey: string;
    readonly canonicalName: string;
    readonly firstTagHex: string;
    readonly structUuidHash64Hex: string;
    readonly tableUuidHash64Hex: string;
}

const U64_MASK = 0xffffffffffffffffn;
const GC_TAG1_CONFIRMATION_SEED = 0xa5c9d3e17b2f0461n;
const repoRoot = resolve(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "src", "Test-Windows", "Fixtures", "gc-table-collection");
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

function confirmation16Hex(structHash48Hex: string): string {
    const confirmation: bigint = mixU64BigInt(BigInt(`0x${structHash48Hex}`) ^ GC_TAG1_CONFIRMATION_SEED) & 0xffffn;
    return confirmation.toString(16).padStart(4, "0");
}

function tableUuidHiHex(tableKey: string): string {
    return deterministicHex("gc-metadata-table-uuid-hi", tableKey);
}

function tableUuidLoHex(tableKey: string): string {
    return deterministicHex("gc-metadata-table-uuid-lo", tableKey);
}

function tableUuidHash64Hex(tableKey: string): string {
    return deterministicHex("gc-metadata-table-uuid-h64", `${tableUuidHiHex(tableKey)}|${tableUuidLoHex(tableKey)}`);
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

function structHash64Hex(tableKey: string, canonicalName: string): string {
    return deterministicHex("gc-struct-uuid-h64", `${structUuidHiHex(tableKey, canonicalName)}|${structUuidLoHex(tableKey, canonicalName)}`);
}

function firstTagHex(tableKey: string, canonicalName: string): string {
    const prefixHex: string = structHash48Hex(tableKey, canonicalName);
    return `${prefixHex}${confirmation16Hex(prefixHex)}`;
}

function buildSyntheticEntry(tableKey: string, canonicalName: string): SyntheticAuthEntry {
    return {
        tableKey,
        canonicalName,
        firstTagHex: firstTagHex(tableKey, canonicalName),
        structUuidHash64Hex: structHash64Hex(tableKey, canonicalName),
        tableUuidHash64Hex: tableUuidHash64Hex(tableKey)
    };
}

function buildSnapshot(): GcAuthSnapshot {
    const ast = loadProgramAst(fixtureDir, {
        additionalInputPaths: getBaseLibSourceRoots("windows-x64")
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
    structUuidHashValueHex: string,
    tableUuidHashValueHex: string
): GcAuthSnapshotEntry | undefined {
    const matchingTableEntries: GcAuthSnapshotEntry[] = entries.filter((entry) => entry.firstTagHex === firstTagValueHex && entry.tableUuidHash64Hex === tableUuidHashValueHex);
    if (matchingTableEntries.length === 0) {
        return undefined;
    }
    return matchingTableEntries.find((entry) => entry.structUuidHash64Hex === structUuidHashValueHex);
}

function validateSnapshot(snapshot: GcAuthSnapshot): void {
    const tableHashes: Set<string> = new Set<string>();
    const fullKeys: Set<string> = new Set<string>();
    for (const table of snapshot.tables) {
        ok(table.uuidHash64Hex.length === 16, `table UUID hash should be 64-bit hex: ${table.key}`);
        ok(!tableHashes.has(table.uuidHash64Hex), `unexpected table UUID hash collision in real snapshot: ${table.key}`);
        tableHashes.add(table.uuidHash64Hex);
    }
    for (const entry of snapshot.entries) {
        strictEqual(entry.firstTagHex.length, 16, `first tag should be 64-bit hex: ${entry.canonicalName}`);
        strictEqual(entry.structUuidHash64Hex.length, 16, `struct UUID hash should be 64-bit hex: ${entry.canonicalName}`);
        strictEqual(entry.tableUuidHash64Hex.length, 16, `table UUID hash should be 64-bit hex: ${entry.canonicalName}`);
        strictEqual(entry.firstTagConfirmation16Hex, confirmation16Hex(entry.firstTagStructHash48Hex), `first-tag confirmation mismatch: ${entry.canonicalName}`);
        const fullKey: string = `${entry.firstTagHex}|${entry.structUuidHash64Hex}|${entry.tableUuidHash64Hex}`;
        ok(!fullKeys.has(fullKey), `unexpected full GC auth key collision in real snapshot: ${entry.canonicalName}`);
        fullKeys.add(fullKey);
    }
}

function exerciseForcedCollisionLookups(snapshot: GcAuthSnapshot): void {
    const left: GcAuthSnapshotEntry = snapshot.entries[0];
    const right: GcAuthSnapshotEntry | undefined = snapshot.entries.find((entry) => entry.tableUuidHash64Hex !== left.tableUuidHash64Hex);
    if (right === undefined) {
        throw new Error("gc-auth-tags test requires at least two metadata tables");
    }

    const crossTableEntries: readonly GcAuthSnapshotEntry[] = [
        left,
        {
            ...right,
            firstTagHex: left.firstTagHex,
            firstTagStructHash48Hex: left.firstTagStructHash48Hex,
            firstTagConfirmation16Hex: left.firstTagConfirmation16Hex
        }
    ];
    strictEqual(
        lookupEntry(crossTableEntries, left.firstTagHex, right.structUuidHash64Hex, right.tableUuidHash64Hex)?.canonicalName,
        right.canonicalName,
        "cross-table first-tag collision should be rejected by table UUID hash"
    );

    const forcedSameTableStructHash: string = deterministicHex("gc-auth-test-forced-struct-h64", `${left.canonicalName}|same-table`);
    const sameTableEntries: readonly GcAuthSnapshotEntry[] = [
        left,
        {
            ...left,
            canonicalName: `${left.canonicalName}#forced-same-table`,
            structUuidHash64Hex: forcedSameTableStructHash
        }
    ];
    strictEqual(
        lookupEntry(sameTableEntries, left.firstTagHex, forcedSameTableStructHash, left.tableUuidHash64Hex)?.canonicalName,
        `${left.canonicalName}#forced-same-table`,
        "same-table first-tag collision should be rejected by struct UUID hash"
    );
}

function exerciseSyntheticStress(): void {
    const firstTags: Set<string> = new Set<string>();
    const fullKeys: Set<string> = new Set<string>();
    let firstTagCollisionCount = 0;
    let fullKeyCollisionCount = 0;

    for (let index = 0; index < SYNTHETIC_SAMPLE_COUNT; index += 1) {
        const tableKey: string = `stress-table-${index % SYNTHETIC_TABLE_COUNT}`;
        const canonicalName: string = `heap:stress:${Math.floor(index / SYNTHETIC_TABLE_COUNT)}:${index % SYNTHETIC_TABLE_COUNT}`;
        const entry: SyntheticAuthEntry = buildSyntheticEntry(tableKey, canonicalName);
        if (firstTags.has(entry.firstTagHex)) {
            firstTagCollisionCount += 1;
        } else {
            firstTags.add(entry.firstTagHex);
        }
        const fullKey: string = `${entry.firstTagHex}|${entry.structUuidHash64Hex}|${entry.tableUuidHash64Hex}`;
        if (fullKeys.has(fullKey)) {
            fullKeyCollisionCount += 1;
        } else {
            fullKeys.add(fullKey);
        }
    }

    strictEqual(firstTagCollisionCount, 0, `synthetic first-tag collisions should be absent in ${SYNTHETIC_SAMPLE_COUNT} samples`);
    strictEqual(fullKeyCollisionCount, 0, `synthetic full GC auth key collisions should be absent in ${SYNTHETIC_SAMPLE_COUNT} samples`);
}

const snapshot: GcAuthSnapshot = buildSnapshot();
validateSnapshot(snapshot);
exerciseForcedCollisionLookups(snapshot);
exerciseSyntheticStress();

process.stdout.write("gc-auth-tags schema and stress ok\n");