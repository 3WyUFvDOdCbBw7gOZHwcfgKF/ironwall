static inline size_t iw_gc_pointer_hash(uintptr_t value) {
    uint64_t mixed = (uint64_t)value;
    mixed ^= mixed >> 33;
    mixed *= 0xff51afd7ed558ccdULL;
    mixed ^= mixed >> 33;
    mixed *= 0xc4ceb9fe1a85ec53ULL;
    mixed ^= mixed >> 33;
    return (size_t)mixed;
}

static inline void iw_gc_heap_registry_insert_index(iw_heap_header_t *base, size_t entry_index) {
    const size_t mask = iw_gc_heap_registry_bucket_count - 1u;
    size_t bucket = iw_gc_pointer_hash((uintptr_t)base) & mask;
    while (iw_gc_heap_registry_buckets[bucket] != 0u) {
        bucket = (bucket + 1u) & mask;
    }
    iw_gc_heap_registry_buckets[bucket] = entry_index + 1u;
}

static inline void iw_gc_heap_registry_rebuild_index(void) {
    size_t target_bucket_count = 16u;
    while (target_bucket_count < ((iw_gc_heap_registry_count == 0u ? 1u : iw_gc_heap_registry_count) * 4u)) {
        target_bucket_count <<= 1u;
    }
    if (target_bucket_count != iw_gc_heap_registry_bucket_count) {
        free(iw_gc_heap_registry_buckets);
        iw_gc_heap_registry_buckets = (size_t*)calloc(target_bucket_count, sizeof(size_t));
        if (iw_gc_heap_registry_buckets == NULL) {
            fprintf(stderr, "Ironwall GC heap registry bucket allocation failed\n");
            abort();
        }
        iw_gc_heap_registry_bucket_count = target_bucket_count;
    } else {
        memset(iw_gc_heap_registry_buckets, 0, target_bucket_count * sizeof(size_t));
    }
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        if (iw_gc_heap_registry_entries[index].base == NULL) {
            continue;
        }
        iw_gc_heap_registry_insert_index(iw_gc_heap_registry_entries[index].base, index);
    }
}

static inline void iw_gc_heap_registry_append(iw_heap_header_t *base, size_t total_size_bytes, iw_gc_metadata_ref_t metadata_ref) {
    if (iw_gc_heap_registry_count == iw_gc_heap_registry_capacity) {
        size_t next_capacity = iw_gc_heap_registry_capacity == 0u ? 16u : iw_gc_heap_registry_capacity * 2u;
        iw_gc_heap_registry_entry_t *next_entries = (iw_gc_heap_registry_entry_t*)realloc(iw_gc_heap_registry_entries, next_capacity * sizeof(iw_gc_heap_registry_entry_t));
        if (next_entries == NULL) {
            fprintf(stderr, "Ironwall GC heap registry allocation failed\n");
            abort();
        }
        iw_gc_heap_registry_entries = next_entries;
        iw_gc_heap_registry_capacity = next_capacity;
    }
    iw_gc_heap_registry_entries[iw_gc_heap_registry_count].base = base;
    iw_gc_heap_registry_entries[iw_gc_heap_registry_count].total_size_bytes = total_size_bytes;
    iw_gc_heap_registry_entries[iw_gc_heap_registry_count].metadata_ref = metadata_ref;
    iw_gc_heap_registry_entries[iw_gc_heap_registry_count].marked = 0u;
    iw_gc_heap_registry_count += 1u;
    if (iw_gc_heap_registry_bucket_count == 0u || (iw_gc_heap_registry_count * 2u) >= iw_gc_heap_registry_bucket_count) {
        iw_gc_heap_registry_rebuild_index();
    } else {
        iw_gc_heap_registry_insert_index(base, iw_gc_heap_registry_count - 1u);
    }
}

static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry_unlocked(iw_heap_header_t *base) {
    if (base == NULL || iw_gc_heap_registry_bucket_count == 0u) {
        return NULL;
    }
    {
        const size_t mask = iw_gc_heap_registry_bucket_count - 1u;
        size_t bucket = iw_gc_pointer_hash((uintptr_t)base) & mask;
        for (size_t probes = 0u; probes < iw_gc_heap_registry_bucket_count; probes += 1u) {
            const size_t storedIndex = iw_gc_heap_registry_buckets[bucket];
            if (storedIndex == 0u) {
                return NULL;
            }
            if (iw_gc_heap_registry_entries[storedIndex - 1u].base == base) {
                return &iw_gc_heap_registry_entries[storedIndex - 1u];
            }
            bucket = (bucket + 1u) & mask;
        }
    }
    return NULL;
}

static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry(iw_heap_header_t *base) {
    iw_gc_heap_registry_entry_t *entry;
    pthread_mutex_lock(&iw_gc_heap_registry_lock);
    entry = iw_gc_lookup_heap_registry_entry_unlocked(base);
    pthread_mutex_unlock(&iw_gc_heap_registry_lock);
    return entry;
}

static inline void* iw_gc_allocate(size_t total_size_bytes, const iw_runtime_type_info_t *type_info, iw_gc_metadata_ref_t metadata_ref, const char *context) {
    const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(metadata_ref);
    if (metadata == NULL || metadata->kind != IW_GC_METADATA_HEAP) {
        fprintf(stderr, "Ironwall GC missing heap metadata in %s\n", context);
        abort();
    }
    iw_heap_header_t *header = (iw_heap_header_t*)calloc(1, total_size_bytes);
    if (header == NULL) {
        fprintf(stderr, "Ironwall allocation failed in %s\n", context);
        abort();
    }
    header->tag = type_info->tag;
    header->type_info = type_info;
    return header;
}

static inline void iw_gc_publish_allocation(iw_heap_header_t *base, size_t total_size_bytes, iw_gc_metadata_ref_t metadata_ref) {
    pthread_mutex_lock(&iw_gc_heap_registry_lock);
    iw_gc_heap_registry_append(base, total_size_bytes, metadata_ref);
    pthread_mutex_unlock(&iw_gc_heap_registry_lock);
}

static inline const iw_gc_metadata_entry_t* iw_gc_validate_heap_header_for_gc_unlocked(iw_heap_header_t *header, const char *context);

static inline iw_heap_header_t* iw_expect_heap_header(iw_value_t raw_value, const char *context) {
    if (!iw_is_heap_value(raw_value)) {
        fprintf(stderr, "Ironwall expected heap value in %s\n", context);
        abort();
    }
    iw_heap_header_t *header = (iw_heap_header_t*)(intptr_t)raw_value;
    if (header == NULL || header->type_info == NULL) {
        fprintf(stderr, "Ironwall invalid heap header in %s\n", context);
        abort();
    }
    if (header->tag != header->type_info->tag) {
        fprintf(stderr, "Ironwall invalid heap runtime tag in %s\n", context);
        abort();
    }
    {
        iw_gc_heap_registry_entry_t *entry;
        pthread_mutex_lock(&iw_gc_heap_registry_lock);
        entry = iw_gc_lookup_heap_registry_entry_unlocked(header);
        if (entry != NULL && iw_gc_validate_heap_header_for_gc_unlocked(header, context) == NULL) {
            pthread_mutex_unlock(&iw_gc_heap_registry_lock);
            fprintf(stderr, "Ironwall invalid managed heap header in %s\n", context);
            abort();
        }
        pthread_mutex_unlock(&iw_gc_heap_registry_lock);
    }
    return header;
}

static inline void iw_gc_mark_heap_header(iw_heap_header_t *header);
static inline void iw_gc_mark_value(iw_value_t value);

static inline void iw_gc_clear_heap_marks(void) {
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        iw_gc_heap_registry_entries[index].marked = 0u;
    }
}

static inline void iw_gc_mark_slot_range(const unsigned char *base, const iw_runtime_slot_info_t *slots, uint32_t slot_count) {
    for (uint32_t index = 0u; index < slot_count; index += 1u) {
        const iw_value_t *slot = (const iw_value_t*)(base + slots[index].offset);
        iw_gc_mark_value(*slot);
    }
}

static inline void iw_gc_mark_frame_slots(const unsigned char *base, uint32_t slot_count) {
    for (uint32_t index = 0u; index < slot_count; index += 1u) {
        const iw_value_t *slot = (const iw_value_t*)(base + sizeof(uint64_t) + ((size_t)index * sizeof(iw_value_t)));
        iw_gc_mark_value(*slot);
    }
}

static inline void iw_gc_mark_variable_members(const iw_gc_metadata_entry_t *metadata, const unsigned char *base) {
    if (metadata->variable_member_kind != IW_GC_VARIABLE_MEMBER_VALUE) {
        return;
    }
    {
        const size_t count = iw_gc_length_value(metadata, base);
        const iw_value_t *items = (const iw_value_t*)iw_gc_variable_member_base(metadata, base);
        for (size_t index = 0u; index < count; index += 1u) {
            iw_gc_mark_value(items[index]);
        }
    }
}

static inline void iw_gc_mark_heap_header(iw_heap_header_t *header) {
    const iw_gc_metadata_entry_t *metadata = iw_gc_validate_heap_header_for_gc_unlocked(header, "gc mark");
    if (metadata == NULL) {
        return;
    }
    {
        iw_gc_heap_registry_entry_t *entry = iw_gc_lookup_heap_registry_entry_unlocked(header);
        if (entry == NULL) {
            return;
        }
        if (entry->marked != 0u) {
            return;
        }
        entry->marked = 1u;
    }
    switch (header->type_info->kind) {
        case IW_RUNTIME_KIND_FLOAT:
        case IW_RUNTIME_KIND_TEXT:
        case IW_RUNTIME_KIND_COMPLEX:
            return;
        case IW_RUNTIME_KIND_ARRAY: {
            iw_gc_mark_variable_members(metadata, (const unsigned char*)header);
            return;
        }
        case IW_RUNTIME_KIND_UNION:
        case IW_RUNTIME_KIND_CLASS:
        case IW_RUNTIME_KIND_CLOSURE:
            iw_gc_mark_slot_range((const unsigned char*)header, header->type_info->gc_slots, header->type_info->gc_slot_count);
            return;
    }
}

static inline void iw_gc_mark_value(iw_value_t value) {
    if (!iw_is_heap_value(value)) {
        return;
    }
    {
        iw_heap_header_t *header = (iw_heap_header_t*)(intptr_t)value;
        if (header == NULL) {
            return;
        }
        if (iw_gc_lookup_heap_registry_entry_unlocked(header) == NULL) {
            return;
        }
        if (header->type_info == NULL) {
            fprintf(stderr, "Ironwall invalid heap root during GC mark\n");
            abort();
        }
        iw_gc_mark_heap_header(header);
    }
}

static inline void iw_gc_mark_global_tables(void) {
    for (size_t index = 0u; index < iw_gc_all_global_table_count; index += 1u) {
        const iw_gc_global_table_t *table = iw_gc_all_global_tables[index];
        if (table == NULL) {
            continue;
        }
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(table->metadata_ref);
        if (metadata == NULL || metadata->kind != IW_GC_METADATA_GLOBAL) {
            fprintf(stderr, "Ironwall GC missing global metadata during mark\n");
            abort();
        }
        if (!iw_gc_validate_tagged_block(table->block_base, metadata)) {
            fprintf(stderr, "Ironwall GC global aggregate validation failed during mark\n");
            abort();
        }
        iw_gc_mark_slot_range((const unsigned char*)table->block_base, table->slots, table->slot_count);
    }
}

static inline size_t iw_gc_mark_stack_frames_in_range(uintptr_t stack_top, uintptr_t current_sp) {
    uintptr_t low = current_sp < stack_top ? current_sp : stack_top;
    uintptr_t high = current_sp < stack_top ? stack_top : current_sp;
    uintptr_t limit = high + sizeof(uint64_t);
    size_t count = 0u;
    for (uintptr_t cursor = low; cursor + sizeof(uint64_t) <= limit; cursor += sizeof(uint64_t)) {
        const unsigned char *base = (const unsigned char*)(uintptr_t)cursor;
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_frame_metadata(base, (size_t)(limit - cursor));
        if (metadata == NULL) {
            continue;
        }
        iw_gc_mark_frame_slots(base, metadata->slot_count);
        count += 1u;
        cursor += metadata->fixed_size_bytes - sizeof(uint64_t);
    }
    return count;
}

static inline size_t iw_gc_mark_all_thread_stack_frames(void) {
    size_t count = 0u;
    for (iw_gc_thread_state_t *thread = iw_gc_thread_list; thread != NULL; thread = thread->next) {
        if (thread->stack_top == 0u || thread->safepoint_sp == 0u) {
            continue;
        }
        count += iw_gc_mark_stack_frames_in_range(thread->stack_top, thread->safepoint_sp);
    }
    return count;
}

static inline size_t iw_gc_sweep_unmarked_heap_objects(void) {
    size_t write_index = 0u;
    size_t reclaimed = 0u;
    for (size_t read_index = 0u; read_index < iw_gc_heap_registry_count; read_index += 1u) {
        iw_gc_heap_registry_entry_t entry = iw_gc_heap_registry_entries[read_index];
        if (entry.base == NULL) {
            continue;
        }
        if (entry.marked == 0u) {
            free(entry.base);
            reclaimed += 1u;
            continue;
        }
        entry.marked = 0u;
        iw_gc_heap_registry_entries[write_index] = entry;
        write_index += 1u;
    }
    for (size_t index = write_index; index < iw_gc_heap_registry_count; index += 1u) {
        iw_gc_heap_registry_entries[index].base = NULL;
        iw_gc_heap_registry_entries[index].total_size_bytes = 0u;
        iw_gc_heap_registry_entries[index].metadata_ref = (iw_gc_metadata_ref_t){ 0ULL, 0ULL };
        iw_gc_heap_registry_entries[index].marked = 0u;
    }
    iw_gc_heap_registry_count = write_index;
    iw_gc_heap_registry_rebuild_index();
    return reclaimed;
}

__IW_TEMPLATE_GC_LINKED_RUNTIME_INIT_DECLARATIONS__

static inline void iw_gc_runtime_global_init_once(void) {
    iw_gc_init_all_metadata_tables();
    iw_gc_init_all_global_tables();
__IW_TEMPLATE_GC_GLOBAL_INIT_LINES__
__IW_TEMPLATE_GC_LINKED_RUNTIME_INIT_CALLS__
}

static inline int iw_gc_ensure_current_thread_attached(uintptr_t stack_top) {
    pthread_once(&iw_gc_runtime_once, iw_gc_runtime_global_init_once);
    if (iw_gc_current_thread != NULL) {
        if (stack_top > iw_gc_current_thread->stack_top) {
            iw_gc_current_thread->stack_top = stack_top;
        }
        iw_gc_current_thread->safepoint_sp = stack_top;
        return 0;
    }
    {
        iw_gc_thread_state_t *state = (iw_gc_thread_state_t*)calloc(1u, sizeof(iw_gc_thread_state_t));
        if (state == NULL) {
            fprintf(stderr, "Ironwall GC failed to allocate thread state\n");
            abort();
        }
        state->thread = pthread_self();
        state->tid = (pid_t)syscall(SYS_gettid);
        state->stack_top = stack_top;
        state->safepoint_sp = stack_top;
        pthread_mutex_lock(&iw_gc_world_lock);
        while (iw_gc_stop_requested || iw_gc_collection_in_progress) {
            pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
        }
        state->next = iw_gc_thread_list;
        iw_gc_thread_list = state;
        iw_gc_thread_count += 1u;
        iw_gc_current_thread = state;
        pthread_mutex_unlock(&iw_gc_world_lock);
        return 1;
    }
}

static inline void iw_gc_detach_current_thread(void) {
    iw_gc_thread_state_t *state = iw_gc_current_thread;
    if (state == NULL) {
        return;
    }
    uintptr_t current_sp = (uintptr_t)&state;
    pthread_mutex_lock(&iw_gc_world_lock);
    while (iw_gc_stop_requested || iw_gc_collection_in_progress) {
        state->safepoint_sp = current_sp;
        if (state->parked == 0u) {
            state->parked = 1u;
            iw_gc_parked_thread_count += 1u;
            pthread_cond_broadcast(&iw_gc_world_cond);
        }
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    {
        iw_gc_thread_state_t **link = &iw_gc_thread_list;
        while (*link != NULL && *link != state) {
            link = &(*link)->next;
        }
        if (*link == state) {
            *link = state->next;
            if (state->parked != 0u) {
                state->parked = 0u;
                if (iw_gc_parked_thread_count > 0u) {
                    iw_gc_parked_thread_count -= 1u;
                }
            }
            if (iw_gc_thread_count > 0u) {
                iw_gc_thread_count -= 1u;
            }
        }
    }
    iw_gc_current_thread = NULL;
    pthread_cond_broadcast(&iw_gc_world_cond);
    pthread_mutex_unlock(&iw_gc_world_lock);
    free(state);
}

static inline void iw_gc_safepoint_poll(uintptr_t current_sp) {
    iw_gc_thread_state_t *state = iw_gc_current_thread;
    if (state == NULL) {
        return;
    }
    state->safepoint_sp = current_sp;
    if (!iw_gc_stop_requested) {
        return;
    }
    pthread_mutex_lock(&iw_gc_world_lock);
    state = iw_gc_current_thread;
    if (state == NULL) {
        pthread_mutex_unlock(&iw_gc_world_lock);
        return;
    }
    state->safepoint_sp = current_sp;
    if (!iw_gc_stop_requested || (iw_gc_collection_in_progress && pthread_equal(iw_gc_collector_thread, state->thread))) {
        pthread_mutex_unlock(&iw_gc_world_lock);
        return;
    }
    if (state->parked == 0u) {
        state->parked = 1u;
        iw_gc_parked_thread_count += 1u;
        pthread_cond_broadcast(&iw_gc_world_cond);
    }
    while (iw_gc_stop_requested) {
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    if (state->parked != 0u) {
        state->parked = 0u;
        if (iw_gc_parked_thread_count == 0u) {
            fprintf(stderr, "Ironwall GC parked thread count underflow\n");
            abort();
        }
        iw_gc_parked_thread_count -= 1u;
        pthread_cond_broadcast(&iw_gc_world_cond);
    }
    pthread_mutex_unlock(&iw_gc_world_lock);
}

static inline void iw_gc_blocking_section_begin(uintptr_t current_sp) {
    iw_gc_thread_state_t *state = iw_gc_current_thread;
    if (state == NULL) {
        return;
    }
    pthread_mutex_lock(&iw_gc_world_lock);
    state = iw_gc_current_thread;
    if (state == NULL) {
        pthread_mutex_unlock(&iw_gc_world_lock);
        return;
    }
    state->safepoint_sp = current_sp;
    state->blocking_depth += 1u;
    if (state->parked == 0u) {
        state->parked = 1u;
        iw_gc_parked_thread_count += 1u;
        pthread_cond_broadcast(&iw_gc_world_cond);
    }
    while (iw_gc_stop_requested && !(iw_gc_collection_in_progress && pthread_equal(iw_gc_collector_thread, state->thread))) {
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    pthread_mutex_unlock(&iw_gc_world_lock);
}

static inline void iw_gc_blocking_section_end(void) {
    iw_gc_thread_state_t *state = iw_gc_current_thread;
    if (state == NULL) {
        return;
    }
    pthread_mutex_lock(&iw_gc_world_lock);
    state = iw_gc_current_thread;
    if (state == NULL) {
        pthread_mutex_unlock(&iw_gc_world_lock);
        return;
    }
    while (iw_gc_stop_requested && !(iw_gc_collection_in_progress && pthread_equal(iw_gc_collector_thread, state->thread))) {
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    if (state->blocking_depth == 0u) {
        pthread_mutex_unlock(&iw_gc_world_lock);
        fprintf(stderr, "Ironwall GC blocking depth underflow\n");
        abort();
    }
    state->blocking_depth -= 1u;
    if (state->blocking_depth == 0u && state->parked != 0u) {
        if (iw_gc_parked_thread_count == 0u) {
            pthread_mutex_unlock(&iw_gc_world_lock);
            fprintf(stderr, "Ironwall GC parked thread count underflow\n");
            abort();
        }
        state->parked = 0u;
        iw_gc_parked_thread_count -= 1u;
        pthread_cond_broadcast(&iw_gc_world_cond);
    }
    pthread_mutex_unlock(&iw_gc_world_lock);
}

static inline void iw_gc_begin_stop_the_world(uintptr_t current_sp) {
    (void)iw_gc_ensure_current_thread_attached(current_sp);
    pthread_mutex_lock(&iw_gc_world_lock);
    while (iw_gc_collection_in_progress) {
        if (pthread_equal(iw_gc_collector_thread, pthread_self())) {
            fprintf(stderr, "Ironwall GC does not support nested collections\n");
            abort();
        }
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    iw_gc_current_thread->safepoint_sp = current_sp;
    iw_gc_collector_thread = pthread_self();
    iw_gc_collection_in_progress = 1;
    iw_gc_stop_requested = 1;
    while (iw_gc_parked_thread_count + 1u < iw_gc_thread_count) {
        pthread_cond_broadcast(&iw_gc_world_cond);
        pthread_cond_wait(&iw_gc_world_cond, &iw_gc_world_lock);
    }
    pthread_mutex_unlock(&iw_gc_world_lock);
    pthread_mutex_lock(&iw_gc_heap_registry_lock);
}

static inline void iw_gc_end_stop_the_world(void) {
    pthread_mutex_unlock(&iw_gc_heap_registry_lock);
    pthread_mutex_lock(&iw_gc_world_lock);
    iw_gc_stop_requested = 0;
    iw_gc_collection_in_progress = 0;
    pthread_cond_broadcast(&iw_gc_world_cond);
    pthread_mutex_unlock(&iw_gc_world_lock);
}

static inline void iw_gc_init_runtime(uintptr_t stack_top) {
    (void)iw_gc_ensure_current_thread_attached(stack_top);
}

__IW_TEMPLATE_GC_EXPORTED_RUNTIME_INIT_LINES__

static inline void iw_gc_run_collect_core_mark(void) {
    iw_gc_clear_heap_marks();
    iw_gc_mark_global_tables();
    iw_gc_mark_all_thread_stack_frames();
    iw_gc_mark_thread_runtime_roots();
}

static inline void iw_gc_run_collect_core_sweep(iw_gc_cycle_report_t *report) {
    report->reclaimed_count = iw_gc_sweep_unmarked_heap_objects();
}

static inline iw_value_t iw_gc_collect(void) {
    uintptr_t current_sp = (uintptr_t)&current_sp;
    iw_gc_begin_stop_the_world(current_sp);
    {
        iw_gc_cycle_report_t report = { 0u, 0u, 0u, 0u, 0u };
        iw_gc_run_validation_pass_before_collect(&report);
        iw_gc_run_print_pass_before_collect(&report);
        iw_gc_run_collect_core_mark();
        iw_gc_run_print_pass_after_mark(&report);
        iw_gc_run_validation_pass_after_mark(&report);
        iw_gc_run_collect_core_sweep(&report);
        iw_gc_run_validation_pass_after_sweep(&report);
        iw_gc_run_print_pass_after_sweep(&report);
        iw_gc_end_stop_the_world();
        return iw_from_i64((int64_t)report.reclaimed_count);
    }
}