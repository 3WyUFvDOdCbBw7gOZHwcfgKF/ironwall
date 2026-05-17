import { createHash } from "crypto";
import { readFileSync } from "fs";

export interface IronwallVersionJson {
    readonly version: string;
    readonly uuid: string;
    readonly checksum: string;
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const checksumPattern = /^[0-9a-f]{64}$/;

export function computeIronwallVersionChecksum(version: string, uuid: string): string {
    return createHash("sha256").update(`${version}${uuid}`, "utf8").digest("hex");
}

function requireStringField(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`version.json field '${fieldName}' must be a non-empty string`);
    }
    return value;
}

export function validateIronwallVersionJson(value: unknown): IronwallVersionJson {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("version.json must be a JSON object");
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = ["checksum", "uuid", "version"];
    if (keys.join(",") !== expectedKeys.join(",")) {
        throw new Error(`version.json must contain exactly these fields: ${expectedKeys.join(", ")}`);
    }

    const version = requireStringField(record.version, "version");
    const uuid = requireStringField(record.uuid, "uuid");
    const checksum = requireStringField(record.checksum, "checksum");

    if (!versionPattern.test(version)) {
        throw new Error(`version.json field 'version' is not a supported semantic version: ${version}`);
    }
    if (!uuidPattern.test(uuid)) {
        throw new Error(`version.json field 'uuid' is not a lowercase UUID: ${uuid}`);
    }
    if (!checksumPattern.test(checksum)) {
        throw new Error("version.json field 'checksum' must be a lowercase sha256 hex digest");
    }

    const expectedChecksum = computeIronwallVersionChecksum(version, uuid);
    if (checksum !== expectedChecksum) {
        throw new Error(`version.json checksum mismatch: expected ${expectedChecksum}, got ${checksum}`);
    }

    return { version, uuid, checksum };
}

export function loadIronwallVersionJson(path: string): IronwallVersionJson {
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid version.json '${path}': ${message}`);
    }
    return validateIronwallVersionJson(parsedJson);
}
