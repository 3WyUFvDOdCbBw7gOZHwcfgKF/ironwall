export interface LinuxCGcLayoutArtifact {
    readonly className: string;
    readonly runtimeTypeTagId: string;
    readonly propertyOrder: readonly string[];
}

export interface LinuxCGcMetadataArtifact {
    readonly displayName: string;
}

export interface LinuxCGcFrameDescriptorArtifact {
    readonly key: string;
    readonly structName: string;
    readonly metadataCanonicalName: string;
    readonly rootNames: readonly string[];
}

export interface LinuxCGcGlobalDescriptorArtifact {
    readonly livePrinterSymbolName: string;
    readonly blockSymbolName: string;
    readonly fieldOrder: readonly string[];
}

export interface LinuxCGcPrintPassCodegen {
    readonly layouts: ReadonlyMap<string, LinuxCGcLayoutArtifact>;
    readonly gcFrameDescriptors: ReadonlyMap<string, LinuxCGcFrameDescriptorArtifact>;
    readonly gcMetadataByCanonicalName: ReadonlyMap<string, LinuxCGcMetadataArtifact>;
}

export interface LinuxCGcPrintPassDependencies {
    readonly cFieldName: (name: string) => string;
    readonly cGlobalName: (name: string) => string;
    readonly cStringLiteral: (text: string) => string;
    readonly cStructName: (name: string) => string;
    readonly runtimeTypeTagLiteral: (runtimeTypeTagId: string) => string;
}

export interface LinuxCGcCollectCoreOptions {
    readonly globalInitLines: readonly string[];
    readonly linkedRuntimeInitSymbols?: readonly string[];
    readonly exportedRuntimeInitSymbol?: string;
    readonly exportedRuntimeInitCallLine?: string;
}