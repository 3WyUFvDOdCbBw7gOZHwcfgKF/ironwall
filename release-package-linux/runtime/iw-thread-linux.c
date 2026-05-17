#include <semaphore.h>

typedef struct iw_thread_runtime_entry_t {
    pthread_t thread;
    uint8_t active;
    uint8_t detached;
    uint8_t joining;
    uint8_t completed;
    uint8_t cancel_requested;
    iw_value_t start_closure;
    iw_value_t result_value;
} iw_thread_runtime_entry_t;

typedef struct iw_mutex_runtime_entry_t {
    pthread_mutex_t mutex;
    uint8_t active;
} iw_mutex_runtime_entry_t;

typedef struct iw_cond_runtime_entry_t {
    pthread_cond_t cond;
    uint8_t active;
} iw_cond_runtime_entry_t;

typedef struct iw_tls_runtime_entry_t {
    pthread_key_t key;
    uint8_t active;
} iw_tls_runtime_entry_t;

typedef struct iw_sem_runtime_entry_t {
    sem_t sem;
    uint8_t active;
} iw_sem_runtime_entry_t;

static pthread_mutex_t iw_thread_runtime_lock = PTHREAD_MUTEX_INITIALIZER;
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
static _Thread_local iw_thread_runtime_entry_t *iw_thread_current_entry = NULL;
static _Thread_local iw_value_t iw_thread_current_result = (iw_value_t)0;
static _Thread_local uint8_t iw_thread_current_has_result = 0u;

typedef iw_value_t (*iw_thread_closure_apply_1_t)(iw_value_t env, iw_value_t arg0);

static inline void iw_thread_runtime_abort_message(const char *context, const char *detail) {
    fprintf(stderr, "Ironwall thread runtime failure in %s: %s\n", context, detail);
    abort();
}

static inline void iw_thread_runtime_abort_errno(const char *context, int error_code) {
    fprintf(stderr, "Ironwall thread runtime failure in %s: %s\n", context, strerror(error_code));
    abort();
}

static inline void iw_thread_runtime_abort_invalid_handle(const char *kind, int64_t handle, const char *context) {
    fprintf(stderr, "Ironwall invalid %s handle in %s: %lld\n", kind, context, (long long)handle);
    abort();
}

static inline void iw_thread_runtime_grow_threads(size_t min_capacity, const char *context) {
    if (iw_thread_runtime_capacity >= min_capacity) {
        return;
    }
    size_t next_capacity = iw_thread_runtime_capacity == 0u ? 8u : iw_thread_runtime_capacity;
    while (next_capacity < min_capacity) {
        next_capacity *= 2u;
    }
    iw_thread_runtime_entry_t *next_entries = (iw_thread_runtime_entry_t*)calloc(next_capacity, sizeof(iw_thread_runtime_entry_t));
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

static inline void iw_thread_runtime_grow_mutexes(size_t min_capacity, const char *context) {
    if (iw_mutex_runtime_capacity >= min_capacity) {
        return;
    }
    size_t next_capacity = iw_mutex_runtime_capacity == 0u ? 8u : iw_mutex_runtime_capacity;
    while (next_capacity < min_capacity) {
        next_capacity *= 2u;
    }
    iw_mutex_runtime_entry_t *next_entries = (iw_mutex_runtime_entry_t*)calloc(next_capacity, sizeof(iw_mutex_runtime_entry_t));
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

static inline void iw_thread_runtime_grow_conds(size_t min_capacity, const char *context) {
    if (iw_cond_runtime_capacity >= min_capacity) {
        return;
    }
    size_t next_capacity = iw_cond_runtime_capacity == 0u ? 8u : iw_cond_runtime_capacity;
    while (next_capacity < min_capacity) {
        next_capacity *= 2u;
    }
    iw_cond_runtime_entry_t *next_entries = (iw_cond_runtime_entry_t*)calloc(next_capacity, sizeof(iw_cond_runtime_entry_t));
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

static inline void iw_thread_runtime_grow_tls(size_t min_capacity, const char *context) {
    if (iw_tls_runtime_capacity >= min_capacity) {
        return;
    }
    size_t next_capacity = iw_tls_runtime_capacity == 0u ? 8u : iw_tls_runtime_capacity;
    while (next_capacity < min_capacity) {
        next_capacity *= 2u;
    }
    iw_tls_runtime_entry_t *next_entries = (iw_tls_runtime_entry_t*)calloc(next_capacity, sizeof(iw_tls_runtime_entry_t));
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

static inline void iw_thread_runtime_grow_sems(size_t min_capacity, const char *context) {
    if (iw_sem_runtime_capacity >= min_capacity) {
        return;
    }
    size_t next_capacity = iw_sem_runtime_capacity == 0u ? 8u : iw_sem_runtime_capacity;
    while (next_capacity < min_capacity) {
        next_capacity *= 2u;
    }
    iw_sem_runtime_entry_t *next_entries = (iw_sem_runtime_entry_t*)calloc(next_capacity, sizeof(iw_sem_runtime_entry_t));
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

static inline size_t iw_thread_runtime_alloc_thread_entry(const char *context) {
    for (size_t index = 0u; index < iw_thread_runtime_capacity; index += 1u) {
        if (iw_thread_runtime_entries[index].active == 0u) {
            memset(&iw_thread_runtime_entries[index], 0, sizeof(iw_thread_runtime_entry_t));
            iw_thread_runtime_entries[index].active = 1u;
            iw_thread_runtime_entries[index].result_value = iw_from_i64(0);
            return index;
        }
    }
    const size_t index = iw_thread_runtime_capacity;
    iw_thread_runtime_grow_threads(iw_thread_runtime_capacity + 1u, context);
    memset(&iw_thread_runtime_entries[index], 0, sizeof(iw_thread_runtime_entry_t));
    iw_thread_runtime_entries[index].active = 1u;
    iw_thread_runtime_entries[index].result_value = iw_from_i64(0);
    return index;
}

static inline size_t iw_thread_runtime_alloc_mutex_entry(const char *context) {
    for (size_t index = 0u; index < iw_mutex_runtime_capacity; index += 1u) {
        if (iw_mutex_runtime_entries[index].active == 0u) {
            memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
            iw_mutex_runtime_entries[index].active = 1u;
            return index;
        }
    }
    const size_t index = iw_mutex_runtime_capacity;
    iw_thread_runtime_grow_mutexes(iw_mutex_runtime_capacity + 1u, context);
    memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
    iw_mutex_runtime_entries[index].active = 1u;
    return index;
}

static inline size_t iw_thread_runtime_alloc_cond_entry(const char *context) {
    for (size_t index = 0u; index < iw_cond_runtime_capacity; index += 1u) {
        if (iw_cond_runtime_entries[index].active == 0u) {
            memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
            iw_cond_runtime_entries[index].active = 1u;
            return index;
        }
    }
    const size_t index = iw_cond_runtime_capacity;
    iw_thread_runtime_grow_conds(iw_cond_runtime_capacity + 1u, context);
    memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
    iw_cond_runtime_entries[index].active = 1u;
    return index;
}

static inline size_t iw_thread_runtime_alloc_tls_entry(const char *context) {
    for (size_t index = 0u; index < iw_tls_runtime_capacity; index += 1u) {
        if (iw_tls_runtime_entries[index].active == 0u) {
            memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
            iw_tls_runtime_entries[index].active = 1u;
            return index;
        }
    }
    const size_t index = iw_tls_runtime_capacity;
    iw_thread_runtime_grow_tls(iw_tls_runtime_capacity + 1u, context);
    memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
    iw_tls_runtime_entries[index].active = 1u;
    return index;
}

static inline size_t iw_thread_runtime_alloc_sem_entry(const char *context) {
    for (size_t index = 0u; index < iw_sem_runtime_capacity; index += 1u) {
        if (iw_sem_runtime_entries[index].active == 0u) {
            memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
            iw_sem_runtime_entries[index].active = 1u;
            return index;
        }
    }
    const size_t index = iw_sem_runtime_capacity;
    iw_thread_runtime_grow_sems(iw_sem_runtime_capacity + 1u, context);
    memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
    iw_sem_runtime_entries[index].active = 1u;
    return index;
}

static inline iw_thread_runtime_entry_t* iw_thread_runtime_lookup(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("thread", handle, context);
    }
    size_t index = (size_t)(handle - 1);
    if (index >= iw_thread_runtime_capacity || iw_thread_runtime_entries[index].active == 0u) {
        iw_thread_runtime_abort_invalid_handle("thread", handle, context);
    }
    return &iw_thread_runtime_entries[index];
}

static inline iw_mutex_runtime_entry_t* iw_thread_runtime_lookup_mutex(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("mutex", handle, context);
    }
    size_t index = (size_t)(handle - 1);
    if (index >= iw_mutex_runtime_capacity || iw_mutex_runtime_entries[index].active == 0u) {
        iw_thread_runtime_abort_invalid_handle("mutex", handle, context);
    }
    return &iw_mutex_runtime_entries[index];
}

static inline iw_cond_runtime_entry_t* iw_thread_runtime_lookup_cond(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("cond", handle, context);
    }
    size_t index = (size_t)(handle - 1);
    if (index >= iw_cond_runtime_capacity || iw_cond_runtime_entries[index].active == 0u) {
        iw_thread_runtime_abort_invalid_handle("cond", handle, context);
    }
    return &iw_cond_runtime_entries[index];
}

static inline iw_tls_runtime_entry_t* iw_thread_runtime_lookup_tls(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("tls", handle, context);
    }
    size_t index = (size_t)(handle - 1);
    if (index >= iw_tls_runtime_capacity || iw_tls_runtime_entries[index].active == 0u) {
        iw_thread_runtime_abort_invalid_handle("tls", handle, context);
    }
    return &iw_tls_runtime_entries[index];
}

static inline iw_sem_runtime_entry_t* iw_thread_runtime_lookup_sem(iw_value_t raw_handle, const char *context) {
    int64_t handle = iw_as_i64(raw_handle);
    if (handle <= 0) {
        iw_thread_runtime_abort_invalid_handle("semaphore", handle, context);
    }
    size_t index = (size_t)(handle - 1);
    if (index >= iw_sem_runtime_capacity || iw_sem_runtime_entries[index].active == 0u) {
        iw_thread_runtime_abort_invalid_handle("semaphore", handle, context);
    }
    return &iw_sem_runtime_entries[index];
}

static inline struct timespec iw_thread_runtime_duration_ms(int64_t duration_ms, const char *context) {
    struct timespec value;
    if (duration_ms < 0) {
        iw_thread_runtime_abort_message(context, "duration must be non-negative");
    }
    value.tv_sec = (time_t)(duration_ms / 1000LL);
    value.tv_nsec = (long)((duration_ms % 1000LL) * 1000000LL);
    return value;
}

static inline struct timespec iw_thread_runtime_deadline_ms(int64_t timeout_ms, const char *context) {
    struct timespec deadline;
    struct timespec delta = iw_thread_runtime_duration_ms(timeout_ms, context);
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
        iw_thread_runtime_abort_message(context, "clock_gettime failed");
    }
    deadline.tv_sec += delta.tv_sec;
    deadline.tv_nsec += delta.tv_nsec;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
    }
    return deadline;
}

static void iw_thread_runtime_finish(void *raw_entry) {
    iw_thread_runtime_entry_t *entry = (iw_thread_runtime_entry_t*)raw_entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    if (entry != NULL && entry->active != 0u) {
        entry->completed = 1u;
        entry->result_value = iw_thread_current_has_result != 0u ? iw_thread_current_result : iw_from_i64(0);
        entry->start_closure = (iw_value_t)0;
        if (entry->detached != 0u) {
            memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    iw_thread_current_entry = NULL;
    iw_thread_current_result = (iw_value_t)0;
    iw_thread_current_has_result = 0u;
    iw_gc_detach_current_thread();
}

static void *iw_thread_runtime_entry_main(void *raw_entry) {
    iw_thread_runtime_entry_t *entry = (iw_thread_runtime_entry_t*)raw_entry;
    int stack_anchor_local = 0;
    (void)iw_gc_ensure_current_thread_attached((uintptr_t)&stack_anchor_local);
    iw_thread_current_entry = entry;
    iw_thread_current_result = iw_from_i64(0);
    iw_thread_current_has_result = 0u;
    pthread_cleanup_push(iw_thread_runtime_finish, entry);
    {
        iw_closure_value_t *closure = iw_closure_expect(entry->start_closure, 1u, "thread_spawn_i5");
        iw_value_t result = ((iw_thread_closure_apply_1_t)closure->apply)(closure->env, iw_from_i64(0));
        iw_thread_current_result = result;
        iw_thread_current_has_result = 1u;
    }
    pthread_cleanup_pop(1);
    return NULL;
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
    pthread_mutex_lock(&iw_thread_runtime_lock);
    size_t index = iw_thread_runtime_alloc_thread_entry("thread_spawn_i5");
    iw_thread_runtime_entry_t *entry = &iw_thread_runtime_entries[index];
    entry->start_closure = raw_closure;
    entry->result_value = iw_from_i64(0);
    {
        const int error_code = pthread_create(&entry->thread, NULL, iw_thread_runtime_entry_main, entry);
        if (error_code != 0) {
            memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_spawn_i5", error_code);
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64((int64_t)(index + 1u));
}

static inline iw_value_t iw_builtin_thread_join_i5(iw_value_t raw_handle) {
    pthread_t thread;
    iw_thread_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
    if (entry->detached != 0u) {
        pthread_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_message("thread_join_i5", "cannot join a detached thread");
    }
    if (entry->joining != 0u) {
        pthread_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_message("thread_join_i5", "thread is already being joined");
    }
    entry->joining = 1u;
    thread = entry->thread;
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&thread;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = pthread_join(thread, NULL);
        iw_gc_blocking_section_end();
        if (error_code != 0) {
            pthread_mutex_lock(&iw_thread_runtime_lock);
            entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
            entry->joining = 0u;
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_join_i5", error_code);
        }
    }
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup(raw_handle, "thread_join_i5");
    {
        iw_value_t result = entry->result_value;
        memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
        pthread_mutex_unlock(&iw_thread_runtime_lock);
        return result;
    }
}

static inline iw_value_t iw_builtin_thread_detach(iw_value_t raw_handle) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_thread_runtime_entry_t *entry = iw_thread_runtime_lookup(raw_handle, "thread_detach");
    if (entry->joining != 0u) {
        pthread_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_message("thread_detach", "cannot detach a thread that is being joined");
    }
    if (entry->detached == 0u) {
        const int error_code = pthread_detach(entry->thread);
        if (error_code != 0) {
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("thread_detach", error_code);
        }
        entry->detached = 1u;
    }
    if (entry->completed != 0u) {
        memset(entry, 0, sizeof(iw_thread_runtime_entry_t));
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_thread_request_cancel(iw_value_t raw_handle) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_thread_runtime_lookup(raw_handle, "thread_request_cancel")->cancel_requested = 1u;
    pthread_mutex_unlock(&iw_thread_runtime_lock);
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
    pthread_exit(NULL);
    return raw_value;
}

static inline iw_value_t iw_builtin_thread_self(void) {
    if (iw_gc_current_thread != NULL) {
        return iw_from_i64((int64_t)iw_gc_current_thread->tid);
    }
    return iw_from_i64((int64_t)syscall(SYS_gettid));
}

static inline iw_value_t iw_builtin_thread_yield(void) {
    uintptr_t current_sp = (uintptr_t)&current_sp;
    iw_gc_safepoint_poll(current_sp);
    if (syscall(SYS_sched_yield) != 0) {
        iw_thread_runtime_abort_message("thread_yield", "sched_yield failed");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sleep_ms(iw_value_t raw_duration_ms) {
    struct timespec remaining = iw_thread_runtime_duration_ms(iw_as_i64(raw_duration_ms), "sleep_ms");
    while (remaining.tv_sec != 0 || remaining.tv_nsec != 0) {
        uintptr_t current_sp = (uintptr_t)&remaining;
        iw_gc_blocking_section_begin(current_sp);
        if (nanosleep(&remaining, &remaining) == 0) {
            iw_gc_blocking_section_end();
            break;
        }
        iw_gc_blocking_section_end();
        if (errno != EINTR) {
            iw_thread_runtime_abort_message("sleep_ms", "nanosleep failed");
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_new(void) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    size_t index = iw_thread_runtime_alloc_mutex_entry("mutex_new");
    {
        const int error_code = pthread_mutex_init(&iw_mutex_runtime_entries[index].mutex, NULL);
        if (error_code != 0) {
            memset(&iw_mutex_runtime_entries[index], 0, sizeof(iw_mutex_runtime_entry_t));
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("mutex_new", error_code);
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64((int64_t)(index + 1u));
}

static inline iw_value_t iw_builtin_mutex_lock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_lock");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&entry;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = pthread_mutex_lock(&entry->mutex);
        iw_gc_blocking_section_end();
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("mutex_lock", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_unlock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_unlock");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        const int error_code = pthread_mutex_unlock(&entry->mutex);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("mutex_unlock", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_mutex_try_lock(iw_value_t raw_handle) {
    iw_mutex_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_try_lock");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        const int error_code = pthread_mutex_trylock(&entry->mutex);
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
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_mutex_runtime_entry_t *entry = iw_thread_runtime_lookup_mutex(raw_handle, "mutex_destroy");
    {
        const int error_code = pthread_mutex_destroy(&entry->mutex);
        if (error_code != 0) {
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("mutex_destroy", error_code);
        }
    }
    memset(entry, 0, sizeof(iw_mutex_runtime_entry_t));
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_new(void) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    size_t index = iw_thread_runtime_alloc_cond_entry("cond_new");
    {
        const int error_code = pthread_cond_init(&iw_cond_runtime_entries[index].cond, NULL);
        if (error_code != 0) {
            memset(&iw_cond_runtime_entries[index], 0, sizeof(iw_cond_runtime_entry_t));
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("cond_new", error_code);
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64((int64_t)(index + 1u));
}

static inline iw_value_t iw_builtin_cond_wait(iw_value_t raw_cond_handle, iw_value_t raw_mutex_handle) {
    iw_cond_runtime_entry_t *cond_entry;
    iw_mutex_runtime_entry_t *mutex_entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    cond_entry = iw_thread_runtime_lookup_cond(raw_cond_handle, "cond_wait");
    mutex_entry = iw_thread_runtime_lookup_mutex(raw_mutex_handle, "cond_wait");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&cond_entry;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = pthread_cond_wait(&cond_entry->cond, &mutex_entry->mutex);
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
    struct timespec deadline = iw_thread_runtime_deadline_ms(iw_as_i64(raw_timeout_ms), "cond_timed_wait_ms");
    pthread_mutex_lock(&iw_thread_runtime_lock);
    cond_entry = iw_thread_runtime_lookup_cond(raw_cond_handle, "cond_timed_wait_ms");
    mutex_entry = iw_thread_runtime_lookup_mutex(raw_mutex_handle, "cond_timed_wait_ms");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&deadline;
        int error_code = 0;
        iw_gc_blocking_section_begin(current_sp);
        error_code = pthread_cond_timedwait(&cond_entry->cond, &mutex_entry->mutex, &deadline);
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
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_signal");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        const int error_code = pthread_cond_signal(&entry->cond);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("cond_signal", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_broadcast(iw_value_t raw_handle) {
    iw_cond_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_broadcast");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        const int error_code = pthread_cond_broadcast(&entry->cond);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("cond_broadcast", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_cond_destroy(iw_value_t raw_handle) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_cond_runtime_entry_t *entry = iw_thread_runtime_lookup_cond(raw_handle, "cond_destroy");
    {
        const int error_code = pthread_cond_destroy(&entry->cond);
        if (error_code != 0) {
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("cond_destroy", error_code);
        }
    }
    memset(entry, 0, sizeof(iw_cond_runtime_entry_t));
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_tls_key_new(void) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    size_t index = iw_thread_runtime_alloc_tls_entry("tls_key_new");
    {
        const int error_code = pthread_key_create(&iw_tls_runtime_entries[index].key, NULL);
        if (error_code != 0) {
            memset(&iw_tls_runtime_entries[index], 0, sizeof(iw_tls_runtime_entry_t));
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("tls_key_new", error_code);
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64((int64_t)(index + 1u));
}

static inline iw_value_t iw_builtin_tls_set_i5(iw_value_t raw_key_handle, iw_value_t raw_value) {
    pthread_key_t key;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    key = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_set_i5")->key;
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        const int error_code = pthread_setspecific(key, (void*)(intptr_t)raw_value);
        if (error_code != 0) {
            iw_thread_runtime_abort_errno("tls_set_i5", error_code);
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_tls_get_i5(iw_value_t raw_key_handle) {
    pthread_key_t key;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    key = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_get_i5")->key;
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        void *raw_value = pthread_getspecific(key);
        if (raw_value == NULL) {
            return iw_from_i64(0);
        }
        return (iw_value_t)(intptr_t)raw_value;
    }
}

static inline iw_value_t iw_builtin_tls_delete(iw_value_t raw_key_handle) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_tls_runtime_entry_t *entry = iw_thread_runtime_lookup_tls(raw_key_handle, "tls_delete");
    {
        const int error_code = pthread_key_delete(entry->key);
        if (error_code != 0) {
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("tls_delete", error_code);
        }
    }
    memset(entry, 0, sizeof(iw_tls_runtime_entry_t));
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_new(iw_value_t raw_initial_count) {
    int64_t initial_count = iw_as_i64(raw_initial_count);
    if (initial_count < 0 || initial_count > 0x7fffffffLL) {
        iw_thread_runtime_abort_message("sem_new", "initial_count out of range");
    }
    pthread_mutex_lock(&iw_thread_runtime_lock);
    size_t index = iw_thread_runtime_alloc_sem_entry("sem_new");
    {
        if (sem_init(&iw_sem_runtime_entries[index].sem, 0, (unsigned int)initial_count) != 0) {
            memset(&iw_sem_runtime_entries[index], 0, sizeof(iw_sem_runtime_entry_t));
            pthread_mutex_unlock(&iw_thread_runtime_lock);
            iw_thread_runtime_abort_errno("sem_new", errno);
        }
    }
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64((int64_t)(index + 1u));
}

static inline iw_value_t iw_builtin_sem_post(iw_value_t raw_handle) {
    iw_sem_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_post");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    if (sem_post(&entry->sem) != 0) {
        iw_thread_runtime_abort_errno("sem_post", errno);
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_wait(iw_value_t raw_handle) {
    iw_sem_runtime_entry_t *entry;
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_wait");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&entry;
        for (;;) {
            iw_gc_blocking_section_begin(current_sp);
            if (sem_wait(&entry->sem) == 0) {
                iw_gc_blocking_section_end();
                break;
            }
            iw_gc_blocking_section_end();
            if (errno != EINTR) {
                iw_thread_runtime_abort_errno("sem_wait", errno);
            }
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sem_timed_wait_ms(iw_value_t raw_handle, iw_value_t raw_timeout_ms) {
    iw_sem_runtime_entry_t *entry;
    struct timespec deadline = iw_thread_runtime_deadline_ms(iw_as_i64(raw_timeout_ms), "sem_timed_wait_ms");
    pthread_mutex_lock(&iw_thread_runtime_lock);
    entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_timed_wait_ms");
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    {
        uintptr_t current_sp = (uintptr_t)&deadline;
        for (;;) {
            iw_gc_blocking_section_begin(current_sp);
            if (sem_timedwait(&entry->sem, &deadline) == 0) {
                iw_gc_blocking_section_end();
                return iw_from_i64(1);
            }
            iw_gc_blocking_section_end();
            if (errno == EINTR) {
                continue;
            }
            if (errno == ETIMEDOUT) {
                return iw_from_i64(0);
            }
            iw_thread_runtime_abort_errno("sem_timed_wait_ms", errno);
        }
    }
}

static inline iw_value_t iw_builtin_sem_destroy(iw_value_t raw_handle) {
    pthread_mutex_lock(&iw_thread_runtime_lock);
    iw_sem_runtime_entry_t *entry = iw_thread_runtime_lookup_sem(raw_handle, "sem_destroy");
    if (sem_destroy(&entry->sem) != 0) {
        pthread_mutex_unlock(&iw_thread_runtime_lock);
        iw_thread_runtime_abort_errno("sem_destroy", errno);
    }
    memset(entry, 0, sizeof(iw_sem_runtime_entry_t));
    pthread_mutex_unlock(&iw_thread_runtime_lock);
    return iw_from_i64(0);
}
