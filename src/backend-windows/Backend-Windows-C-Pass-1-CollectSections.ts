export interface WindowsCBackendCommonSourceSections {
    readonly builtinHelpers: string;
    readonly classRuntime: string;
    readonly gcFrameRuntime: string;
    readonly runtimeDescriptors: string;
    readonly gcMetadataRuntime: string;
    readonly globalRuntime: string;
    readonly stdSysFfiRuntime: string;
    readonly declaredCHeapHostHelperRuntime: string;
    readonly exportedIwFunctionRuntime: string;
    readonly gcRuntimeSupport: string;
    readonly closureRuntime: string;
    readonly textRuntime: string;
    readonly normalizedExtraSupportSource: string;
}

export interface WindowsCBackendSourcePass1Input {
    readonly builtinHelpers: string;
    readonly classRuntime: string;
    readonly gcFrameRuntime: string;
    readonly runtimeDescriptors: string;
    readonly gcMetadataRuntime: string;
    readonly globalRuntime: string;
    readonly stdSysFfiRuntime: string;
    readonly declaredCHeapHostHelperRuntime: string;
    readonly exportedIwFunctionRuntime: string;
    readonly gcRuntimeSupport: string;
    readonly prototypes: string;
    readonly hostArgvRuntime: string;
    readonly hostEntryWrapper: string;
    readonly closureRuntime: string;
    readonly textRuntime: string;
    readonly extraSupportSource: string;
    readonly emittedFunctions: string;
    readonly driverResultType: string;
}

export interface WindowsCBackendSourcePass1Sections extends WindowsCBackendCommonSourceSections {
    readonly prototypes: string;
    readonly hostArgvRuntime: string;
    readonly hostEntryWrapper: string;
    readonly emittedFunctions: string;
    readonly driverResultType: string;
}

export interface WindowsCBackendX64SupportPass1Input {
    readonly builtinHelpers: string;
    readonly classRuntime: string;
    readonly gcFrameRuntime: string;
    readonly runtimeDescriptors: string;
    readonly gcMetadataRuntime: string;
    readonly globalRuntime: string;
    readonly compiledPrototypes: string;
    readonly stdSysFfiRuntime: string;
    readonly declaredCHeapHostHelperRuntime: string;
    readonly exportedIwFunctionRuntime: string;
    readonly gcRuntimeSupport: string;
    readonly hostArgvRuntime: string;
    readonly hostEntryWrapper: string;
    readonly closureRuntime: string;
    readonly textRuntime: string;
    readonly boxedNumberRuntime: string;
    readonly directFunctionRuntime: string;
    readonly extraSupportSource: string;
    readonly supportWrappers: string;
    readonly omitRuntimeInit: boolean;
}

export interface WindowsCBackendX64SupportPass1Sections extends WindowsCBackendCommonSourceSections {
    readonly compiledPrototypes: string;
    readonly hostArgvRuntime: string;
    readonly hostEntryWrapper: string;
    readonly boxedNumberRuntime: string;
    readonly directFunctionRuntime: string;
    readonly supportWrappers: string;
    readonly omitRuntimeInit: boolean;
}

export function performWindowsCBackendSourcePass1CollectSections(
    input: WindowsCBackendSourcePass1Input
): WindowsCBackendSourcePass1Sections {
    return {
        builtinHelpers: input.builtinHelpers,
        classRuntime: input.classRuntime,
        gcFrameRuntime: input.gcFrameRuntime,
        runtimeDescriptors: input.runtimeDescriptors,
        gcMetadataRuntime: input.gcMetadataRuntime,
        globalRuntime: input.globalRuntime,
        stdSysFfiRuntime: input.stdSysFfiRuntime,
        declaredCHeapHostHelperRuntime: input.declaredCHeapHostHelperRuntime,
        exportedIwFunctionRuntime: input.exportedIwFunctionRuntime,
        gcRuntimeSupport: input.gcRuntimeSupport,
        prototypes: input.prototypes,
        hostArgvRuntime: input.hostArgvRuntime,
        hostEntryWrapper: input.hostEntryWrapper,
        closureRuntime: input.closureRuntime,
        textRuntime: input.textRuntime,
        normalizedExtraSupportSource: input.extraSupportSource.trim(),
        emittedFunctions: input.emittedFunctions,
        driverResultType: input.driverResultType
    };
}

export function performWindowsCBackendX64SupportPass1CollectSections(
    input: WindowsCBackendX64SupportPass1Input
): WindowsCBackendX64SupportPass1Sections {
    return {
        builtinHelpers: input.builtinHelpers,
        classRuntime: input.classRuntime,
        gcFrameRuntime: input.gcFrameRuntime,
        runtimeDescriptors: input.runtimeDescriptors,
        gcMetadataRuntime: input.gcMetadataRuntime,
        globalRuntime: input.globalRuntime,
        compiledPrototypes: input.compiledPrototypes,
        stdSysFfiRuntime: input.stdSysFfiRuntime,
        declaredCHeapHostHelperRuntime: input.declaredCHeapHostHelperRuntime,
        exportedIwFunctionRuntime: input.exportedIwFunctionRuntime,
        gcRuntimeSupport: input.gcRuntimeSupport,
        hostArgvRuntime: input.hostArgvRuntime,
        hostEntryWrapper: input.hostEntryWrapper,
        closureRuntime: input.closureRuntime,
        textRuntime: input.textRuntime,
        boxedNumberRuntime: input.boxedNumberRuntime,
        directFunctionRuntime: input.directFunctionRuntime,
        normalizedExtraSupportSource: input.extraSupportSource.trim(),
        supportWrappers: input.supportWrappers,
        omitRuntimeInit: input.omitRuntimeInit
    };
}