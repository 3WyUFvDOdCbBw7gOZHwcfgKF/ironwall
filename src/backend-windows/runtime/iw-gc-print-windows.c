static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry(iw_heap_header_t *base);
static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry_unlocked(iw_heap_header_t *base);
static inline const iw_gc_metadata_entry_t* iw_gc_validate_heap_header_for_gc_unlocked(iw_heap_header_t *header, const char *context);
static const size_t iw_gc_max_verbose_heap_entries = __IW_TEMPLATE_GC_MAX_VERBOSE_HEAP_ENTRIES__u;

static inline int iw_gc_print_pass_enabled(void) {
    static int cached = -1;
    if (cached >= 0) {
        return cached;
    }
    {
        const char *value = getenv("IW_GC_PRINT");
        if (value != NULL && (strcmp(value, "0") == 0 || strcmp(value, "false") == 0 || strcmp(value, "off") == 0)) {
            cached = 0;
        } else {
            cached = 1;
        }
    }
    return cached;
}

static inline void iw_gc_print_escaped_bytes(const char *data, size_t length) {
    for (size_t index = 0u; index < length; index += 1u) {
        const unsigned char ch = (const unsigned char)data[index];
        switch (ch) {
            case 92u:
                putchar(92);
                putchar(92);
                break;
            case 34u:
                putchar(92);
                putchar(34);
                break;
            case '\n':
                printf("\\n");
                break;
            case '\r':
                printf("\\r");
                break;
            case '\t':
                printf("\\t");
                break;
            default:
                if (ch >= 32u && ch <= 126u) {
                    putchar((int)ch);
                } else {
                    printf("\\x%02x", (unsigned)ch);
                }
                break;
        }
    }
}

static inline void iw_gc_print_value_summary(iw_value_t value) {
    if (value == (iw_value_t)0) {
        printf("null");
        return;
    }
    if (!iw_is_heap_value(value)) {
        printf("imm(%lld)", (long long)iw_as_i64(value));
        return;
    }
    {
        iw_heap_header_t *header = (iw_heap_header_t*)(intptr_t)value;
        iw_gc_heap_registry_entry_t *entry = header != NULL ? iw_gc_lookup_heap_registry_entry_unlocked(header) : NULL;
        if (header == NULL || entry == NULL) {
            printf("raw@%p", (void*)header);
            return;
        }
        {
            const iw_gc_metadata_entry_t *metadata = iw_gc_validate_heap_header_for_gc_unlocked(header, "gc value summary");
            const char *name = metadata != NULL ? metadata->name : "heap";
            switch (header->type_info->kind) {
                case IW_RUNTIME_KIND_TEXT: {
                    const iw_text_value_t *text = (const iw_text_value_t*)header;
                    printf("%s@%p=\"", name, (const void*)header);
                    iw_gc_print_escaped_bytes(text->data, (size_t)text->length);
                    printf("\"");
                    return;
                }
                case IW_RUNTIME_KIND_FLOAT: {
                    const iw_float_value_t *boxed = (const iw_float_value_t*)header;
                    printf("%s@%p=%.9Lg", name, (const void*)header, boxed->value);
                    return;
                }
                case IW_RUNTIME_KIND_COMPLEX: {
                    const iw_complex_value_t *boxed = (const iw_complex_value_t*)header;
                    printf("%s@%p=(%.9Lg,%.9Lg)", name, (const void*)header, boxed->real, boxed->imag);
                    return;
                }
                default:
                    printf("%s@%p", name, (const void*)header);
                    return;
            }
        }
    }
}

__IW_TEMPLATE_GC_CLASS_CONTENT_PRINTER__

__IW_TEMPLATE_GC_FRAME_CONTENT_PRINTER__

static inline void iw_gc_print_global_tables(void) {
    for (size_t index = 0u; index < iw_gc_all_global_table_count; index += 1u) {
        const iw_gc_global_table_t *table = iw_gc_all_global_tables[index];
        if (table == NULL) {
            continue;
        }
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(table->metadata_ref);
        if (metadata == NULL || metadata->kind != IW_GC_METADATA_GLOBAL) {
            fprintf(stderr, "Ironwall GC missing global metadata during print\n");
            abort();
        }
        printf("gc-global %s addr=%p size=%zu slots=%u\n", metadata->name, table->block_base, iw_gc_total_size_bytes(metadata, table->block_base), metadata->slot_count);
        if (table->print_live != NULL) {
            table->print_live();
        }
    }
}

static inline size_t iw_gc_scan_stack_and_print_for_thread(pid_t tid, uintptr_t stack_top, uintptr_t current_sp) {
    uintptr_t low = current_sp < stack_top ? current_sp : stack_top;
    uintptr_t high = current_sp < stack_top ? stack_top : current_sp;
    uintptr_t limit = high + sizeof(uint64_t);
    size_t count = 0u;
    printf("gc-thread tid=%lld sp=%p top=%p\n", (long long)tid, (void*)current_sp, (void*)stack_top);
    for (uintptr_t cursor = low; cursor + sizeof(uint64_t) <= limit; cursor += sizeof(uint64_t)) {
        const unsigned char *base = (const unsigned char*)(uintptr_t)cursor;
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_frame_metadata(base, (size_t)(limit - cursor));
        if (metadata == NULL) {
            continue;
        }
        printf("gc-frame %s addr=%p size=%zu slots=%u\n", metadata->name, (const void*)base, metadata->fixed_size_bytes, metadata->slot_count);
        iw_gc_print_live_frame(metadata, (const void*)base);
        count += 1u;
        cursor += metadata->fixed_size_bytes - sizeof(uint64_t);
    }
    return count;
}

static inline size_t iw_gc_scan_all_thread_stacks_and_print(void) {
    size_t count = 0u;
    for (iw_gc_thread_state_t *thread = iw_gc_thread_list; thread != NULL; thread = thread->next) {
        if (thread->stack_top == 0u || thread->safepoint_sp == 0u) {
            continue;
        }
        count += iw_gc_scan_stack_and_print_for_thread(thread->tid, thread->stack_top, thread->safepoint_sp);
    }
    return count;
}

static inline size_t iw_gc_print_heap_registry(void) {
    size_t count = 0u;
    size_t printed_count = 0u;
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        iw_gc_heap_registry_entry_t *entry = &iw_gc_heap_registry_entries[index];
        const iw_gc_metadata_entry_t *metadata;
        if (entry->base == NULL) {
            continue;
        }
        {
            metadata = iw_gc_validate_heap_header_for_gc_unlocked(entry->base, "gc heap print");
            if (metadata == NULL) {
                fprintf(stderr, "Ironwall GC heap registry entry missing exact-base validation\n");
                abort();
            }
            const size_t computed_size = iw_gc_total_size_bytes(metadata, entry->base);
            if (computed_size != entry->total_size_bytes) {
                fprintf(stderr, "Ironwall GC heap registry size mismatch for %s\n", metadata->name);
                abort();
            }
            count += 1u;
            if (printed_count < iw_gc_max_verbose_heap_entries) {
                printf("gc-heap %s base=%p end=%p size=%zu runtime_tag=0x%llx\n", metadata->name, (void*)entry->base, (void*)((unsigned char*)entry->base + computed_size), computed_size, (unsigned long long)entry->base->tag);
                printed_count += 1u;
            }
        }
    }
    if (count > printed_count) {
        printf("gc-heap-truncated printed=%zu omitted=%zu total=%zu\n", printed_count, count - printed_count, count);
    }
    return count;
}

static inline void iw_gc_print_live_heap_object(const iw_gc_heap_registry_entry_t *entry, const iw_gc_metadata_entry_t *metadata) {
    const iw_runtime_type_info_t *type_info = entry->base->type_info;
    if (type_info == NULL) {
        fprintf(stderr, "Ironwall GC live object missing runtime type info\n");
        abort();
    }
    switch (type_info->kind) {
        case IW_RUNTIME_KIND_TEXT: {
            const iw_text_value_t *text = (const iw_text_value_t*)entry->base;
            printf("gc-live-heap %s base=%p length=%u data=\"", metadata->name, (const void*)entry->base, (unsigned)text->length);
            iw_gc_print_escaped_bytes(text->data, (size_t)text->length);
            printf("\"\n");
            return;
        }
        case IW_RUNTIME_KIND_ARRAY: {
            const iw_array_value_t *array = (const iw_array_value_t*)entry->base;
            printf("gc-live-heap %s base=%p length=%lld items=[", metadata->name, (const void*)entry->base, (long long)array->length);
            for (int64_t index = 0; index < array->length; index += 1) {
                if (index > 0) {
                    printf(", ");
                }
                iw_gc_print_value_summary(array->items[index]);
            }
            printf("]\n");
            return;
        }
        case IW_RUNTIME_KIND_CLASS: {
            printf("gc-live-heap %s base=%p", metadata->name, (const void*)entry->base);
            if (!iw_gc_print_compiled_class_fields(entry->base)) {
                printf(" refs={");
                for (uint32_t index = 0u; index < type_info->gc_slot_count; index += 1u) {
                    const iw_value_t *slot = (const iw_value_t*)((const unsigned char*)entry->base + type_info->gc_slots[index].offset);
                    if (index > 0u) {
                        printf(", ");
                    }
                    printf("%s=", type_info->gc_slots[index].name);
                    iw_gc_print_value_summary(*slot);
                }
                printf("}");
            }
            printf("\n");
            return;
        }
        case IW_RUNTIME_KIND_UNION: {
            const iw_union_value_t *union_value = (const iw_union_value_t*)entry->base;
            printf("gc-live-heap %s base=%p member_tag=0x%llx payload=", metadata->name, (const void*)entry->base, (unsigned long long)union_value->member_tag);
            iw_gc_print_value_summary(union_value->payload);
            printf("\n");
            return;
        }
        case IW_RUNTIME_KIND_CLOSURE: {
            const iw_closure_value_t *closure = (const iw_closure_value_t*)entry->base;
            const char *apply_symbol = type_info->closure_apply_symbol != NULL ? type_info->closure_apply_symbol : "<unknown>";
            printf("gc-live-heap %s base=%p arity=%u apply=%s env=", metadata->name, (const void*)entry->base, (unsigned)closure->arity, apply_symbol);
            iw_gc_print_value_summary(closure->env);
            printf("\n");
            return;
        }
        case IW_RUNTIME_KIND_FLOAT: {
            const iw_float_value_t *boxed = (const iw_float_value_t*)entry->base;
            printf("gc-live-heap %s base=%p value=%.9Lg\n", metadata->name, (const void*)entry->base, boxed->value);
            return;
        }
        case IW_RUNTIME_KIND_COMPLEX: {
            const iw_complex_value_t *boxed = (const iw_complex_value_t*)entry->base;
            printf("gc-live-heap %s base=%p real=%.9Lg imag=%.9Lg\n", metadata->name, (const void*)entry->base, boxed->real, boxed->imag);
            return;
        }
    }
}

static inline size_t iw_gc_print_live_heap_objects(void) {
    size_t count = 0u;
    size_t printed_count = 0u;
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        const iw_gc_heap_registry_entry_t *entry = &iw_gc_heap_registry_entries[index];
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(entry->metadata_ref);
        if (entry->base == NULL || metadata == NULL || entry->marked == 0u) {
            continue;
        }
        count += 1u;
        if (printed_count < iw_gc_max_verbose_heap_entries) {
            iw_gc_print_live_heap_object(entry, metadata);
            printed_count += 1u;
        }
    }
    if (count > printed_count) {
        printf("gc-live-heap-truncated printed=%zu omitted=%zu total=%zu\n", printed_count, count - printed_count, count);
    }
    return count;
}

static inline void iw_gc_print_collection_summaries(const iw_gc_cycle_report_t *report) {
    printf("gc-live-summary live_heap=%zu dead_heap=%zu\n", report->live_heap_count, report->dead_heap_count);
    printf("gc-summary frames=%zu heap=%zu\n", report->frame_count, report->heap_count);
    printf("gc-sweep-summary reclaimed=%zu remaining_heap=%zu\n", report->reclaimed_count, iw_gc_heap_registry_count);
}

static inline void iw_gc_run_print_pass_before_collect(iw_gc_cycle_report_t *report) {
    if (!iw_gc_print_pass_enabled()) {
        return;
    }
    iw_gc_print_global_tables();
    report->frame_count = iw_gc_scan_all_thread_stacks_and_print();
    report->heap_count = iw_gc_print_heap_registry();
}

static inline void iw_gc_run_print_pass_after_mark(iw_gc_cycle_report_t *report) {
    if (!iw_gc_print_pass_enabled()) {
        return;
    }
    report->live_heap_count = iw_gc_print_live_heap_objects();
}

static inline void iw_gc_run_print_pass_after_sweep(const iw_gc_cycle_report_t *report) {
    if (!iw_gc_print_pass_enabled()) {
        return;
    }
    iw_gc_print_collection_summaries(report);
}