typedef struct iw_gc_cycle_report_t { size_t frame_count; size_t heap_count; size_t live_heap_count; size_t dead_heap_count; size_t reclaimed_count; } iw_gc_cycle_report_t;

static inline iw_gc_heap_registry_entry_t* iw_gc_lookup_heap_registry_entry_unlocked(iw_heap_header_t *base);
static inline uint64_t iw_gc_end_confirmation_value(const iw_gc_metadata_entry_t *metadata);

static inline uint64_t iw_gc_mix_u64(uint64_t value) {
    uint64_t mixed = value;
    mixed ^= mixed >> 33;
    mixed *= 0xff51afd7ed558ccdULL;
    mixed ^= mixed >> 33;
    mixed *= 0xc4ceb9fe1a85ec53ULL;
    mixed ^= mixed >> 33;
    return mixed;
}

static inline uint64_t iw_gc_hash_combine_u64(uint64_t state, uint64_t word) {
    return iw_gc_mix_u64(state ^ word ^ 0x9e3779b97f4a7c15ULL);
}

static inline uint16_t iw_gc_first_tag_confirmation16(uint64_t struct_hash48) {
    return (uint16_t)(iw_gc_mix_u64(struct_hash48 ^ 0xa5c9d3e17b2f0461ULL) & 0xffffULL);
}

static inline int iw_gc_first_tag_looks_valid(uint64_t first_tag) {
    const uint64_t struct_hash48 = first_tag >> 16;
    return (uint16_t)(first_tag & 0xffffULL) == iw_gc_first_tag_confirmation16(struct_hash48);
}

static inline size_t iw_gc_metadata_lookup_hash(uint64_t first_tag) {
    return (size_t)iw_gc_mix_u64(first_tag);
}

static inline size_t iw_gc_metadata_ref_lookup_hash(uint64_t first_tag, uint64_t end_confirmation) {
    return (size_t)iw_gc_hash_combine_u64(iw_gc_mix_u64(first_tag), end_confirmation);
}

static inline size_t iw_gc_metadata_key_lookup_hash(uint64_t uuid_hi, uint64_t uuid_lo, uint64_t uuid_hash) {
    uint64_t state = iw_gc_hash_combine_u64(uuid_hash, uuid_hi);
    state = iw_gc_hash_combine_u64(state, uuid_lo);
    return (size_t)state;
}

static inline void iw_gc_free_metadata_lookup_indexes(void) {
    if (iw_gc_metadata_lookup_buckets != NULL) {
        for (size_t bucket = 0u; bucket < iw_gc_metadata_lookup_bucket_count; bucket += 1u) {
            iw_gc_metadata_lookup_node_t *node = iw_gc_metadata_lookup_buckets[bucket];
            while (node != NULL) {
                iw_gc_metadata_lookup_node_t *next = node->next;
                free(node);
                node = next;
            }
        }
        free(iw_gc_metadata_lookup_buckets);
        iw_gc_metadata_lookup_buckets = NULL;
    }
    iw_gc_metadata_lookup_bucket_count = 0u;
    if (iw_gc_metadata_ref_lookup_buckets != NULL) {
        free(iw_gc_metadata_ref_lookup_buckets);
        iw_gc_metadata_ref_lookup_buckets = NULL;
    }
    iw_gc_metadata_ref_lookup_bucket_count = 0u;
    if (iw_gc_metadata_key_lookup_buckets != NULL) {
        free(iw_gc_metadata_key_lookup_buckets);
        iw_gc_metadata_key_lookup_buckets = NULL;
    }
    iw_gc_metadata_key_lookup_bucket_count = 0u;
}

static inline int iw_gc_metadata_key_exists(uint64_t uuid_hi, uint64_t uuid_lo, uint64_t uuid_hash) {
    if (iw_gc_metadata_key_lookup_bucket_count == 0u) {
        return 0;
    }
    const size_t mask = iw_gc_metadata_key_lookup_bucket_count - 1u;
    size_t bucket = iw_gc_metadata_key_lookup_hash(uuid_hi, uuid_lo, uuid_hash) & mask;
    for (size_t probes = 0u; probes < iw_gc_metadata_key_lookup_bucket_count; probes += 1u) {
        const iw_gc_metadata_key_lookup_bucket_t *bucket_entry = &iw_gc_metadata_key_lookup_buckets[bucket];
        if (bucket_entry->key == NULL) {
            return 0;
        }
        if (bucket_entry->uuid_hi == uuid_hi && bucket_entry->uuid_lo == uuid_lo && bucket_entry->uuid_hash == uuid_hash) {
            return 1;
        }
        bucket = (bucket + 1u) & mask;
    }
    return 0;
}

static inline void iw_gc_insert_metadata_key_lookup_entry(const iw_gc_metadata_key_t *key) {
    if (key == NULL) {
        return;
    }
    const size_t mask = iw_gc_metadata_key_lookup_bucket_count - 1u;
    size_t bucket = iw_gc_metadata_key_lookup_hash(key->uuid_hi, key->uuid_lo, key->uuid_hash) & mask;
    for (size_t probes = 0u; probes < iw_gc_metadata_key_lookup_bucket_count; probes += 1u) {
        iw_gc_metadata_key_lookup_bucket_t *bucket_entry = &iw_gc_metadata_key_lookup_buckets[bucket];
        if (bucket_entry->key == NULL) {
            bucket_entry->uuid_hi = key->uuid_hi;
            bucket_entry->uuid_lo = key->uuid_lo;
            bucket_entry->uuid_hash = key->uuid_hash;
            bucket_entry->key = key;
            return;
        }
        if (bucket_entry->uuid_hi == key->uuid_hi && bucket_entry->uuid_lo == key->uuid_lo && bucket_entry->uuid_hash == key->uuid_hash) {
            return;
        }
        bucket = (bucket + 1u) & mask;
    }
    fprintf(stderr, "Ironwall GC metadata key lookup table is full\n");
    abort();
}

static inline void iw_gc_insert_metadata_first_tag_candidate(const iw_gc_metadata_entry_t *entry) {
    const size_t mask = iw_gc_metadata_lookup_bucket_count - 1u;
    const size_t bucket = iw_gc_metadata_lookup_hash(entry->first_tag) & mask;
    iw_gc_metadata_lookup_node_t *node = (iw_gc_metadata_lookup_node_t*)calloc(1u, sizeof(iw_gc_metadata_lookup_node_t));
    if (node == NULL) {
        fprintf(stderr, "Ironwall GC metadata lookup allocation failed\n");
        abort();
    }
    node->entry = entry;
    node->next = iw_gc_metadata_lookup_buckets[bucket];
    iw_gc_metadata_lookup_buckets[bucket] = node;
}

static inline int iw_gc_metadata_entries_equivalent(const iw_gc_metadata_entry_t *left, const iw_gc_metadata_entry_t *right) {
    return left->table_uuid_hi == right->table_uuid_hi
        && left->table_uuid_lo == right->table_uuid_lo
        && left->table_uuid_hash == right->table_uuid_hash
        && left->struct_uuid_hi == right->struct_uuid_hi
        && left->struct_uuid_lo == right->struct_uuid_lo
        && left->first_tag == right->first_tag
        && left->struct_uuid_hash == right->struct_uuid_hash
        && left->layout_hash == right->layout_hash
        && left->static_info_hash == right->static_info_hash
        && left->kind == right->kind
        && left->length_kind == right->length_kind
        && left->fixed_size_bytes == right->fixed_size_bytes
        && left->length_offset_bytes == right->length_offset_bytes
        && left->length_scale_bytes == right->length_scale_bytes
        && left->length_bias_bytes == right->length_bias_bytes
        && left->variable_member_kind == right->variable_member_kind
        && left->slot_count == right->slot_count
        && left->structure_only == right->structure_only;
}

static inline void iw_gc_insert_metadata_ref_lookup_entry(const iw_gc_metadata_entry_t *entry) {
    const uint64_t end_confirmation = iw_gc_end_confirmation_value(entry);
    const size_t mask = iw_gc_metadata_ref_lookup_bucket_count - 1u;
    size_t bucket = iw_gc_metadata_ref_lookup_hash(entry->first_tag, end_confirmation) & mask;
    for (size_t probes = 0u; probes < iw_gc_metadata_ref_lookup_bucket_count; probes += 1u) {
        iw_gc_metadata_ref_lookup_bucket_t *bucket_entry = &iw_gc_metadata_ref_lookup_buckets[bucket];
        if (bucket_entry->entry == NULL) {
            bucket_entry->first_tag = entry->first_tag;
            bucket_entry->end_confirmation = end_confirmation;
            bucket_entry->entry = entry;
            return;
        }
        if (bucket_entry->first_tag == entry->first_tag && bucket_entry->end_confirmation == end_confirmation) {
            if (bucket_entry->entry == entry || iw_gc_metadata_entries_equivalent(bucket_entry->entry, entry)) {
                return;
            }
            fprintf(stderr, "Ironwall GC metadata key collision between '%s' and '%s'\n", bucket_entry->entry->name, entry->name);
            abort();
        }
        bucket = (bucket + 1u) & mask;
    }
    fprintf(stderr, "Ironwall GC metadata ref lookup table is full\n");
    abort();
}

static inline void iw_gc_rebuild_metadata_lookup_indexes(void) {
    size_t total_entries = 0u;
    size_t total_keys = 0u;
    iw_gc_free_metadata_lookup_indexes();
    for (size_t table_index = 0u; table_index < iw_gc_all_metadata_table_count; table_index += 1u) {
        iw_gc_metadata_table_t *table = iw_gc_all_metadata_tables[table_index];
        if (table == NULL) {
            continue;
        }
        total_entries += (size_t)table->entry_count;
        total_keys += (size_t)table->key_count;
    }
    if (total_entries == 0u) {
        return;
    }
    {
        size_t target_bucket_count = 16u;
        while (target_bucket_count < (total_entries * 4u)) {
            target_bucket_count <<= 1u;
        }
        iw_gc_metadata_lookup_buckets = (iw_gc_metadata_lookup_node_t**)calloc(target_bucket_count, sizeof(iw_gc_metadata_lookup_node_t*));
        if (iw_gc_metadata_lookup_buckets == NULL) {
            fprintf(stderr, "Ironwall GC metadata lookup bucket allocation failed\n");
            abort();
        }
        iw_gc_metadata_lookup_bucket_count = target_bucket_count;
    }
    {
        size_t target_bucket_count = 16u;
        while (target_bucket_count < (total_entries * 4u)) {
            target_bucket_count <<= 1u;
        }
        iw_gc_metadata_ref_lookup_buckets = (iw_gc_metadata_ref_lookup_bucket_t*)calloc(target_bucket_count, sizeof(iw_gc_metadata_ref_lookup_bucket_t));
        if (iw_gc_metadata_ref_lookup_buckets == NULL) {
            fprintf(stderr, "Ironwall GC metadata ref lookup bucket allocation failed\n");
            abort();
        }
        iw_gc_metadata_ref_lookup_bucket_count = target_bucket_count;
    }
    if (total_keys > 0u) {
        size_t target_bucket_count = 16u;
        while (target_bucket_count < (total_keys * 4u)) {
            target_bucket_count <<= 1u;
        }
        iw_gc_metadata_key_lookup_buckets = (iw_gc_metadata_key_lookup_bucket_t*)calloc(target_bucket_count, sizeof(iw_gc_metadata_key_lookup_bucket_t));
        if (iw_gc_metadata_key_lookup_buckets == NULL) {
            fprintf(stderr, "Ironwall GC metadata key lookup bucket allocation failed\n");
            abort();
        }
        iw_gc_metadata_key_lookup_bucket_count = target_bucket_count;
    }
    for (size_t table_index = 0u; table_index < iw_gc_all_metadata_table_count; table_index += 1u) {
        iw_gc_metadata_table_t *table = iw_gc_all_metadata_tables[table_index];
        if (table == NULL || table->keys == NULL) {
            continue;
        }
        for (uint32_t key_index = 0u; key_index < table->key_count; key_index += 1u) {
            iw_gc_insert_metadata_key_lookup_entry(&table->keys[key_index]);
        }
    }
    for (size_t table_index = 0u; table_index < iw_gc_all_metadata_table_count; table_index += 1u) {
        iw_gc_metadata_table_t *table = iw_gc_all_metadata_tables[table_index];
        if (table == NULL || table->entries == NULL) {
            continue;
        }
        for (uint32_t entry_index = 0u; entry_index < table->entry_count; entry_index += 1u) {
            const iw_gc_metadata_entry_t *entry = table->entries[entry_index];
            if (entry == NULL) {
                continue;
            }
            if (!iw_gc_metadata_key_exists(entry->table_uuid_hi, entry->table_uuid_lo, entry->table_uuid_hash)) {
                fprintf(stderr, "Ironwall GC metadata entry '%s' has no registered table UUID key\n", entry->name);
                abort();
            }
            iw_gc_insert_metadata_first_tag_candidate(entry);
            iw_gc_insert_metadata_ref_lookup_entry(entry);
        }
    }
}

static inline const iw_gc_metadata_lookup_node_t* iw_gc_lookup_metadata_candidates(uint64_t first_tag) {
    if (!iw_gc_first_tag_looks_valid(first_tag) || iw_gc_metadata_lookup_bucket_count == 0u) {
        return NULL;
    }
    return iw_gc_metadata_lookup_buckets[iw_gc_metadata_lookup_hash(first_tag) & (iw_gc_metadata_lookup_bucket_count - 1u)];
}

static inline int iw_gc_metadata_ref_equals(iw_gc_metadata_ref_t left, iw_gc_metadata_ref_t right) {
    return left.first_tag == right.first_tag && left.end_confirmation == right.end_confirmation;
}

static inline const iw_gc_metadata_entry_t* iw_gc_lookup_metadata_ref(iw_gc_metadata_ref_t metadata_ref) {
    if (!iw_gc_first_tag_looks_valid(metadata_ref.first_tag) || iw_gc_metadata_ref_lookup_bucket_count == 0u) {
        return NULL;
    }
    const size_t mask = iw_gc_metadata_ref_lookup_bucket_count - 1u;
    size_t bucket = iw_gc_metadata_ref_lookup_hash(metadata_ref.first_tag, metadata_ref.end_confirmation) & mask;
    for (size_t probes = 0u; probes < iw_gc_metadata_ref_lookup_bucket_count; probes += 1u) {
        const iw_gc_metadata_ref_lookup_bucket_t *bucket_entry = &iw_gc_metadata_ref_lookup_buckets[bucket];
        if (bucket_entry->entry == NULL) {
            return NULL;
        }
        if (bucket_entry->first_tag == metadata_ref.first_tag && bucket_entry->end_confirmation == metadata_ref.end_confirmation) {
            return bucket_entry->entry;
        }
        bucket = (bucket + 1u) & mask;
    }
    return NULL;
}

static inline iw_gc_metadata_ref_t iw_gc_metadata_ref_for_runtime_type(uint64_t runtime_tag) {
    for (size_t index = 0u; index < sizeof(iw_gc_runtime_type_bindings) / sizeof(iw_gc_runtime_type_bindings[0]); index += 1u) {
        if (iw_gc_runtime_type_bindings[index].runtime_tag == runtime_tag) {
            return iw_gc_runtime_type_bindings[index].metadata_ref;
        }
    }
    return (iw_gc_metadata_ref_t){ 0ULL, 0ULL };
}

static inline size_t iw_gc_length_value(const iw_gc_metadata_entry_t *metadata, const void *base) {
    if (metadata->length_kind == IW_GC_LENGTH_NONE) {
        return 0u;
    }
    if (metadata->length_kind == IW_GC_LENGTH_I64) {
        const int64_t *length_ptr = (const int64_t*)((const unsigned char*)base + metadata->length_offset_bytes);
        if (*length_ptr < 0) {
            fprintf(stderr, "Ironwall GC negative length in metadata '%s'\n", metadata->name);
            abort();
        }
        return (size_t)(*length_ptr);
    }
    {
        const uint32_t *length_ptr = (const uint32_t*)((const unsigned char*)base + metadata->length_offset_bytes);
        return (size_t)(*length_ptr);
    }
}

static inline size_t iw_gc_total_size_bytes(const iw_gc_metadata_entry_t *metadata, const void *base) {
    return metadata->fixed_size_bytes + (iw_gc_length_value(metadata, base) * metadata->length_scale_bytes) + metadata->length_bias_bytes;
}

static inline const unsigned char* iw_gc_variable_member_base(const iw_gc_metadata_entry_t *metadata, const void *base) {
    return (const unsigned char*)base + metadata->fixed_size_bytes;
}

static inline uint64_t iw_gc_end_confirmation_value(const iw_gc_metadata_entry_t *metadata) {
    uint64_t state = 0x6a09e667f3bcc909ULL;
    state = iw_gc_hash_combine_u64(state, metadata->struct_uuid_hi);
    state = iw_gc_hash_combine_u64(state, metadata->struct_uuid_lo);
    state = iw_gc_hash_combine_u64(state, metadata->static_info_hash);
    return state;
}

static inline uint64_t* iw_gc_end_confirmation_slot(void *base, size_t total_size_bytes) {
    return (uint64_t*)((unsigned char*)base + total_size_bytes - sizeof(uint64_t));
}

static inline void iw_gc_write_end_confirmation(void *base, const iw_gc_metadata_entry_t *metadata, size_t total_size_bytes) {
    *iw_gc_end_confirmation_slot(base, total_size_bytes) = iw_gc_end_confirmation_value(metadata);
}

static inline int iw_gc_validate_tagged_block(const void *base, const iw_gc_metadata_entry_t *metadata) {
    if (metadata == NULL) {
        return 0;
    }
    const uint64_t *header_words = (const uint64_t*)base;
    if (!iw_gc_first_tag_looks_valid(header_words[0])) {
        return 0;
    }
    if (header_words[0] != metadata->first_tag) {
        return 0;
    }
    {
        size_t total_size_bytes = iw_gc_total_size_bytes(metadata, base);
        const uint64_t expected_end_confirmation = iw_gc_end_confirmation_value(metadata);
        if (*iw_gc_end_confirmation_slot((void*)base, total_size_bytes) != expected_end_confirmation) {
            return 0;
        }
    }
    if (metadata->variable_member_kind == IW_GC_VARIABLE_MEMBER_BYTE && metadata->length_kind != IW_GC_LENGTH_NONE) {
        const iw_text_value_t *text = (const iw_text_value_t*)base;
        if ((const unsigned char*)text->data != iw_gc_variable_member_base(metadata, base)) {
            return 0;
        }
    }
    return 1;
}

static inline const iw_gc_metadata_entry_t* iw_gc_lookup_frame_metadata(const void *base, size_t available_bytes) {
    const uint64_t first_tag = ((const uint64_t*)base)[0];
    const iw_gc_metadata_lookup_node_t *node = iw_gc_lookup_metadata_candidates(first_tag);
    while (node != NULL) {
        const iw_gc_metadata_entry_t *metadata = node->entry;
        if (metadata != NULL
            && metadata->first_tag == first_tag
            && metadata->kind == IW_GC_METADATA_FRAME
            && metadata->fixed_size_bytes <= available_bytes
            && iw_gc_validate_tagged_block(base, metadata)) {
            return metadata;
        }
        node = node->next;
    }
    return NULL;
}

static inline const iw_gc_metadata_entry_t* iw_gc_validate_heap_header_for_gc_unlocked(iw_heap_header_t *header, const char *context) {
    if (header == NULL || header->type_info == NULL) {
        fprintf(stderr, "Ironwall invalid heap header in %s\n", context);
        abort();
    }
    if (header->tag != header->type_info->tag) {
        fprintf(stderr, "Ironwall heap runtime tag/type mismatch in %s\n", context);
        abort();
    }
    {
        iw_gc_heap_registry_entry_t *entry = iw_gc_lookup_heap_registry_entry_unlocked(header);
        if (entry == NULL) {
            return NULL;
        }
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(entry->metadata_ref);
        if (metadata == NULL || metadata->kind != IW_GC_METADATA_HEAP) {
            fprintf(stderr, "Ironwall missing GC metadata in %s\n", context);
            abort();
        }
        if (!iw_gc_metadata_ref_equals(iw_gc_metadata_ref_for_runtime_type(header->tag), entry->metadata_ref)) {
            fprintf(stderr, "Ironwall heap metadata/runtime binding mismatch in %s\n", context);
            abort();
        }
        if (iw_gc_total_size_bytes(metadata, header) != entry->total_size_bytes) {
            fprintf(stderr, "Ironwall GC heap registry size mismatch for %s\n", metadata->name);
            abort();
        }
        if (metadata->variable_member_kind == IW_GC_VARIABLE_MEMBER_BYTE && metadata->length_kind != IW_GC_LENGTH_NONE) {
            const iw_text_value_t *text = (const iw_text_value_t*)header;
            if ((const unsigned char*)text->data != iw_gc_variable_member_base(metadata, header)) {
                fprintf(stderr, "Ironwall GC heap validation failed in %s for %s\n", context, metadata->name);
                abort();
            }
        }
        return metadata;
    }
}

static inline const iw_gc_metadata_entry_t* iw_gc_validate_heap_header_for_gc(iw_heap_header_t *header, const char *context) {
    const iw_gc_metadata_entry_t *metadata;
    pthread_mutex_lock(&iw_gc_heap_registry_lock);
    metadata = iw_gc_validate_heap_header_for_gc_unlocked(header, context);
    pthread_mutex_unlock(&iw_gc_heap_registry_lock);
    return metadata;
}

static inline void iw_gc_validate_global_tables(void) {
    for (size_t index = 0u; index < iw_gc_all_global_table_count; index += 1u) {
        const iw_gc_global_table_t *table = iw_gc_all_global_tables[index];
        if (table == NULL) {
            continue;
        }
        const iw_gc_metadata_entry_t *metadata = iw_gc_lookup_metadata_ref(table->metadata_ref);
        if (metadata == NULL || metadata->kind != IW_GC_METADATA_GLOBAL) {
            fprintf(stderr, "Ironwall GC missing global metadata during validation\n");
            abort();
        }
        if (!iw_gc_validate_tagged_block(table->block_base, metadata)) {
            fprintf(stderr, "Ironwall GC global aggregate validation failed\n");
            abort();
        }
    }
}

static inline size_t iw_gc_validate_heap_registry(void) {
    size_t count = 0u;
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        iw_gc_heap_registry_entry_t *entry = &iw_gc_heap_registry_entries[index];
        const iw_gc_metadata_entry_t *metadata;
        if (entry->base == NULL) {
            continue;
        }
        metadata = iw_gc_validate_heap_header_for_gc_unlocked(entry->base, "gc heap registry validation");
        if (metadata == NULL) {
            fprintf(stderr, "Ironwall GC heap registry entry missing exact-base validation\n");
            abort();
        }
        count += 1u;
    }
    return count;
}

static inline size_t iw_gc_count_marked_heap_registry_entries(void) {
    size_t count = 0u;
    for (size_t index = 0u; index < iw_gc_heap_registry_count; index += 1u) {
        const iw_gc_heap_registry_entry_t *entry = &iw_gc_heap_registry_entries[index];
        if (entry->base == NULL || entry->marked == 0u) {
            continue;
        }
        count += 1u;
    }
    return count;
}

static inline void iw_gc_run_validation_pass_before_collect(iw_gc_cycle_report_t *report) {
    iw_gc_validate_global_tables();
    report->heap_count = iw_gc_validate_heap_registry();
}

static inline void iw_gc_run_validation_pass_after_mark(iw_gc_cycle_report_t *report) {
    report->live_heap_count = iw_gc_count_marked_heap_registry_entries();
    if (report->live_heap_count > report->heap_count) {
        fprintf(stderr, "Ironwall GC live heap count exceeded heap registry count\n");
        abort();
    }
    report->dead_heap_count = report->heap_count - report->live_heap_count;
}

static inline void iw_gc_run_validation_pass_after_sweep(const iw_gc_cycle_report_t *report) {
    if (report->reclaimed_count != report->dead_heap_count) {
        fprintf(stderr, "Ironwall GC reclaimed count mismatch: expected %zu, got %zu\n", report->dead_heap_count, report->reclaimed_count);
        abort();
    }
    if (iw_gc_heap_registry_count != report->live_heap_count) {
        fprintf(stderr, "Ironwall GC remaining heap count mismatch: expected %zu, got %zu\n", report->live_heap_count, iw_gc_heap_registry_count);
        abort();
    }
}
