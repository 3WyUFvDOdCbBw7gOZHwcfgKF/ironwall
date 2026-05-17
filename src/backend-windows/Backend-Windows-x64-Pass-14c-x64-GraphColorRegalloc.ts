// x64 optimized backend pass 14c: color the interference graph and choose stack spills.

import type {
    X64AllocationBody,
    X64AllocationEntry,
    X64AllocationFunctionDefinition,
    X64AllocationProgram,
    X64InterferenceFunctionDefinition,
    X64InterferenceGraphNode,
    X64InterferenceProgram,
    X64LivenessInterval,
    X64MirRegisterBank,
    X64PhysicalRegisterName
} from "./Backend-Windows-IR-Shared";

interface ColorStackEntry {
    readonly name: string;
}

const GPR_ALLOCATABLE: readonly X64PhysicalRegisterName[] = ["rbx", "r12", "r13", "r14", "r15"];
const XMM_ALLOCATABLE: readonly X64PhysicalRegisterName[] = ["xmm8", "xmm9", "xmm10", "xmm11", "xmm12", "xmm13", "xmm14", "xmm15"];

function allocatableRegistersForBank(bank: X64MirRegisterBank): readonly X64PhysicalRegisterName[] {
    if (bank === "gpr") {
        return GPR_ALLOCATABLE;
    }
    return XMM_ALLOCATABLE;
}

function intervalLength(interval: X64LivenessInterval): number {
    return interval.end - interval.start;
}

function compareIntervalNames(
    leftName: string,
    rightName: string,
    intervalByName: ReadonlyMap<string, X64LivenessInterval>,
    nodeByName: ReadonlyMap<string, X64InterferenceGraphNode>,
    neighborMap: ReadonlyMap<string, ReadonlySet<string>>
): number {
    const leftInterval: X64LivenessInterval | undefined = intervalByName.get(leftName);
    const rightInterval: X64LivenessInterval | undefined = intervalByName.get(rightName);
    const leftDegree: number = (neighborMap.get(leftName) ?? new Set<string>()).size;
    const rightDegree: number = (neighborMap.get(rightName) ?? new Set<string>()).size;
    if (leftDegree !== rightDegree) {
        return rightDegree - leftDegree;
    }
    if (leftInterval && rightInterval) {
        const leftLength: number = intervalLength(leftInterval);
        const rightLength: number = intervalLength(rightInterval);
        if (leftLength !== rightLength) {
            return rightLength - leftLength;
        }
        if (leftInterval.start !== rightInterval.start) {
            return leftInterval.start - rightInterval.start;
        }
        if (leftInterval.end !== rightInterval.end) {
            return leftInterval.end - rightInterval.end;
        }
    }
    const leftNode: X64InterferenceGraphNode | undefined = nodeByName.get(leftName);
    const rightNode: X64InterferenceGraphNode | undefined = nodeByName.get(rightName);
    if (leftNode && rightNode && leftNode.mustSpill !== rightNode.mustSpill) {
        return leftNode.mustSpill ? -1 : 1;
    }
    return leftName.localeCompare(rightName);
}

function cloneNeighborMap(nodes: readonly X64InterferenceGraphNode[]): Map<string, Set<string>> {
    const cloned: Map<string, Set<string>> = new Map<string, Set<string>>();
    for (const node of nodes) {
        cloned.set(node.name, new Set<string>(node.neighbors));
    }
    return cloned;
}

function buildColorStack(
    nodes: readonly X64InterferenceGraphNode[],
    intervalByName: ReadonlyMap<string, X64LivenessInterval>,
    registerCount: number
): readonly ColorStackEntry[] {
    const nodeByName: Map<string, X64InterferenceGraphNode> = new Map<string, X64InterferenceGraphNode>();
    for (const node of nodes) {
        nodeByName.set(node.name, node);
    }
    const remainingNeighbors: Map<string, Set<string>> = cloneNeighborMap(nodes);
    const stack: ColorStackEntry[] = [];

    while (remainingNeighbors.size > 0) {
        const candidateNames: string[] = [...remainingNeighbors.keys()].sort((left: string, right: string) => compareIntervalNames(left, right, intervalByName, nodeByName, remainingNeighbors));
        let chosenName: string | null = null;

        for (const candidateName of candidateNames) {
            const degree: number = (remainingNeighbors.get(candidateName) ?? new Set<string>()).size;
            if (degree < registerCount) {
                chosenName = candidateName;
                break;
            }
        }

        if (chosenName === null && candidateNames.length > 0) {
            chosenName = candidateNames[0];
        }
        if (chosenName === null) {
            break;
        }

        stack.push({ name: chosenName });
        remainingNeighbors.delete(chosenName);
        for (const neighbors of remainingNeighbors.values()) {
            neighbors.delete(chosenName);
        }
    }

    return stack;
}

function chooseRegister(
    node: X64InterferenceGraphNode,
    coloredRegisters: ReadonlyMap<string, X64PhysicalRegisterName>
): X64PhysicalRegisterName | null {
    const usedRegisters: Set<X64PhysicalRegisterName> = new Set<X64PhysicalRegisterName>();
    for (const neighborName of node.neighbors) {
        const neighborRegister: X64PhysicalRegisterName | undefined = coloredRegisters.get(neighborName);
        if (neighborRegister) {
            usedRegisters.add(neighborRegister);
        }
    }
    for (const registerName of allocatableRegistersForBank(node.bank)) {
        if (!usedRegisters.has(registerName)) {
            return registerName;
        }
    }
    return null;
}

function allocateBank(
    nodes: readonly X64InterferenceGraphNode[],
    intervalByName: ReadonlyMap<string, X64LivenessInterval>
): readonly X64AllocationEntry[] {
    if (nodes.length === 0) {
        return [];
    }
    const nodeByName: Map<string, X64InterferenceGraphNode> = new Map<string, X64InterferenceGraphNode>();
    for (const node of nodes) {
        nodeByName.set(node.name, node);
    }

    const spillNames: Set<string> = new Set<string>();
    const colorableNodes: X64InterferenceGraphNode[] = [];
    for (const node of nodes) {
        if (node.mustSpill) {
            spillNames.add(node.name);
        } else {
            colorableNodes.push(node);
        }
    }

    const colorStack: readonly ColorStackEntry[] = buildColorStack(colorableNodes, intervalByName, allocatableRegistersForBank(nodes[0].bank).length);
    const coloredRegisters: Map<string, X64PhysicalRegisterName> = new Map<string, X64PhysicalRegisterName>();
    let stackIndex: number = colorStack.length - 1;
    while (stackIndex >= 0) {
        const entry: ColorStackEntry = colorStack[stackIndex];
        const node: X64InterferenceGraphNode | undefined = nodeByName.get(entry.name);
        if (!node) {
            throw new Error(`x64 graph coloring missing node '${entry.name}'`);
        }
        const registerName: X64PhysicalRegisterName | null = chooseRegister(node, coloredRegisters);
        if (registerName === null) {
            spillNames.add(node.name);
        } else {
            coloredRegisters.set(node.name, registerName);
        }
        stackIndex -= 1;
    }

    const assignments: X64AllocationEntry[] = [];
    const coloredNames: string[] = [...coloredRegisters.keys()].sort((left: string, right: string) => left.localeCompare(right));
    for (const name of coloredNames) {
        const interval: X64LivenessInterval | undefined = intervalByName.get(name);
        const registerName: X64PhysicalRegisterName | undefined = coloredRegisters.get(name);
        if (!interval || !registerName) {
            throw new Error(`x64 graph coloring missing colored interval '${name}'`);
        }
        assignments.push({
            name,
            operand: {
                kind: "preg",
                name: registerName,
                bank: interval.bank
            }
        });
    }

    const orderedSpillNames: string[] = [...spillNames].sort((left: string, right: string) => {
        const leftInterval: X64LivenessInterval | undefined = intervalByName.get(left);
        const rightInterval: X64LivenessInterval | undefined = intervalByName.get(right);
        if (leftInterval && rightInterval) {
            if (leftInterval.start !== rightInterval.start) {
                return leftInterval.start - rightInterval.start;
            }
            if (leftInterval.end !== rightInterval.end) {
                return leftInterval.end - rightInterval.end;
            }
        }
        return left.localeCompare(right);
    });
    let spillIndex: number = 0;
    for (const name of orderedSpillNames) {
        const interval: X64LivenessInterval | undefined = intervalByName.get(name);
        if (!interval) {
            throw new Error(`x64 graph coloring missing spilled interval '${name}'`);
        }
        assignments.push({
            name,
            operand: {
                kind: "stack_slot",
                index: spillIndex,
                bank: interval.bank
            }
        });
        spillIndex += 1;
    }

    assignments.sort((left: X64AllocationEntry, right: X64AllocationEntry) => left.name.localeCompare(right.name));
    return assignments;
}

function buildBody(body: X64InterferenceProgram["entry"]): X64AllocationBody {
    const intervalByName: Map<string, X64LivenessInterval> = new Map<string, X64LivenessInterval>();
    for (const interval of body.intervals) {
        intervalByName.set(interval.name, interval);
    }

    const gprNodes: X64InterferenceGraphNode[] = body.graphNodes.filter((node: X64InterferenceGraphNode) => node.bank === "gpr");
    const xmmNodes: X64InterferenceGraphNode[] = body.graphNodes.filter((node: X64InterferenceGraphNode) => node.bank === "xmm");
    const gprAssignments: readonly X64AllocationEntry[] = allocateBank(gprNodes, intervalByName);
    const xmmAssignments: readonly X64AllocationEntry[] = allocateBank(xmmNodes, intervalByName);
    const assignments: X64AllocationEntry[] = [...gprAssignments, ...xmmAssignments].sort((left: X64AllocationEntry, right: X64AllocationEntry) => left.name.localeCompare(right.name));

    let spillSlotCount: number = 0;
    for (const assignment of assignments) {
        if (assignment.operand.kind === "stack_slot") {
            spillSlotCount += 1;
        }
    }

    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        blocks: body.blocks,
        assignments,
        spillSlotCount
    };
}

function buildFunction(fn: X64InterferenceFunctionDefinition): X64AllocationFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: buildBody(fn.body),
        origin: fn.origin
    };
}

export function graphColorRegallocX64Pass(program: X64InterferenceProgram): X64AllocationProgram {
    return {
        kind: "x64_allocation_program",
        entry: buildBody(program.entry),
        globals: program.globals,
        functions: program.functions.map((fn: X64InterferenceFunctionDefinition) => buildFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}