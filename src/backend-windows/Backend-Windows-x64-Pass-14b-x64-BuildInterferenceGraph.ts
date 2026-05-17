// x64 optimized backend pass 14b: build a bank-aware interference graph from live intervals.

import type {
    X64InterferenceBody,
    X64InterferenceFunctionDefinition,
    X64InterferenceGraphNode,
    X64InterferenceProgram,
    X64LivenessFunctionDefinition,
    X64LivenessInterval,
    X64LivenessProgram
} from "./Backend-Windows-IR-Shared";

function intervalsOverlap(left: X64LivenessInterval, right: X64LivenessInterval): boolean {
    return left.start <= right.end && right.start <= left.end;
}

function buildGraphNodes(intervals: readonly X64LivenessInterval[]): readonly X64InterferenceGraphNode[] {
    const neighborsByName: Map<string, Set<string>> = new Map<string, Set<string>>();
    for (const interval of intervals) {
        neighborsByName.set(interval.name, new Set<string>());
    }
    let leftIndex: number = 0;
    while (leftIndex < intervals.length) {
        const leftInterval: X64LivenessInterval = intervals[leftIndex];
        let rightIndex: number = leftIndex + 1;
        while (rightIndex < intervals.length) {
            const rightInterval: X64LivenessInterval = intervals[rightIndex];
            if (leftInterval.bank === rightInterval.bank && intervalsOverlap(leftInterval, rightInterval)) {
                const leftNeighbors: Set<string> | undefined = neighborsByName.get(leftInterval.name);
                const rightNeighbors: Set<string> | undefined = neighborsByName.get(rightInterval.name);
                if (leftNeighbors) {
                    leftNeighbors.add(rightInterval.name);
                }
                if (rightNeighbors) {
                    rightNeighbors.add(leftInterval.name);
                }
            }
            rightIndex += 1;
        }
        leftIndex += 1;
    }

    const graphNodes: X64InterferenceGraphNode[] = [];
    for (const interval of intervals) {
        const neighbors: string[] = [...(neighborsByName.get(interval.name) ?? new Set<string>())].sort((left: string, right: string) => left.localeCompare(right));
        graphNodes.push({
            name: interval.name,
            bank: interval.bank,
            mustSpill: interval.mustSpill,
            neighbors
        });
    }
    graphNodes.sort((left: X64InterferenceGraphNode, right: X64InterferenceGraphNode) => left.name.localeCompare(right.name));
    return graphNodes;
}

function buildBody(body: X64LivenessProgram["entry"]): X64InterferenceBody {
    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        blocks: body.blocks,
        blockSummaries: body.blockSummaries,
        callPositions: body.callPositions,
        intervals: body.intervals,
        graphNodes: buildGraphNodes(body.intervals)
    };
}

function buildFunction(fn: X64LivenessFunctionDefinition): X64InterferenceFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: buildBody(fn.body),
        origin: fn.origin
    };
}

export function buildInterferenceGraphX64Pass(program: X64LivenessProgram): X64InterferenceProgram {
    return {
        kind: "x64_interference_program",
        entry: buildBody(program.entry),
        globals: program.globals,
        functions: program.functions.map((fn: X64LivenessFunctionDefinition) => buildFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}