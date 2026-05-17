// x64 optimized backend pass 14d: materialize virtual-register assignments into the existing reg-allocated IR.

import type {
    X64AllocationEntry,
    X64AllocationFunctionDefinition,
    X64AllocationProgram,
    X64RegAllocatedBlock,
    X64RegAllocatedBody,
    X64RegAllocatedFunctionDefinition,
    X64RegAllocatedInstruction,
    X64RegAllocatedOperand,
    X64RegAllocatedProgram,
    X64RegAllocatedTerminator,
    X64SelectedBlock,
    X64SelectedInstruction,
    X64SelectedOperand,
    X64SelectedTerminator
} from "./Backend-Windows-IR-Shared";

function buildAssignmentMap(assignments: readonly X64AllocationEntry[]): ReadonlyMap<string, X64RegAllocatedOperand> {
    const assignmentMap: Map<string, X64RegAllocatedOperand> = new Map<string, X64RegAllocatedOperand>();
    for (const assignment of assignments) {
        assignmentMap.set(assignment.name, assignment.operand);
    }
    return assignmentMap;
}

function mapOperand(operand: X64SelectedOperand, assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedOperand {
    switch (operand.kind) {
        case "vreg": {
            const assignedOperand: X64RegAllocatedOperand | undefined = assignments.get(operand.name);
            if (!assignedOperand) {
                throw new Error(`x64 regalloc materialization missing assignment for '${operand.name}'`);
            }
            return assignedOperand;
        }
        case "preg": {
            return {
                kind: "preg",
                name: operand.name,
                bank: operand.bank
            };
        }
        case "stack_arg": {
            return {
                kind: "stack_arg",
                index: operand.index,
                bank: operand.bank
            };
        }
        case "incoming_stack_arg": {
            return {
                kind: "incoming_stack_arg",
                index: operand.index,
                bank: operand.bank
            };
        }
        case "imm_i64": {
            return {
                kind: "imm_i64",
                value: operand.value
            };
        }
        case "symbol": {
            return {
                kind: "symbol",
                symbol: operand.symbol
            };
        }
        case "text": {
            return {
                kind: "text",
                typeName: operand.typeName,
                referenceName: operand.referenceName,
                content: operand.content
            };
        }
    }
}

function mapInstruction(instruction: X64SelectedInstruction, assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedInstruction {
    switch (instruction.kind) {
        case "copy": {
            return {
                kind: "copy",
                target: mapOperand(instruction.target, assignments),
                source: mapOperand(instruction.source, assignments)
            };
        }
        case "call_direct": {
            return {
                ...instruction,
                stackArgs: instruction.stackArgs.map((operand: X64SelectedOperand) => mapOperand(operand, assignments))
            };
        }
        case "call_indirect": {
            return {
                ...instruction,
                callee: mapOperand(instruction.callee, assignments)
            };
        }
        case "gc_frame_begin": {
            return {
                ...instruction,
                gcRootOperands: instruction.gcRootOperands.map((operand: X64SelectedOperand) => mapOperand(operand, assignments))
            };
        }
        case "gc_frame_end": {
            return instruction;
        }
        case "test": {
            return {
                kind: "test",
                left: mapOperand(instruction.left, assignments),
                right: mapOperand(instruction.right, assignments)
            };
        }
        case "pseudo_object_alloc": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments)
            };
        }
        case "pseudo_object_get_field": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                receiver: mapOperand(instruction.receiver, assignments)
            };
        }
        case "pseudo_object_set_field": {
            return {
                ...instruction,
                receiver: mapOperand(instruction.receiver, assignments),
                value: mapOperand(instruction.value, assignments)
            };
        }
        case "pseudo_slot_load": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                receiver: mapOperand(instruction.receiver, assignments)
            };
        }
        case "pseudo_slot_store": {
            return {
                ...instruction,
                receiver: mapOperand(instruction.receiver, assignments),
                value: mapOperand(instruction.value, assignments)
            };
        }
        case "pseudo_union_inject": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                value: mapOperand(instruction.value, assignments)
            };
        }
        case "pseudo_union_has_tag": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                unionValue: mapOperand(instruction.unionValue, assignments)
            };
        }
        case "pseudo_union_get_payload": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                unionValue: mapOperand(instruction.unionValue, assignments)
            };
        }
        case "pseudo_closure_create": {
            return {
                ...instruction,
                target: mapOperand(instruction.target, assignments),
                captures: instruction.captures.map((capture: X64SelectedOperand) => mapOperand(capture, assignments))
            };
        }
    }
}

function mapTerminator(terminator: X64SelectedTerminator, assignments: ReadonlyMap<string, X64RegAllocatedOperand>): X64RegAllocatedTerminator {
    switch (terminator.kind) {
        case "ret": {
            return terminator;
        }
        case "jmp": {
            return {
                kind: "jmp",
                target: terminator.target,
                args: terminator.args.map((argument: X64SelectedOperand) => mapOperand(argument, assignments))
            };
        }
        case "jcc": {
            return {
                kind: "jcc",
                condition: terminator.condition,
                trueTarget: terminator.trueTarget,
                trueArgs: terminator.trueArgs.map((argument: X64SelectedOperand) => mapOperand(argument, assignments)),
                falseTarget: terminator.falseTarget,
                falseArgs: terminator.falseArgs.map((argument: X64SelectedOperand) => mapOperand(argument, assignments))
            };
        }
    }
}

function materializeBody(body: X64AllocationProgram["entry"]): X64RegAllocatedBody {
    const assignmentMap: ReadonlyMap<string, X64RegAllocatedOperand> = buildAssignmentMap(body.assignments);
    const blocks: X64RegAllocatedBlock[] = body.blocks.map((block: X64SelectedBlock) => ({
        label: block.label,
        predecessors: block.predecessors,
        params: block.params.map((param: X64SelectedOperand) => mapOperand(param, assignmentMap)),
        instructions: block.instructions.map((instruction: X64SelectedInstruction) => mapInstruction(instruction, assignmentMap)),
        terminator: mapTerminator(block.terminator, assignmentMap)
    }));
    return {
        entryLabel: body.entryLabel,
        gcRootNames: body.gcRootNames,
        spillSlotCount: body.spillSlotCount,
        blocks
    };
}

function materializeFunction(fn: X64AllocationFunctionDefinition): X64RegAllocatedFunctionDefinition {
    return {
        symbol: fn.symbol,
        params: fn.params,
        returnType: fn.returnType,
        body: materializeBody(fn.body),
        origin: fn.origin
    };
}

export function materializeRegallocX64Pass(program: X64AllocationProgram): X64RegAllocatedProgram {
    return {
        kind: "x64_reg_allocated_program",
        entry: materializeBody(program.entry),
        globals: program.globals,
        functions: program.functions.map((fn: X64AllocationFunctionDefinition) => materializeFunction(fn)),
        declaredFunctions: program.declaredFunctions,
        closureHelpers: program.closureHelpers,
        layouts: program.layouts,
        metadata: program.metadata
    };
}
