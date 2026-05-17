import { PrimitiveTypeValue, getRuntimeTypeId, type TypeValue } from "./Typecheck-Core";
import { astToTypeValue } from "./Typecheck-TypeAst";
import { isGcCollectLikeSymbol, resolveDeclaredCFunctionAlias } from "./DeclaredCFunctionName";
import type {
    BackendValueRepresentation,
    RepresentationSelectionBody,
    RepresentationSelectionProgram
} from "./backend-linux/Backend-Linux-IR-Shared";
import type {
    CfgBody,
    CfgProgram,
    CfgStatement,
    LinearOperand,
    LinearRvalue,
    LoweringClassLayout,
    LoweringUnionMetadata
} from "./Lowering-Frontend-Shared";

interface RepresentationSelectionContext {
    readonly layouts: ReadonlyMap<string, LoweringClassLayout>;
    readonly functionReturnRepresentations: ReadonlyMap<string, BackendValueRepresentation>;
    readonly immediateRuntimeTypeTagIds: ReadonlySet<string>;
    readonly referencedUnionMetadata: ReadonlyMap<string, LoweringUnionMetadata>;
}

const IMMEDIATE_PRIMITIVE_NAMES: readonly string[] = ["bool", "unit", "i5", "i6", "i7", "u5", "u6", "u7"];

type InferredRepresentation = BackendValueRepresentation | undefined;

function mergeRepresentations(left: InferredRepresentation, right: InferredRepresentation): InferredRepresentation {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    if (left === right) {
        return left;
    }
    if (left === "reference" || right === "reference") {
        return "reference";
    }
    return "immediate";
}

function mergeEnvironmentMaps(
    left: ReadonlyMap<string, BackendValueRepresentation>,
    right: ReadonlyMap<string, BackendValueRepresentation>
): Map<string, BackendValueRepresentation> {
    const merged = new Map<string, BackendValueRepresentation>();
    const keys = new Set<string>([...left.keys(), ...right.keys()]);
    for (const key of keys) {
        const mergedRepresentation = mergeRepresentations(left.get(key), right.get(key));
        if (mergedRepresentation !== undefined) {
            merged.set(key, mergedRepresentation);
        }
    }
    return merged;
}

function mapsEqual(
    left: ReadonlyMap<string, BackendValueRepresentation>,
    right: ReadonlyMap<string, BackendValueRepresentation>
): boolean {
    if (left.size !== right.size) {
        return false;
    }
    for (const [key, value] of left.entries()) {
        if (right.get(key) !== value) {
            return false;
        }
    }
    return true;
}

function representationFromType(type: TypeValue): BackendValueRepresentation {
    if (type instanceof PrimitiveTypeValue && IMMEDIATE_PRIMITIVE_NAMES.includes(type.name)) {
        return "immediate";
    }
    return "reference";
}

function representationFromTypeAst(typeExp: import("./AstNode").AstNode): BackendValueRepresentation {
    try {
        return representationFromType(astToTypeValue(typeExp));
    } catch {
        return "reference";
    }
}

function representationFromNumberLiteral(typeName: string): BackendValueRepresentation {
    return IMMEDIATE_PRIMITIVE_NAMES.includes(typeName) ? "immediate" : "reference";
}

function classifyOperand(operand: LinearOperand, env: ReadonlyMap<string, BackendValueRepresentation>): InferredRepresentation {
    switch (operand.kind) {
        case "local":
            return env.get(operand.name);
        case "number_literal":
            return representationFromNumberLiteral(operand.typeName);
        case "text_literal":
            return "immediate";
        case "direct_function":
            return "reference";
    }
}

function classifyBuiltinReturn(symbol: string): BackendValueRepresentation | undefined {
    const resolvedSymbol = resolveDeclaredCFunctionAlias(symbol);
    const scalarConversionMatch = resolvedSymbol.match(/^iw_(?:ty|bin)_to_([a-z][0-9])_([a-z][0-9])$/i);
    if (scalarConversionMatch) {
        return IMMEDIATE_PRIMITIVE_NAMES.includes(scalarConversionMatch[1]) ? "immediate" : "reference";
    }
    if (
        resolvedSymbol === "array_new"
        || resolvedSymbol === "s3_new_copy"
        || resolvedSymbol === "s3_new_fill"
        || resolvedSymbol === "s3_get"
        || resolvedSymbol === "s4_new_copy"
        || resolvedSymbol === "s4_new_fill"
        || resolvedSymbol === "s4_get"
        || resolvedSymbol === "s5_new_copy"
        || resolvedSymbol === "s5_new_fill"
        || resolvedSymbol === "s5_get"
        || resolvedSymbol === "z5_new"
        || resolvedSymbol === "z6_new"
        || resolvedSymbol === "z7_new"
        || resolvedSymbol === "iw_stdin_read_line_s3"
        || resolvedSymbol === "iw_read_file_s3"
        || resolvedSymbol === "iw_sys_fd_read_s3"
        || resolvedSymbol === "iw_sys_fd_pread_s3"
        || resolvedSymbol === "iw_sys_fd_readv_s3"
        || resolvedSymbol === "iw_sys_fd_fstat"
        || resolvedSymbol === "iw_sys_fd_pipe2"
        || resolvedSymbol === "iw_sys_net_socketpair_stream"
        || resolvedSymbol === "iw_sys_net_recv_s3"
        || resolvedSymbol === "iw_sys_net_recvmsg_s3"
        || resolvedSymbol === "iw_sys_epoll_wait"
        || resolvedSymbol === "iw_sys_epoll_pwait"
        || resolvedSymbol === "iw_sys_signalfd_read"
        || resolvedSymbol === "iw_sys_poll"
        || resolvedSymbol === "iw_sys_ppoll"
        || resolvedSymbol === "iw_sys_path_getcwd_s3"
        || resolvedSymbol === "iw_sys_platform_name"
        || resolvedSymbol === "iw_sys_process_argv_s3"
        || resolvedSymbol === "iw_sys_env_get_s3"
        || resolvedSymbol === "iw_sys_path_stat_s3"
        || resolvedSymbol === "iw_sys_process_spawn_s3"
        || resolvedSymbol === "iw_sys_process_spawn_stdio_s3"
        || resolvedSymbol === "iw_sys_dir_read_s3"
    ) {
        return "reference";
    }
    if (
        resolvedSymbol === "s3_set"
        || resolvedSymbol === "s4_set"
        || resolvedSymbol === "s5_set"
        || resolvedSymbol === "z5_set_value"
        || resolvedSymbol === "z5_set_parts"
        || resolvedSymbol === "z6_set_value"
        || resolvedSymbol === "z6_set_parts"
        || resolvedSymbol === "z7_set_value"
        || resolvedSymbol === "z7_set_parts"
    ) {
        return "immediate";
    }
    if (
        resolvedSymbol === "iw_zreal_z5"
        || resolvedSymbol === "z5_real"
        || resolvedSymbol === "iw_zimg_z5"
        || resolvedSymbol === "z5_img"
        || resolvedSymbol === "iw_zabs_z5"
        || resolvedSymbol === "iw_zarg_z5"
    ) {
        return "reference";
    }
    if (
        resolvedSymbol === "iw_i5_to_f5"
        || resolvedSymbol === "iw_sin_f5"
        || resolvedSymbol === "iw_cos_f5"
        || resolvedSymbol === "iw_sqrt_f5"
        || resolvedSymbol === "iw_atan2_f5"
        || resolvedSymbol === "iw_stdin_read_f5"
    ) {
        return "reference";
    }
    if (
        resolvedSymbol === "iw_round_f5"
        || resolvedSymbol === "iw_floor_f5"
        || resolvedSymbol === "iw_ceil_f5"
        || resolvedSymbol === "iw_trunc_f5"
        || resolvedSymbol === "iw_round_f6"
        || resolvedSymbol === "iw_round_f7"
        || resolvedSymbol === "iw_floor_f6"
        || resolvedSymbol === "iw_floor_f7"
        || resolvedSymbol === "iw_ceil_f6"
        || resolvedSymbol === "iw_ceil_f7"
        || resolvedSymbol === "iw_trunc_f6"
        || resolvedSymbol === "iw_trunc_f7"
    ) {
        return "immediate";
    }
    if (
        resolvedSymbol === "array_length"
        || resolvedSymbol === "s3_length"
        || resolvedSymbol === "s4_length"
        || resolvedSymbol === "s5_length"
        || resolvedSymbol === "array_set"
        || isGcCollectLikeSymbol(symbol)
        || resolvedSymbol === "iw_match_unreachable"
        || resolvedSymbol === "iw_stdin_read_i5"
        || resolvedSymbol === "iw_stdout_write_s3"
        || resolvedSymbol === "iw_stdout_write_s4"
        || resolvedSymbol === "iw_stdout_write_s5"
        || resolvedSymbol === "iw_stdout_println_s3"
        || resolvedSymbol === "iw_stdout_println_s4"
        || resolvedSymbol === "iw_stdout_println_s5"
        || resolvedSymbol === "iw_stdout_write_c3"
        || resolvedSymbol === "iw_stdout_write_i5_ascii"
        || resolvedSymbol === "iw_stdout_write_f5_ascii"
        || resolvedSymbol === "iw_stderr_write_s3"
        || resolvedSymbol === "iw_stderr_write_s4"
        || resolvedSymbol === "iw_stderr_write_s5"
        || resolvedSymbol === "iw_stderr_println_s3"
        || resolvedSymbol === "iw_stderr_println_s4"
        || resolvedSymbol === "iw_stderr_println_s5"
        || resolvedSymbol === "iw_stderr_write_c3"
        || resolvedSymbol === "iw_stderr_write_i5_ascii"
        || resolvedSymbol === "iw_stderr_write_f5_ascii"
        || resolvedSymbol === "iw_stdout_flush"
        || resolvedSymbol === "iw_stderr_flush"
        || resolvedSymbol === "iw_write_file_s3"
        || resolvedSymbol === "iw_append_file_s3"
        || resolvedSymbol === "iw_file_open_write_s3"
        || resolvedSymbol === "iw_file_open_append_s3"
        || resolvedSymbol === "iw_file_close"
        || resolvedSymbol === "iw_file_write_s3"
        || resolvedSymbol === "iw_file_write_c3"
        || resolvedSymbol === "iw_file_write_i5_ascii"
        || resolvedSymbol === "iw_file_write_f5_ascii"
        || resolvedSymbol === "iw_sys_fd_open_read_s3"
        || resolvedSymbol === "iw_sys_fd_open_write_s3"
        || resolvedSymbol === "iw_sys_fd_openat_read_s3"
        || resolvedSymbol === "iw_sys_fd_openat_write_s3"
        || resolvedSymbol === "iw_sys_fd_creat_s3"
        || resolvedSymbol === "iw_sys_fd_open_append_s3"
        || resolvedSymbol === "iw_sys_fd_close"
        || resolvedSymbol === "iw_sys_fd_write_s3"
        || resolvedSymbol === "iw_sys_fd_pwrite_s3"
        || resolvedSymbol === "iw_sys_fd_sendfile"
        || resolvedSymbol === "iw_sys_fd_lseek"
        || resolvedSymbol === "iw_sys_fd_fsync"
        || resolvedSymbol === "iw_sys_fd_fdatasync"
        || resolvedSymbol === "iw_sys_fd_dup"
        || symbol === "iw_sys_fd_dup2"
        || symbol === "iw_sys_fd_dup3"
        || symbol === "iw_sys_fd_fcntl"
        || symbol === "iw_sys_net_socket_tcp4"
        || symbol === "iw_sys_net_setsockopt_reuseaddr"
        || symbol === "iw_sys_net_setsockopt_reuseport"
        || symbol === "iw_sys_net_setsockopt_tcp_nodelay"
        || symbol === "iw_sys_net_getsockopt_error"
        || symbol === "iw_sys_net_bind_ipv4_any"
        || symbol === "iw_sys_net_bind_ipv4_loopback"
        || symbol === "iw_sys_net_getsockname_ipv4_port"
        || symbol === "iw_sys_net_listen"
        || symbol === "iw_sys_net_accept"
        || symbol === "iw_sys_net_accept4"
        || symbol === "iw_sys_net_connect_ipv4_loopback"
        || symbol === "iw_sys_net_send_s3"
        || symbol === "iw_sys_net_sendmsg_s3"
        || symbol === "iw_sys_net_shutdown"
        || symbol === "iw_sys_epoll_create"
        || symbol === "iw_sys_epoll_ctl"
        || symbol === "iw_sys_eventfd_create"
        || symbol === "iw_sys_eventfd_write"
        || symbol === "iw_sys_eventfd_read"
        || symbol === "iw_sys_timerfd_create_monotonic"
        || symbol === "iw_sys_timerfd_settime_oneshot_ms"
        || symbol === "iw_sys_timerfd_settime_interval_ms"
        || symbol === "iw_sys_timerfd_read_expirations"
        || symbol === "iw_sys_path_chdir_s3"
        || symbol === "iw_sys_path_mkdir_s3"
        || symbol === "iw_sys_path_rmdir_s3"
        || symbol === "iw_sys_path_unlink_s3"
        || symbol === "iw_sys_path_rename_s3"
        || resolvedSymbol === "iw_sys_process_abort"
        || resolvedSymbol === "iw_sys_process_argc"
        || resolvedSymbol === "iw_sys_env_set_s3"
        || resolvedSymbol === "iw_sys_env_unset_s3"
        || resolvedSymbol === "iw_sys_path_exists_s3"
        || resolvedSymbol === "iw_sys_path_is_file_s3"
        || resolvedSymbol === "iw_sys_path_is_dir_s3"
        || symbol === "iw_sys_process_getpid"
        || resolvedSymbol === "iw_sys_process_wait"
        || resolvedSymbol === "iw_sys_process_kill"
        || symbol === "iw_sys_process_fork"
        || symbol === "iw_sys_process_wait4"
        || symbol === "iw_sys_process_exit"
        || symbol === "iw_sys_process_exit_group"
        || resolvedSymbol === "iw_sys_time_unix_ms"
        || resolvedSymbol === "iw_sys_time_monotonic_ms"
        || resolvedSymbol === "iw_sys_net_startup"
        || resolvedSymbol === "iw_sys_net_cleanup"
        || resolvedSymbol === "iw_sys_net_close"
        || resolvedSymbol === "iw_sys_net_set_nonblocking"
        || resolvedSymbol === "iw_sys_event_create"
        || resolvedSymbol === "iw_sys_event_set"
        || resolvedSymbol === "iw_sys_event_reset"
        || resolvedSymbol === "iw_sys_wait_one"
        || resolvedSymbol === "iw_sys_wait_many"
        || resolvedSymbol === "iw_sys_handle_close"
        || symbol === "iw_sys_process_execve_s3"
        || symbol === "iw_sys_thread_gettid"
        || symbol === "iw_sys_thread_tgkill"
        || symbol === "iw_sys_thread_yield"
        || resolvedSymbol === "iw_thread_request_cancel"
        || resolvedSymbol === "iw_thread_cancel_requested"
        || resolvedSymbol === "iw_sem_new"
        || resolvedSymbol === "iw_sem_post"
        || resolvedSymbol === "iw_sem_wait"
        || resolvedSymbol === "iw_sem_timed_wait_ms"
        || resolvedSymbol === "iw_sem_destroy"
    ) {
        return "immediate";
    }
    if (
        symbol === "iw_z5_rect"
        || symbol === "iw_z6_rect"
        || symbol === "iw_z7_rect"
        || symbol === "z6_real"
        || symbol === "z6_img"
        || symbol === "z7_real"
        || symbol === "z7_img"
        || symbol === "iw_zreal_z6"
        || symbol === "iw_zreal_z7"
        || symbol === "iw_zimg_z6"
        || symbol === "iw_zimg_z7"
        || symbol === "iw_zabs_z6"
        || symbol === "iw_zabs_z7"
        || symbol === "iw_zarg_z6"
        || symbol === "iw_zarg_z7"
        || symbol === "iw_zconj_z5"
        || symbol === "iw_zconj_z6"
        || symbol === "iw_zconj_z7"
        || symbol === "iw_zproj_z5"
        || symbol === "iw_zproj_z6"
        || symbol === "iw_zproj_z7"
        || symbol === "iw_zexp_z5"
        || symbol === "iw_zexp_z6"
        || symbol === "iw_zexp_z7"
        || symbol === "iw_zlog_z5"
        || symbol === "iw_zlog_z6"
        || symbol === "iw_zlog_z7"
        || symbol === "iw_zsqrt_z5"
        || symbol === "iw_zsqrt_z6"
        || symbol === "iw_zsqrt_z7"
        || symbol === "iw_zpow_z5"
        || symbol === "iw_zpow_z6"
        || symbol === "iw_zpow_z7"
    ) {
        return "reference";
    }
    if (symbol === "not" || symbol === "and" || symbol === "or" || symbol === "xor") {
        return "immediate";
    }
    if (symbol.startsWith("__iw_builtin_")) {
        if (symbol.endsWith("_i5") || symbol.endsWith("_i6") || symbol.endsWith("_i7") || symbol.endsWith("_u5") || symbol.endsWith("_u6") || symbol.endsWith("_u7")) {
            return "immediate";
        }
        if (symbol.endsWith("_f5") || symbol.endsWith("_f6") || symbol.endsWith("_f7")) {
            if (symbol.includes("_round_") || symbol.includes("_floor_") || symbol.includes("_ceil_") || symbol.includes("_trunc_")) {
                return "immediate";
            }
            if (symbol.includes("_le_") || symbol.includes("_lt_") || symbol.includes("_ge_") || symbol.includes("_gt_") || symbol.includes("_eq_") || symbol.includes("_neq_")) {
                return "immediate";
            }
            return "reference";
        }
    }
    return undefined;
}

function classifyRvalue(
    rvalue: LinearRvalue,
    env: ReadonlyMap<string, BackendValueRepresentation>,
    context: RepresentationSelectionContext
): InferredRepresentation {
    switch (rvalue.kind) {
        case "copy":
            return classifyOperand(rvalue.value, env);
        case "object_alloc":
            return "reference";
        case "object_get_field": {
            const layout = context.layouts.get(rvalue.className);
            const fieldType = layout?.propertyTypes.get(rvalue.fieldName);
            return fieldType ? representationFromType(fieldType) : "reference";
        }
        case "slot_load": {
            const layout = context.layouts.get(rvalue.className);
            const fieldType = layout?.propertyTypes.get(rvalue.slotName);
            return fieldType ? representationFromType(fieldType) : "reference";
        }
        case "union_inject":
            return "reference";
        case "union_has_tag":
            return "immediate";
        case "union_get_payload": {
            const unionMetadata = context.referencedUnionMetadata.get(rvalue.unionTypeTagId);
            const memberMetadata = unionMetadata?.members.find((member) => member.runtimeTypeTagId === rvalue.memberTypeTagId);
            if (memberMetadata && context.immediateRuntimeTypeTagIds.has(memberMetadata.runtimeTypeTagId)) {
                return "immediate";
            }
            return context.immediateRuntimeTypeTagIds.has(rvalue.memberTypeTagId) ? "immediate" : "reference";
        }
        case "closure_create":
            return "reference";
        case "direct_call":
            return classifyBuiltinReturn(rvalue.symbol) ?? context.functionReturnRepresentations.get(rvalue.symbol) ?? "reference";
        case "closure_call":
            return "reference";
    }
}

function transferStatement(
    statement: CfgStatement,
    incoming: ReadonlyMap<string, BackendValueRepresentation>,
    context: RepresentationSelectionContext
): Map<string, BackendValueRepresentation> {
    const env = new Map(incoming);
    switch (statement.kind) {
        case "assign": {
            const valueRepresentation = classifyRvalue(statement.value, env, context);
            const mergedRepresentation = mergeRepresentations(env.get(statement.target), valueRepresentation);
            if (mergedRepresentation !== undefined) {
                env.set(statement.target, mergedRepresentation);
            }
            return env;
        }
        case "set_local": {
            const valueRepresentation = classifyOperand(statement.value, env);
            const mergedRepresentation = mergeRepresentations(env.get(statement.target), valueRepresentation);
            if (mergedRepresentation !== undefined) {
                env.set(statement.target, mergedRepresentation);
            }
            return env;
        }
        case "object_set_field":
        case "slot_store":
            return env;
    }
}

function buildBaseEnvironment(
    params: readonly { readonly name: string; readonly typeExp: import("./AstNode").AstNode; }[],
    _body: CfgBody
): Map<string, BackendValueRepresentation> {
    const env = new Map<string, BackendValueRepresentation>();
    for (const param of params) {
        env.set(param.name, representationFromTypeAst(param.typeExp));
    }
    return env;
}

function buildPredecessorMap(body: CfgBody): Map<string, string[]> {
    const predecessors = new Map<string, string[]>();
    for (const block of body.blocks) {
        predecessors.set(block.label, []);
    }
    for (const block of body.blocks) {
        const targets = block.terminator.kind === "jump"
            ? [block.terminator.target]
            : block.terminator.kind === "branch"
                ? [block.terminator.trueTarget, block.terminator.falseTarget]
                : [];
        for (const target of targets) {
            predecessors.get(target)?.push(block.label);
        }
    }
    return predecessors;
}

function buildSelectionBody(
    params: readonly { readonly name: string; readonly typeExp: import("./AstNode").AstNode; }[],
    body: CfgBody,
    context: RepresentationSelectionContext,
    declaredResultRepresentation?: BackendValueRepresentation
): RepresentationSelectionBody {
    const baseEnvironment = buildBaseEnvironment(params, body);
    const predecessorMap = buildPredecessorMap(body);
    const entryEnvironments = new Map<string, Map<string, BackendValueRepresentation>>();
    const exitEnvironments = new Map<string, Map<string, BackendValueRepresentation>>();

    for (const block of body.blocks) {
        entryEnvironments.set(block.label, new Map(baseEnvironment));
        exitEnvironments.set(block.label, new Map(baseEnvironment));
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const block of body.blocks) {
            const predecessors = predecessorMap.get(block.label) ?? [];
            let entryEnvironment = new Map(baseEnvironment);
            if (block.label !== body.entryLabel && predecessors.length > 0) {
                entryEnvironment = predecessors
                    .map((predecessor) => exitEnvironments.get(predecessor) ?? new Map(baseEnvironment))
                    .reduce((merged, predecessorEnv) => mergeEnvironmentMaps(merged, predecessorEnv), new Map(baseEnvironment));
            }

            if (!mapsEqual(entryEnvironment, entryEnvironments.get(block.label) ?? new Map())) {
                entryEnvironments.set(block.label, entryEnvironment);
                changed = true;
            }

            let exitEnvironment = new Map(entryEnvironment);
            for (const statement of block.statements) {
                exitEnvironment = transferStatement(statement, exitEnvironment, context);
            }

            if (!mapsEqual(exitEnvironment, exitEnvironments.get(block.label) ?? new Map())) {
                exitEnvironments.set(block.label, exitEnvironment);
                changed = true;
            }
        }
    }

    let analyzedBindings = new Map<string, BackendValueRepresentation>(baseEnvironment);
    for (const environment of exitEnvironments.values()) {
        analyzedBindings = mergeEnvironmentMaps(analyzedBindings, environment);
    }

    const bindingRepresentations = new Map<string, BackendValueRepresentation>();
    for (const param of params) {
        bindingRepresentations.set(param.name, analyzedBindings.get(param.name) ?? representationFromTypeAst(param.typeExp));
    }
    for (const localName of body.locals) {
        bindingRepresentations.set(localName, analyzedBindings.get(localName) ?? "reference");
    }

    let inferredResultRepresentation: BackendValueRepresentation = "reference";
    let sawReturn = false;
    for (const block of body.blocks) {
        if (block.terminator.kind !== "return") {
            continue;
        }
        const exitEnvironment = exitEnvironments.get(block.label) ?? baseEnvironment;
        const representation = classifyOperand(block.terminator.value, exitEnvironment);
        if (representation === undefined) {
            continue;
        }
        inferredResultRepresentation = sawReturn
            ? mergeRepresentations(inferredResultRepresentation, representation) ?? inferredResultRepresentation
            : representation;
        sawReturn = true;
    }

    return {
        bindingRepresentations,
        resultRepresentation: declaredResultRepresentation ?? inferredResultRepresentation
    };
}

function collectImmediateRuntimeTypeTagIds(): ReadonlySet<string> {
    return new Set<string>(IMMEDIATE_PRIMITIVE_NAMES.map((name) => getRuntimeTypeId(new PrimitiveTypeValue(name))));
}

function buildFunctionReturnRepresentations(program: CfgProgram): ReadonlyMap<string, BackendValueRepresentation> {
    const representations = new Map<string, BackendValueRepresentation>();
    for (const fn of program.functions) {
        representations.set(fn.symbol, representationFromTypeAst(fn.returnType));
    }
    for (const fn of program.declaredFunctions) {
        representations.set(fn.symbol, representationFromType(fn.functionType.returnType));
    }
    return representations;
}

export function selectRepresentationsPass(program: CfgProgram): RepresentationSelectionProgram {
    const context: RepresentationSelectionContext = {
        layouts: program.layouts.classes,
        functionReturnRepresentations: buildFunctionReturnRepresentations(program),
        immediateRuntimeTypeTagIds: collectImmediateRuntimeTypeTagIds(),
        referencedUnionMetadata: new Map(program.metadata.referencedUnionMetadata.map((metadata) => [metadata.unionTypeTagId, metadata]))
    };

    return {
        kind: "representation_selection_program",
        entry: buildSelectionBody(program.metadata.entryParams, program.entry, context),
        functions: program.functions.map((fn) => ({
            symbol: fn.symbol,
            body: buildSelectionBody(fn.params, fn.body, context, representationFromTypeAst(fn.returnType))
        }))
    };
}
