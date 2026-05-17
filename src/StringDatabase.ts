import { readFileSync } from "fs";
import { ProgramNode } from "./AstNode";

export type StringDatabaseEntry = string;
export type StringDatabase = ReadonlyMap<string, StringDatabaseEntry>;

export interface PackageStringDatabaseRecord {
    readonly packageName: string;
    readonly bundleName: string;
    readonly exportedName: string;
    readonly canonicalName: string;
    readonly value: StringDatabaseEntry;
    readonly filePath: string;
}

export interface PackageStringDatabaseBundle {
    readonly stem: string;
    readonly packageName: string;
    readonly bundleName: string;
    readonly filePath: string;
    readonly records: readonly PackageStringDatabaseRecord[];
}

export interface ProgramPackageStringDatabase {
    readonly entries: ReadonlyMap<string, StringDatabaseEntry>;
    readonly records: readonly PackageStringDatabaseRecord[];
}

const PACKAGE_DB_FILE_STEM_PATTERN: RegExp = /^([a-zA-Z][a-zA-Z0-9_]*(?:~[a-zA-Z][a-zA-Z0-9_]*)*)\$([a-zA-Z][a-zA-Z0-9_]*)$/;
const PACKAGE_DB_ENTRY_KEY_PATTERN: RegExp = /^([a-zA-Z][a-zA-Z0-9_]*)\^([a-zA-Z][a-zA-Z0-9_]*)$/;
const annotatedProgramPackageStringDb: WeakMap<ProgramNode, ProgramPackageStringDatabase> = new WeakMap();

export function isPackageStringDatabaseStem(stem: string): boolean {
    return PACKAGE_DB_FILE_STEM_PATTERN.test(stem);
}

function parsePackageStringDatabaseStem(stem: string): { packageName: string; bundleName: string } {
    const match = stem.match(PACKAGE_DB_FILE_STEM_PATTERN);
    if (match === null) {
        throw new Error(`Invalid package db file stem '${stem}': expected '<package-path>$<db-name>'`);
    }
    return {
        packageName: match[1],
        bundleName: match[2]
    };
}

export function parsePackageStringDatabaseText(text: string, stem: string, filePath: string): PackageStringDatabaseBundle {
    const { packageName, bundleName } = parsePackageStringDatabaseStem(stem);

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid package db JSON '${filePath}': ${reason}`);
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error(`Invalid package db JSON '${filePath}': expected a top-level object`);
    }

    const entries = Object.entries(parsed);
    if (entries.length === 0) {
        throw new Error(`Invalid package db JSON '${filePath}': expected at least one header kv pair`);
    }

    const [, alignmentValue] = entries[0];
    if (typeof alignmentValue !== "string") {
        throw new Error(`Invalid package db JSON '${filePath}': first kv pair value must be the file stem string '${stem}'`);
    }
    if (alignmentValue !== stem) {
        throw new Error(`Invalid package db JSON '${filePath}': first kv pair value '${alignmentValue}' must match file stem '${stem}'`);
    }

    const records: PackageStringDatabaseRecord[] = [];
    const seenKeys = new Set<string>();
    for (const [key, value] of entries.slice(1)) {
        const match = key.match(PACKAGE_DB_ENTRY_KEY_PATTERN);
        if (match === null) {
            throw new Error(`Invalid package db JSON '${filePath}': entry key '${key}' must use 'referenceId^type' syntax`);
        }
        if (typeof value !== "string") {
            throw new Error(`Invalid package db JSON '${filePath}': entry '${key}' must map to a string value`);
        }
        if (seenKeys.has(key)) {
            throw new Error(`Invalid package db JSON '${filePath}': duplicate entry key '${key}'`);
        }
        seenKeys.add(key);
        records.push({
            packageName,
            bundleName,
            exportedName: key,
            canonicalName: `${packageName}$${key}`,
            value,
            filePath,
        });
    }

    return {
        stem,
        packageName,
        bundleName,
        filePath,
        records,
    };
}

export function loadPackageStringDatabaseFile(filePath: string, stem: string): PackageStringDatabaseBundle {
    return parsePackageStringDatabaseText(readFileSync(filePath, "utf8"), stem, filePath);
}

export function buildProgramPackageStringDatabase(bundles: readonly PackageStringDatabaseBundle[]): ProgramPackageStringDatabase {
    const entries = new Map<string, StringDatabaseEntry>();
    const records: PackageStringDatabaseRecord[] = [];
    const seenCanonicalNames = new Map<string, PackageStringDatabaseRecord>();

    for (const bundle of bundles) {
        for (const record of bundle.records) {
            const existing = seenCanonicalNames.get(record.canonicalName);
            if (existing !== undefined) {
                throw new Error(`Duplicate package db reference '${record.canonicalName}' in ${existing.filePath} and ${record.filePath}`);
            }
            seenCanonicalNames.set(record.canonicalName, record);
            entries.set(record.canonicalName, record.value);
            records.push(record);
        }
    }

    return { entries, records };
}

export function annotateProgramPackageStringDatabase(program: ProgramNode, database: ProgramPackageStringDatabase): void {
    annotatedProgramPackageStringDb.set(program, database);
}

export function getAnnotatedProgramPackageStringDatabase(program: ProgramNode): ProgramPackageStringDatabase | undefined {
    return annotatedProgramPackageStringDb.get(program);
}