typedef struct iw_thread_runtime_entry_t {
    iw_win32_thread_t thread;
    uint8_t active;
    uint8_t detached;
    uint8_t joining;
    uint8_t completed;
    uint8_t cancel_requested;
    iw_value_t start_closure;
    iw_value_t result_value;
} iw_thread_runtime_entry_t;

typedef struct iw_mutex_runtime_entry_t {
    iw_win32_mutex_t mutex;
    uint8_t active;
} iw_mutex_runtime_entry_t;

typedef struct iw_cond_runtime_entry_t {
    iw_win32_condition_t cond;
    uint8_t active;
} iw_cond_runtime_entry_t;

typedef struct iw_tls_runtime_entry_t {
    iw_win32_tls_key_t key;
    uint8_t active;
} iw_tls_runtime_entry_t;

typedef struct iw_sem_runtime_entry_t {
    HANDLE handle;
    uint8_t active;
} iw_sem_runtime_entry_t;

static iw_win32_mutex_t iw_thread_runtime_lock = IW_WIN32_MUTEX_INITIALIZER;
static iw_thread_runtime_entry_t *iw_thread_runtime_entries = NULL;
static size_t iw_thread_runtime_capacity = 0u;
static iw_mutex_runtime_entry_t *iw_mutex_runtime_entries = NULL;
static size_t iw_mutex_runtime_capacity = 0u;
static iw_cond_runtime_entry_t *iw_cond_runtime_entries = NULL;
static size_t iw_cond_runtime_capacity = 0u;
static iw_tls_runtime_entry_t *iw_tls_runtime_entries = NULL;
static size_t iw_tls_runtime_capacity = 0u;
static iw_sem_runtime_entry_t *iw_sem_runtime_entries = NULL;
static size_t iw_sem_runtime_capacity = 0u;
static iw_win32_once_t iw_thread_runtime_exit_fls_once = IW_WIN32_ONCE_INIT;
static DWORD iw_thread_runtime_exit_fls_key = FLS_OUT_OF_INDEXES;
static _Thread_local iw_thread_runtime_entry_t *iw_thread_current_entry = NULL;
static _Thread_local iw_value_t iw_thread_current_result = (iw_value_t)0;
static _Thread_local uint8_t iw_thread_current_has_result = 0u;

typedef iw_value_t (IW_INTERNAL_ABI *iw_thread_closure_apply_1_t)(iw_value_t env, iw_value_t arg0);

static void iw_thread_runtime_finish(iw_thread_runtime_entry_t *entry);

static inline void iw_thread_runtime_abort_message(const char *context, const char *detail) {
    fprintf(stderr, "Ironwall thread runtime failure in %s: %s\n", context, detail);
    abort();
}

static inline void iw_thread_runtime_abort_errno(const char *context, int error_code) {
    fprintf(stderr, "Ironwall thread runtime failure in %s: %s\n", context, strerror(error_code));
    abort();
}

static inline void iw_thread_runtime_abort_last_error(const char *context) {
    fprintf(stderr, "Ironwall thread runtime failure in %s: win32=%lu\n", context, (unsigned long)GetLastError());
    abort();
}

static inline void iw_thread_runtime_abort_invalid_handle(const char *kind, int64_t handle, const char *context) {
    fprintf(stderr, "Ironwall invalid %s handle in %s: %lld\n", kind, context, (long long)handle);
    abort();
}

static VOID CALLBACK iw_thread_runtime_exit_fls_callback(PVOID raw_entry) {
    if (raw_entry != NULL) {
        iw_thread_runtime_finish((iw_thread_runtime_entry_t*)raw_entry);
    }
}

static void iw_thread_runtime_init_exit_fls_once(void) {
    iw_thread_runtime_exit_fls_key = FlsAlloc(iw_thread_runtime_exit_fls_callback);
    if (iw_thread_runtime_exit_fls_key == FLS_OUT_OF_INDEXES) {
        iw_thread_runtime_abort_last_error("thread_spawn_i5");
    }
}

static inline void iw_thread_runtime_prepare_exit_cleanup(iw_thread_runtime_entry_t *entry, const char *context) {
    int error_code = iw_win32_once(&iw_thread_runtime_exit_fls_once, iw_thread_runtime_init_exit_fls_once);
    if (error_code != 0) {
        iw_thread_runtime_abort_errno(context, error_code);
    }
    if (!FlsSetValue(iw_thread_runtime_exit_fls_key, entry)) {
        iw_thread_runtime_abort_last_error(context);
    }
}

static inline void iw_thread_runtime_grow_threads(size_t min_capacity, const char *context) {
    if (iw_thread_runtime_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_thread_runtime_capacity == 0u ? 8u : iw_thread_runtime_capacity;
        iw_thread_runtime_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_thread_runtime_entry_t*)calloc(next_capacity, sizeof(iw_thread_runtime_entry_t));
        if (next_entries == NULL) {
            iw_thread_runtime_abort_message(context, "failed to grow thread table");
        }
        for (size_t index = 0u; index < iw_thread_runtime_capacity; index += 1u) {
            next_entries[index] = iw_thread_runtime_entries[index];
        }
        free(iw_thread_runtime_entries);
        iw_thread_runtime_entries = next_entries;
        iw_thread_runtime_capacity = next_capacity;
    }
}

static inline void iw_thread_runtime_grow_mutexes(size_t min_capacity, const char *context) {
    if (iw_mutex_runtime_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_mutex_runtime_capacity == 0u ? 8u : iw_mutex_runtime_capacity;
        iw_mutex_runtime_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_mutex_runtime_entry_t*)calloc(next_capacity, sizeof(iw_mutex_runtime_entry_t));
        if (next_entries == NULL) {
            iw_thread_runtime_abort_message(context, "failed to grow mutex table");
        }
        for (size_t index = 0u; index < iw_mutex_runtime_capacity; index += 1u) {
            next_entries[index] = iw_mutex_runtime_entries[index];
        }
        free(iw_mutex_runtime_entries);
        iw_mutex_runtime_entries = next_entries;
        iw_mutex_runtime_capacity = next_capacity;
    }
}

static inline void iw_thread_runtime_grow_conds(size_t min_capacity, const char *context) {
    if (iw_cond_runtime_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_cond_runtime_capacity == 0u ? 8u : iw_cond_runtime_capacity;
        iw_cond_runtime_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_cond_runtime_entry_t*)calloc(next_capacity, sizeof(iw_cond_runtime_entry_t));
        if (next_entries == NULL) {
            iw_thread_runtime_abort_message(context, "failed to grow cond table");
        }
        for (size_t index = 0u; index < iw_cond_runtime_capacity; index += 1u) {
            next_entries[index] = iw_cond_runtime_entries[index];
        }
        free(iw_cond_runtime_entries);
        iw_cond_runtime_entries = next_entries;
        iw_cond_runtime_capacity = next_capacity;
    }
}

static inline void iw_thread_runtime_grow_tls(size_t min_capacity, const char *context) {
    if (iw_tls_runtime_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_tls_runtime_capacity == 0u ? 8u : iw_tls_runtime_capacity;
        iw_tls_runtime_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_tls_runtime_entry_t*)calloc(next_capacity, sizeof(iw_tls_runtime_entry_t));
        if (next_entries == NULL) {
            iw_thread_runtime_abort_message(context, "failed to grow tls table");
        }
        for (size_t index = 0u; index < iw_tls_runtime_capacity; index += 1u) {
            next_entries[index] = iw_tls_runtime_entries[index];
        }
        free(iw_tls_runtime_entries);
        iw_tls_runtime_entries = next_entries;
        iw_tls_runtime_capacity = next_capacity;
    }
}

static inline void iw_thread_runtime_grow_sems(size_t min_capacity, const char *context) {
    if (iw_sem_runtime_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_sem_runtime_capacity == 0u ? 8u : iw_sem_runtime_capacity;
        iw_sem_runtime_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_sem_runtime_entry_t*)calloc(next_capacity, sizeof(iw_sem_runtime_entry_t));
        if (next_entries == NULL) {
            iw_thread_runtime_abort_message(context, "failed to grow semaphore table");
        }
        for (size_t index = 0u; index < iw_sem_runtime_capacity; index += 1u) {
            next_entries[index] = iw_sem_runtime_entries[index];
        }
        free(iw_sem_runtime_entries);
        iw_sem_runtime_entries = next_entries;
        iw_sem_runtime_capacity = next_capacity;
    }
}

static inline size_t iw_thread_runtime_alloc_thread_entry(const char *context) {
    for (size_t index = 0u; index < iw_thread_runtime_capacity; index += 1u) {
        if (iw_thread_runtime_entries[index].active == 0u) {
            memset(&iw_thread_runtime_entries[index], 0, sizeof(iw_thread_runtime_entry_t));
            iw_thread_runtime_entries[index].active = 1u;
            iw_thread_runtime_entries[index].result_value = iw_from_i64(0);
            return index;
        }
    }
    {
        size_t index = iw_thread_runtime_capacity;
        iw_thread_runtime_grow_threads(iw_thread_runtime_capacity + 1u, context);
        memset(&iw_thread_runtime_entries[index], 0, sizeof(iw_thread_runtime_entry_t));
        iw_thread_runtime_entries[index].active = 1u;
        iw_thread_runtime_entries[index].result_value = iw_from_i64(0);
        return index;
    }
}

static inline size_t iw_thread_runtime_alloc_mutex_entry(const char *context) {
    for (size_t index = 0u; index < iw_mutex_runtime_capacity; index += 1u) {
        if (iw_mutex_runtime_entries[index].active == 0u) {
            memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
            iw_mutex_runtime_entries[index].active = 1u;
            return index;
        }
    }
    {
        size_t index = iw_mutex_runtime_capacity;
        iw_thread_runtime_grow_mutexes(iw_mutex_runtime_capacity + 1u, context);
        memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
        iw_mutex_runtime_entries[index].active = 1u;
        return index;
    }
}

static inline size_t iw_thread_runtime_alloc_cond_entry(const char *context) {
    for (size_t index = 0u; index < iw_cond_runtime_capacity; index += 1u) {
        if (iw_cond_runtime_entries[index].active == 0u) {
            memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
            iw_cond_runtime_entries[index].active = 1u;
            return index;
        }
    }
    {
        size_t index = iw_cond_runtime_capacity;
        iw_thread_runtime_grow_conds(iw_cond_runtime_capacity + 1u, context);
        memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
        iw_cond_runtime_entries[index].active = 1u;
        return index;
    }
}

static inline size_t iw_thread_runtime_alloc_tls_entry(const char *context) {
    for (size_t index = 0u; index < iw_tls_runtime_capacity; index += 1u) {
        if (iw_tls_runtime_entries[index].active == 0u) {
            memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
            iw_tls_runtime_entries[index].active = 1u;
            return index;
        }
    }
    {
        size_t index = iw_tls_runtime_capacity;
        iw_thread_runtime_grow_tls(iw_tls_runtime_capacity + 1u, context);
        memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
        iw_tls_runtime_entries[index].active = 1u;
        return index;
    }
}

static inline size_t iw_thread_runtime_alloc_sem_entry(const char *context) {
    for (size_t index = 0u; index < iw_sem_runtime_capacity; index += 1u) {
        if (iw_sem_runtime_entries[index].active == 0u) {
            memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
            iw_sem_runtime_entries[index].active = 1u;
            return index;
        }
    }
    {
        size_t index = iw_sem_runtime_capacity;
        iw_thread_runtime_grow_sems(iw_sem_runtime_capacity + 1u, context);
        memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
        iw_sem_runtime_entries[index].active = 1u;
        return index;
    }
}

static inline iw_thread_runtime_entry_t* iw_thread_runtime_lookup(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("thread", handle, context);
    }
    {
        size_t index = (size_t)(handle - 1);
        if (index >= iw_thread_runtime_capacity || iw_thread_runtime_entries[index].active == 0u) {
            iw_thread_runtime_abort_invalid_handle("thread", handle, context);
        }
        return &iw_thread_runtime_entries[index];
    }
}

static inline iw_mutex_runtime_entry_t* iw_thread_runtime_lookup_mutex(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("mutex", handle, context);
    }
    {
        size_t index = (size_t)(handle - 1);
        if (index >= iw_mutex_runtime_capacity || iw_mutex_runtime_entries[index].active == 0u) {
            iw_thread_runtime_abort_invalid_handle("mutex", handle, context);
        }
        return &iw_mutex_runtime_entries[index];
    }
}

static inline iw_cond_runtime_entry_t* iw_thread_runtime_lookup_cond(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("cond", handle, context);
    }
    {
        size_t index = (size_t)(handle - 1);
        if (index >= iw_cond_runtime_capacity || iw_cond_runtime_entries[index].active == 0u) {
            iw_thread_runtime_abort_invalid_handle("cond", handle, context);
        }
        return &iw_cond_runtime_entries[index];
    }
}

static inline iw_tls_runtime_entry_t* iw_thread_runtime_lookup_tls(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("tls", handle, context);
    }
    {
        size_t index = (size_t)(handle - 1);
        if (index >= iw_tls_runtime_capacity || iw_tls_runtime_entries[index].active == 0u) {
            iw_thread_runtime_abort_invalid_handle("tls", handle, context);
        }
        return &iw_tls_runtime_entries[index];
    }
}

static inline iw_sem_runtime_entry_t* iw_thread_runtime_lookup_sem(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("semaphore", handle, context);
    }
    {
        size_t index = (size_t)(handle - 1);
        if (index >= iw_sem_runtime_capacity || iw_sem_runtime_entries[index].active == 0u) {
            iw_thread_runtime_abort_invalid_handle("semaphore", handle, context);
        }
        return &iw_sem_runtime_entries[index];
    }
}

static inline DWORD iw_thread_runtime_timeout_ms(int64_t timeout_ms) {
    if (timeout_ms < 0) {
        return INFINITE;
    }
    if ((uint64_t)timeout_ms >= (uint64_t)INFINITE) {
        return INFINITE - 1u;
    }
    return (DWORD)timeout_ms;
}

static void iw_thread_runtime_finish(iw_thread_runtime_entry_t *entry) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    if (entry != NULL && entry->active != 0u) {
        entry->completed = 1u;
        entry->result_value = iw_thread_current_has_result != 0u ? iw_thread_current_result : iw_from_i64(0);
        entry->start_closure = (iw_value_t)0;
        if (entry->detached != 0u) {
            memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
        }
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    iw_thread_current_entry = NULL;
    iw_thread_current_result = (iw_value_t)0;
    iw_thread_current_has_result = 0u;
    iw_gc_detach_current_thread();
}

static unsigned __stdcall iw_thread_runtime_entry_main(void *raw_entry) {
    iw_thread_runtime_entry_t *entry = (iw_thread_runtime_entry_t*)raw_entry;
    int stack_anchor_local = 0;
    (void)iw_gc_ensure_current_thread_attached((uintptr_t)&stack_anchor_local);
    iw_thread_current_entry = entry;
    iw_thread_current_result = iw_from_i64(0);
    iw_thread_current_has_result = 0u;
    iw_thread_runtime_prepare_exit_cleanup(entry, "thread_spawn_i5");
    {
        iw_closure_value_t *closure = iw_closure_expect(entry->start_closure, 1u, "thread_spawn_i5");
        iw_value_t result = ((iw_thread_closure_apply_1_t)closure->apply)(closure->env, iw_from_i64(0));
        iw_thread_current_result = result;
        iw_thread_current_has_result = 1u;
    }
    return 0u;
}

static inline void iw_gc_mark_thread_runtime_roots(void) {
    for (size_t index = 0u; index < iw_thread_runtime_capacity; index += 1u) {
        iw_thread_runtime_entry_t *entry = &iw_thread_runtime_entries[index];
        if (entry->active == 0u || entry->start_closure == (iw_value_t)0) {
            continue;
        }
        iw_gc_mark_value(entry->start_closure);
    }
}

static inline iw_value_t iw_builtin_thread_spawn_i5(iw_value_t raw_closure) {
    iw_closure_expect(raw_closure, 1u, "thread_spawn_i5");
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        size_t index = iw_thread_runtime_alloc_thread_entry("thread_spawn_i5");
        iw_thread_runtime_entry_t *entry = &iw_thread_runtime_entries[index];
        int error_code;
        entry->start_closure = raw_closure;
        entry->result_value = iw_from_i64(0);
        entry->cancel_requested = 0u;
        error_code = iw_win32_thread_create(&entry->thread, iw_thread_runtime_entry_main, entry);
        if (error_code != 0) {
            memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_spawn_i5", error_code);
        }
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return iw_from_i64((int64_t)(index + 1u));
    }
}

static inline iw_value_t iw_builtin_thread_join_i5(iw_value_t raw_handle) {
    iw_win32_thread_t thread;
    iw_thread_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
    if (entry->detached != 0u) {
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_message("thread_join_i5", "cannot join a detached thread");
    }
    if (entry->joining != 0u) {
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_message("thread_join_i5", "thread is already being joined");
    }
    entry->joining = 1u;
    thread = entry->thread;
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&thread;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = iw_win32_thread_join(thread);
        iw_gc_blocking_section_end();
        if (error_code != 0) {
            iw_win32_mutex_lock(&iw_thread_runtime_lock);
            entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
            entry->joining = 0u;
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_join_i5", error_code);
        }
    }
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
    {
        iw_value_t result = entry->result_value;
        int error_code = iw_win32_thread_close(thread);
        if (error_code != 0) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_join_i5", error_code);
        }
        memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return result;
    }
}

static inline iw_value_t iw_builtin_thread_detach(iw_value_t raw_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        iw_thread_runtime_entry_t *entry = iw_thread_runtime_lookup(raw_handle, "thread_detach");
        int error_code;
        if (entry->joining != 0u) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_message("thread_detach", "cannot detach a thread that is being joined");
        }
        if (entry->detached == 0u) {
            error_code = iw_win32_thread_close(entry->thread);
            if (error_code != 0) {
                iw_win32_mutex_unlock(&iw_thread_runtime_lock);
                iw_thread_runtime_abort_errno("thread_detach", error_code);
            }
            entry->thread.handle = NULL;
            entry->thread.id = 0u;
            entry->detached = 1u;
        }
        if (entry->completed != 0u) {
            memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
        }
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_thread_request_cancel(iw_value_t raw_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    iw_thread_runtime_lookup(raw_handle, "thread_request_cancel")->cancel_requested = 1u;
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_thread_cancel_requested(void) {
    return iw_from_i64((iw_thread_current_entry != NULL && iw_thread_current_entry->cancel_requested != 0u) ? 1 : 0);
}

static inline iw_value_t iw_builtin_thread_exit_i5(iw_value_t raw_value) {
    iw_thread_current_result = raw_value;
    iw_thread_current_has_result = 1u;
    if (iw_thread_current_entry == NULL) {
        iw_gc_detach_current_thread();
    }
    iw_win32_thread_exit(0u);
    return raw_value;
}

static inline iw_value_t iw_builtin_thread_self(void) {
    if (iw_gc_current_thread != NULL) {
        return iw_from_i64((int64_t)iw_gc_current_thread->tid);
    }
    return iw_from_i64((int64_t)GetCurrentThreadId());
}

static inline iw_value_t iw_builtin_thread_yield(void) {
    uintptr_t current_sp = (uintptr_t)&current_sp;
    iw_gc_safepoint_poll(current_sp);
    if (!SwitchToThread()) {
        Sleep(0u);
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sleep_ms(iw_value_t raw_duration_ms) {
    int64_t duration_ms = iw_as_i64(raw_duration_ms);
    uintptr_t current_sp = (uintptr_t)&duration_ms;
    if (duration_ms < 0) {
        iw_thread_runtime_abort_message("sleep_ms", "duration must be non-negative");
    }
    iw_gc_blocking_section_begin(current_sp);
    Sleep(iw_thread_runtime_timeout_ms(duration_ms));
    iw_gc_blocking_section_end();
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_new(void) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        size_t index = iw_thread_runtime_alloc_mutex_entry("mutex_new");
        int error_code = iw_win32_mutex_init(&iw_mutex_runtime_entries[index].mutex);
        if (error_code != 0) {
            memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("mutex_new", error_code);
        }
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return iw_from_i64((int64_t)(index + 1u));
    }
}

static inline iw_value_t iw_builtin_mutex_lock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_lock");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&entry;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = iw_win32_mutex_lock(&entry->mutex);
        iw_gc_blocking_section_end();
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("mutex_lock", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_unlock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_unlock");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        int error_code = iw_win32_mutex_unlock(&entry->mutex);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("mutex_unlock", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_try_lock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_try_lock");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        int error_code = iw_win32_mutex_trylock(&entry->mutex);
        if (error_code == 0) {
            return iw_from_i64(1);
        }
        if (error_code == EBUSY) {
            return iw_from_i64(0);
        }
        iw_thread_runtime_abort_errno("mutex_try_lock", error_code);
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_destroy(iw_value_t raw_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        iw_mutex_runtime_entry_t *entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_destroy");
        int error_code = iw_win32_mutex_destroy(&entry->mutex);
        if (error_code != 0) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("mutex_destroy", error_code);
        }
        memset(entry, 0, sizeof(iw_mutex_runtime_entry_t));
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_new(void) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        size_t index = iw_thread_runtime_alloc_cond_entry("cond_new");
        int error_code = iw_win32_condition_init(&iw_cond_runtime_entries[index].cond);
        if (error_code != 0) {
            memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("cond_new", error_code);
        }
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return iw_from_i64((int64_t)(index + 1u));
    }
}

static inline iw_value_t iw_builtin_cond_wait(iw_value_t raw_cond_handle, iw_value_t raw_mutex_handle) {
    iw_cond_runtime_entry_t *cond_entry;
    iw_mutex_runtime_entry_t *mutex_entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    cond_entry = iw_thread_runtime_lookup_cond(raw_cond_handle, "cond_wait");
    mutex_entry = iw_thread_runtime_lookup_mutex(raw_mutex_handle, "cond_wait");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&cond_entry;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = iw_win32_condition_wait(&cond_entry->cond, &mutex_entry->mutex);
        iw_gc_blocking_section_end();
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("cond_wait", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_timed_wait_ms(iw_value_t raw_cond_handle, iw_value_t raw_mutex_handle, iw_value_t raw_timeout_ms) {
    iw_cond_runtime_entry_t *cond_entry;
    iw_mutex_runtime_entry_t *mutex_entry;
    DWORD timeout_ms = iw_thread_runtime_timeout_ms(iw_as_i64(raw_timeout_ms));
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    cond_entry = iw_thread_runtime_lookup_cond(raw_cond_handle, "cond_timed_wait_ms");
    mutex_entry = iw_thread_runtime_lookup_mutex(raw_mutex_handle, "cond_timed_wait_ms");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&timeout_ms;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = iw_win32_condition_timed_wait_ms(&cond_entry->cond, &mutex_entry->mutex, timeout_ms);
        iw_gc_blocking_section_end();
        if (error_code == 0) {
            return iw_from_i64(1);
        }
        if (error_code == ETIMEDOUT) {
            return iw_from_i64(0);
        }
        iw_thread_runtime_abort_errno("cond_timed_wait_ms", error_code);
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_signal(iw_value_t raw_handle) {
    iw_cond_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_signal");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        int error_code = iw_win32_condition_signal(&entry->cond);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("cond_signal", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_broadcast(iw_value_t raw_handle) {
    iw_cond_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_broadcast");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        int error_code = iw_win32_condition_broadcast(&entry->cond);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("cond_broadcast", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_destroy(iw_value_t raw_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        iw_cond_runtime_entry_t *entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_destroy");
        int error_code = iw_win32_condition_destroy(&entry->cond);
        if (error_code != 0) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("cond_destroy", error_code);
        }
        memset(entry, 0, sizeof(iw_cond_runtime_entry_t));
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_tls_key_new(void) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        size_t index = iw_thread_runtime_alloc_tls_entry("tls_key_new");
        int error_code = iw_win32_tls_alloc(&iw_tls_runtime_entries[index].key);
        if (error_code != 0) {
            memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("tls_key_new", error_code);
        }
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return iw_from_i64((int64_t)(index + 1u));
    }
}

static inline iw_value_t iw_builtin_tls_set_i5(iw_value_t raw_key_handle, iw_value_t raw_value) {
    iw_win32_tls_key_t key;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    key = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_set_i5")->key;
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        int error_code = iw_win32_tls_set(key, (void*)(intptr_t)raw_value);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("tls_set_i5", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_tls_get_i5(iw_value_t raw_key_handle) {
    iw_win32_tls_key_t key;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    key = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_get_i5")->key;
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        void *raw_value = iw_win32_tls_get(key);
        if (raw_value == NULL) {
            return iw_from_i64(0);
        }
        return (iw_value_t)(intptr_t)raw_value;
    }
}

static inline iw_value_t iw_builtin_tls_delete(iw_value_t raw_key_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        iw_tls_runtime_entry_t *entry = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_delete");
        int error_code = iw_win32_tls_delete(entry->key);
        if (error_code != 0) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("tls_delete", error_code);
        }
        memset(entry, 0, sizeof(iw_tls_runtime_entry_t));
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_new(iw_value_t raw_initial_count) {
    int64_t initial_count = iw_as_i64(raw_initial_count);
    if (initial_count < 0 || initial_count > 0x7fffffffLL) {
        iw_thread_runtime_abort_message("sem_new", "initial_count out of range");
    }
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        size_t index = iw_thread_runtime_alloc_sem_entry("sem_new");
        iw_sem_runtime_entries[index].handle = CreateSemaphoreW(NULL, (LONG)initial_count, 0x7fffffffL, NULL);
        if (iw_sem_runtime_entries[index].handle == NULL) {
            memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_last_error("sem_new");
        }
        iw_win32_mutex_unlock(&iw_thread_runtime_lock);
        return iw_from_i64((int64_t)(index + 1u));
    }
}

static inline iw_value_t iw_builtin_sem_post(iw_value_t raw_handle) {
    iw_sem_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_post");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    if (!ReleaseSemaphore(entry->handle, 1L, NULL)) {
        iw_thread_runtime_abort_last_error("sem_post");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_wait(iw_value_t raw_handle) {
    iw_sem_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_wait");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&entry;
        DWORD wait_result;
        iw_gc_blocking_section_begin(current_sp);
        wait_result = WaitForSingleObject(entry->handle, INFINITE);
        iw_gc_blocking_section_end();
        if (wait_result != WAIT_OBJECT_0) {
            iw_thread_runtime_abort_last_error("sem_wait");
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_timed_wait_ms(iw_value_t raw_handle, iw_value_t raw_timeout_ms) {
    iw_sem_runtime_entry_t *entry;
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_timed_wait_ms");
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&entry;
        DWORD wait_result;
        iw_gc_blocking_section_begin(current_sp);
        wait_result = WaitForSingleObject(entry->handle, iw_thread_runtime_timeout_ms(iw_as_i64(raw_timeout_ms)));
        iw_gc_blocking_section_end();
        if (wait_result == WAIT_OBJECT_0) {
            return iw_from_i64(1);
        }
        if (wait_result == WAIT_TIMEOUT) {
            return iw_from_i64(0);
        }
        iw_thread_runtime_abort_last_error("sem_timed_wait_ms");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_destroy(iw_value_t raw_handle) {
    iw_win32_mutex_lock(&iw_thread_runtime_lock);
    {
        iw_sem_runtime_entry_t *entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_destroy");
        if (entry->handle != NULL && !CloseHandle(entry->handle)) {
            iw_win32_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_last_error("sem_destroy");
        }
        memset(entry, 0, sizeof(iw_sem_runtime_entry_t));
    }
    iw_win32_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}