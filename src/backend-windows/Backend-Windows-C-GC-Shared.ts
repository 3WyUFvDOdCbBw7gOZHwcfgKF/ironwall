export interface WindowsCGcLayoutArtifact {
    readonly className: string;
    readonly runtimeTypeTagId: string;
    readonly propertyOrder: readonly string[];
}

export interface WindowsCGcMetadataArtifact {
    readonly displayName: string;
}

export interface WindowsCGcFrameDescriptorArtifact {
    readonly key: string;
    readonly structName: string;
    readonly metadataCanonicalName: string;
    readonly rootNames: readonly string[];
}

export interface WindowsCGcGlobalDescriptorArtifact {
    readonly livePrinterSymbolName: string;
    readonly blockSymbolName: string;
    readonly fieldOrder: readonly string[];
}

export interface WindowsCGcPrintPassCodegen {
    readonly layouts: ReadonlyMap<string, WindowsCGcLayoutArtifact>;
    readonly gcFrameDescriptors: ReadonlyMap<string, WindowsCGcFrameDescriptorArtifact>;
    readonly gcMetadataByCanonicalName: ReadonlyMap<string, WindowsCGcMetadataArtifact>;
}

export interface WindowsCGcPrintPassDependencies {
    readonly cFieldName: (name: string) => string;
    readonly cGlobalName: (name: string) => string;
    readonly cStringLiteral: (text: string) => string;
    readonly cStructName: (name: string) => string;
    readonly runtimeTypeTagLiteral: (runtimeTypeTagId: string) => string;
}

export interface WindowsCGcCollectCoreOptions {
    readonly globalInitLines: readonly string[];
    readonly linkedRuntimeInitSymbols?: readonly string[];
    readonly exportedRuntimeInitSymbol?: string;
    readonly exportedRuntimeInitCallLine?: string;
}