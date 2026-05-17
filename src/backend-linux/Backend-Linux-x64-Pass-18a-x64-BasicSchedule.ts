import type {
    X64CallConvention,
    X64FrameLayoutBody,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand,
    X64RegAllocatedTerminator
} from "./Backend-Linux-IR-Shared";

type X64SchedulableProgram = {
    readonly entry: X64FrameLayoutBody;
    readonly functions: readonly { readonly body: X64FrameLayoutBody; }[];
};

const SYSV_GPR_ARG_REGS = new Set(["rdi", "rsi", "rdx", "rcx", "r8", "r9"]);
const SYSV_XMM_ARG_REGS = new Set(["xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7"]);

function gprArgRegistersForCallingConvention(callingConvention: X64CallConvention): ReadonlySet<string> {
    switch (callingConvention) {
        case "internal":
        case "sysv_c_ffi":
            return SYSV_GPR_ARG_REGS;
    }
}

function xmmArgRegistersForCallingConvention(callingConvention: X64CallConvention): ReadonlySet<string> {
    switch (callingConvention) {
        case "internal":
        case "sysv_c_ffi":
            return SYSV_XMM_ARG_REGS;
    }
}

interface ScheduledCopyNode {
    readonly index: number;
    readonly instruction: Extract<X64RegAllocatedInstruction, { kind: "copy" }>;
    readonly reads: ReadonlySet<string>;
    readonly writes: ReadonlySet<string>;
    readonly baseHeight: number;
}

function operandLocationKey(operand: X64RegAllocatedOperand): string | null {
    switch (operand.kind) {
        case "preg":
            return `preg:${operand.name}:${operand.bank}`;
        case "stack_slot":
            return `stack_slot:${operand.index}:${operand.bank}`;
        case "stack_arg":
            return `stack_arg:${operand.index}:${operand.bank}`;
        case "incoming_stack_arg":
            return `incoming_stack_arg:${operand.index}:${operand.bank}`;
        case "imm_i64":
        case "symbol":
        case "text":
            return null;
    }
}

function readLocationKeysFromOperand(operand: X64RegAllocatedOperand): readonly string[] {
    const key = operandLocationKey(operand);
    return key ? [key] : [];
}

function implicitBarrierReadKeysForCall(
    callingConvention: X64CallConvention,
    stackArgs: readonly X64RegAllocatedOperand[],
    copies: readonly Extract<X64RegAllocatedInstruction, { kind: "copy" }>[],
): ReadonlySet<string> {
    const keys = new Set<string>();
    const gprArgRegs = gprArgRegistersForCallingConvention(callingConvention);
    const xmmArgRegs = xmmArgRegistersForCallingConvention(callingConvention);
    for (const copy of copies) {
        switch (copy.target.kind) {
            case "preg":
                if (gprArgRegs.has(copy.target.name) || xmmArgRegs.has(copy.target.name)) {
                    keys.add(`preg:${copy.target.name}:${copy.target.bank}`);
                }
                break;
            case "stack_arg":
                keys.add(`stack_arg:${copy.target.index}:${copy.target.bank}`);
                break;
        }
    }
    stackArgs.forEach((operand, index) => {
        const bank = operand.kind === "preg" || operand.kind === "stack_slot" || operand.kind === "stack_arg" || operand.kind === "incoming_stack_arg"
            ? operand.bank
            : "gpr";
        keys.add(`stack_arg:${index}:${bank}`);
    });
    return keys;
}

function barrierReadKeys(
    barrier: X64RegAllocatedInstruction | X64RegAllocatedTerminator | null,
    copies: readonly Extract<X64RegAllocatedInstruction, { kind: "copy" }>[],
): ReadonlySet<string> {
    const keys = new Set<string>();
    if (!barrier) {
        return keys;
    }
    const addOperand = (operand: X64RegAllocatedOperand): void => {
        for (const key of readLocationKeysFromOperand(operand)) {
            keys.add(key);
        }
    };
    if ("kind" in barrier) {
        switch (barrier.kind) {
            case "copy":
                addOperand(barrier.source);
                break;
            case "call_direct":
                for (const key of implicitBarrierReadKeysForCall(barrier.callingConvention, barrier.stackArgs, copies)) {
                    keys.add(key);
                }
                break;
            case "call_indirect":
                addOperand(barrier.callee);
                for (const key of implicitBarrierReadKeysForCall("internal", [], copies)) {
                    keys.add(key);
                }
                break;
            case "gc_frame_begin":
                barrier.gcRootOperands.forEach(addOperand);
                break;
            case "gc_frame_end":
                break;
            case "test":
                addOperand(barrier.left);
                addOperand(barrier.right);
                break;
            case "pseudo_object_alloc":
                break;
            case "pseudo_object_get_field":
                addOperand(barrier.receiver);
                break;
            case "pseudo_object_set_field":
                addOperand(barrier.receiver);
                addOperand(barrier.value);
                break;
            case "pseudo_slot_load":
                addOperand(barrier.receiver);
                break;
            case "pseudo_slot_store":
                addOperand(barrier.receiver);
                addOperand(barrier.value);
                break;
            case "pseudo_union_inject":
                addOperand(barrier.value);
                break;
            case "pseudo_union_has_tag":
            case "pseudo_union_get_payload":
                addOperand(barrier.unionValue);
                break;
            case "pseudo_closure_create":
                barrier.captures.forEach(addOperand);
                break;
            case "ret":
                keys.add("preg:rax:gpr");
                keys.add("preg:xmm0:xmm");
                break;
            case "jmp":
                barrier.args.forEach(addOperand);
                break;
            case "jcc":
                barrier.trueArgs.forEach(addOperand);
                barrier.falseArgs.forEach(addOperand);
                break;
        }
    }
    return keys;
}

function buildCopyNode(
    instruction: Extract<X64RegAllocatedInstruction, { kind: "copy" }>,
    index: number,
    barrierKeys: ReadonlySet<string>
): ScheduledCopyNode {
    const reads = new Set<string>(readLocationKeysFromOperand(instruction.source));
    const writes = new Set<string>(readLocationKeysFromOperand(instruction.target));
    const baseHeight = Array.from(writes).some((key) => barrierKeys.has(key)) ? 1 : 0;
    return {
        index,
        instruction,
        reads,
        writes,
        baseHeight
    };
}

function hasSetIntersection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    for (const key of left) {
        if (right.has(key)) {
            return true;
        }
    }
    return false;
}

function dependencyEdge(left: ScheduledCopyNode, right: ScheduledCopyNode): boolean {
    return hasSetIntersection(left.writes, right.reads)
        || hasSetIntersection(left.writes, right.writes)
        || hasSetIntersection(left.reads, right.writes);
}

function scheduleCopySegment(
    copies: readonly Extract<X64RegAllocatedInstruction, { kind: "copy" }>[],
    barrier: X64RegAllocatedInstruction | X64RegAllocatedTerminator | null
): readonly X64RegAllocatedInstruction[] {
    if (copies.length < 2) {
        return copies;
    }

    const barrierKeys = barrierReadKeys(barrier, copies);
    const nodes = copies.map((instruction, index) => buildCopyNode(instruction, index, barrierKeys));
    const predecessors = new Map<number, Set<number>>();
    const successors = new Map<number, Set<number>>();
    for (const node of nodes) {
        predecessors.set(node.index, new Set<number>());
        successors.set(node.index, new Set<number>());
    }
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
            if (dependencyEdge(nodes[leftIndex], nodes[rightIndex])) {
                predecessors.get(rightIndex)?.add(leftIndex);
                successors.get(leftIndex)?.add(rightIndex);
            }
        }
    }

    const heightMemo = new Map<number, number>();
    const computeHeight = (index: number): number => {
        const cached = heightMemo.get(index);
        if (cached !== undefined) {
            return cached;
        }
        const node = nodes[index];
        const successorHeights = [...(successors.get(index) ?? [])].map((successor) => computeHeight(successor));
        const height = Math.max(node.baseHeight, successorHeights.length > 0 ? 1 + Math.max(...successorHeights) : 0);
        heightMemo.set(index, height);
        return height;
    };
    nodes.forEach((node) => computeHeight(node.index));

    const ready = nodes
        .filter((node) => (predecessors.get(node.index)?.size ?? 0) === 0)
        .map((node) => node.index);
    const scheduled: X64RegAllocatedInstruction[] = [];
    const remainingPredecessors = new Map<number, Set<number>>(
        [...predecessors.entries()].map(([index, deps]) => [index, new Set(deps)])
    );

    while (ready.length > 0) {
        ready.sort((left, right) => {
            const leftHeight = computeHeight(left);
            const rightHeight = computeHeight(right);
            if (leftHeight !== rightHeight) {
                return leftHeight - rightHeight;
            }
            return left - right;
        });
        const nextIndex = ready.shift();
        if (nextIndex === undefined) {
            break;
        }
        scheduled.push(nodes[nextIndex].instruction);
        for (const successor of successors.get(nextIndex) ?? []) {
            const deps = remainingPredecessors.get(successor);
            deps?.delete(nextIndex);
            if ((deps?.size ?? 0) === 0 && !ready.includes(successor)) {
                ready.push(successor);
            }
        }
    }

    if (scheduled.length !== copies.length) {
        return copies;
    }
    return scheduled;
}

function scheduleInstructions(
    instructions: readonly X64RegAllocatedInstruction[],
    terminator: X64RegAllocatedTerminator
): readonly X64RegAllocatedInstruction[] {
    const scheduled: X64RegAllocatedInstruction[] = [];
    let pendingCopies: Extract<X64RegAllocatedInstruction, { kind: "copy" }>[] = [];
    const flush = (barrier: X64RegAllocatedInstruction | X64RegAllocatedTerminator | null): void => {
        if (pendingCopies.length > 0) {
            scheduled.push(...scheduleCopySegment(pendingCopies, barrier));
            pendingCopies = [];
        }
    };
    for (const instruction of instructions) {
        if (instruction.kind === "copy") {
            pendingCopies.push(instruction);
            continue;
        }
        flush(instruction);
        scheduled.push(instruction);
    }
    flush(terminator);
    return scheduled;
}

export function basicScheduleX64Pass<T extends X64SchedulableProgram>(program: T): T {
    const scheduleBody = (body: X64FrameLayoutBody): X64FrameLayoutBody => ({
        ...body,
        blocks: body.blocks.map((block) => ({
            ...block,
            instructions: scheduleInstructions(block.instructions, block.terminator)
        }))
    });
    const scheduledFunctions = program.functions.map((fn) => ({
        ...fn,
        body: scheduleBody(fn.body)
    })) as T["functions"];
    return {
        ...program,
        entry: scheduleBody(program.entry),
        functions: scheduledFunctions
    } as T;
}
