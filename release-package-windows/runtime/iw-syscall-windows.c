typedef struct iw_wide_string_array_t {
    wchar_t **items;
    int64_t count;
} iw_wide_string_array_t;

typedef struct iw_os_handle_entry_t {
    HANDLE handle;
    WIN32_FIND_DATAW dir_data;
    uint8_t active;
    uint8_t kind;
    uint8_t dir_has_current;
    uint8_t dir_eof;
} iw_os_handle_entry_t;

static const uint8_t IW_OS_HANDLE_KIND_NONE = 0u;
static const uint8_t IW_OS_HANDLE_KIND_EVENT = 1u;
static const uint8_t IW_OS_HANDLE_KIND_PROCESS = 2u;
static const uint8_t IW_OS_HANDLE_KIND_THREAD = 3u;
static const uint8_t IW_OS_HANDLE_KIND_DIR = 4u;

static SRWLOCK iw_os_handle_table_lock = SRWLOCK_INIT;
static iw_os_handle_entry_t *iw_os_handle_entries = NULL;
static size_t iw_os_handle_capacity = 0u;

static inline void iw_syscall_abort_message(const char *context, const char *detail) {
    fprintf(stderr, "Ironwall syscall failed in %s: %s\n", context, detail);
    abort();
}

static inline void iw_syscall_abort_errno(const char *context) {
    fprintf(stderr, "Ironwall syscall failed in %s: %s\n", context, strerror(errno));
    abort();
}

static inline void iw_syscall_abort_last_error(const char *context) {
    fprintf(stderr, "Ironwall syscall failed in %s: win32=%lu\n", context, (unsigned long)GetLastError());
    abort();
}

static inline void iw_syscall_abort_wsa(const char *context) {
    fprintf(stderr, "Ironwall syscall failed in %s: wsa=%d\n", context, WSAGetLastError());
    abort();
}

static inline void iw_syscall_abort_invalid_handle(const char *context, int64_t handle) {
    fprintf(stderr, "Ironwall syscall failed in %s: invalid handle=%lld\n", context, (long long)handle);
    abort();
}

static inline void iw_syscall_abort_invalid_handle_kind(const char *context, int64_t handle, const char *expected_kind) {
    fprintf(stderr, "Ironwall syscall failed in %s: handle=%lld is not a %s\n", context, (long long)handle, expected_kind);
    abort();
}

static inline void *iw_syscall_xmalloc(size_t size, const char *context) {
    void *result = malloc(size == 0u ? 1u : size);
    if (result == NULL) {
        fprintf(stderr, "Ironwall allocation failed in %s\n", context);
        abort();
    }
    return result;
}

static inline iw_value_t iw_make_i5_array_from_values(const int64_t *values, int64_t count, const char *context) {
    iw_value_t result = iw_builtin_array_new(iw_from_i64(count), iw_from_i64(0));
    iw_array_value_t *array = iw_array_expect(result, context);
    for (int64_t index = 0; index < count; index += 1) {
        array->items[index] = iw_from_i64(values[index]);
    }
    return result;
}

static inline iw_value_t iw_make_i5_pair_array(int64_t left, int64_t right, const char *context) {
    int64_t values[2] = { left, right };
    return iw_make_i5_array_from_values(values, 2, context);
}

static inline iw_value_t iw_text_empty(const char *context) {
    return iw_text_copy_bytes("", 0u, context);
}

static inline wchar_t *iw_utf8_to_wide_bytes(const char *bytes, size_t length, const char *context) {
    int needed = MultiByteToWideChar(CP_UTF8, 0, bytes, (int)length, NULL, 0);
    wchar_t *wide;
    if (needed < 0) {
        iw_syscall_abort_last_error(context);
    }
    wide = (wchar_t*)iw_syscall_xmalloc(((size_t)needed + 1u) * sizeof(wchar_t), context);
    if (needed > 0 && MultiByteToWideChar(CP_UTF8, 0, bytes, (int)length, wide, needed) <= 0) {
        free(wide);
        iw_syscall_abort_last_error(context);
    }
    wide[needed] = L'\0';
    return wide;
}

static inline wchar_t *iw_text_to_wide(iw_value_t raw_value, const char *context) {
    iw_text_value_t *value = iw_text_expect(raw_value, context);
    return iw_utf8_to_wide_bytes(value->data, value->length, context);
}

static inline char *iw_text_to_c_string(iw_value_t raw_value, const char *context) {
    iw_text_value_t *value = iw_text_expect(raw_value, context);
    char *result = (char*)iw_syscall_xmalloc(value->length + 1u, context);
    if (value->length > 0u) {
        memcpy(result, value->data, value->length);
    }
    result[value->length] = '\0';
    return result;
}

static inline iw_value_t iw_wide_to_text(const wchar_t *wide, const char *context) {
    int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, NULL, 0, NULL, NULL);
    char *buffer;
    iw_value_t result;
    if (needed <= 0) {
        iw_syscall_abort_last_error(context);
    }
    buffer = (char*)iw_syscall_xmalloc((size_t)needed, context);
    if (WideCharToMultiByte(CP_UTF8, 0, wide, -1, buffer, needed, NULL, NULL) <= 0) {
        free(buffer);
        iw_syscall_abort_last_error(context);
    }
    result = iw_text_copy_bytes(buffer, (size_t)(needed - 1), context);
    free(buffer);
    return result;
}

static inline iw_wide_string_array_t iw_text_array_to_wide_strings(iw_value_t raw_array, const char *context) {
    iw_array_value_t *array = iw_array_expect(raw_array, context);
    iw_wide_string_array_t result;
    result.count = array->length;
    result.items = result.count == 0 ? NULL : (wchar_t**)calloc((size_t)result.count, sizeof(wchar_t*));
    if (result.count != 0 && result.items == NULL) {
        iw_syscall_abort_message(context, "failed to allocate wide string array");
    }
    for (int64_t index = 0; index < result.count; index += 1) {
        iw_text_value_t *value = iw_text_expect(array->items[index], context);
        result.items[index] = iw_utf8_to_wide_bytes(value->data, value->length, context);
    }
    return result;
}

static inline void iw_free_wide_string_array(iw_wide_string_array_t value) {
    if (value.items == NULL) {
        return;
    }
    for (int64_t index = 0; index < value.count; index += 1) {
        free(value.items[index]);
    }
    free(value.items);
}

static inline void iw_append_wchar(wchar_t **cursor, wchar_t value) {
    **cursor = value;
    *cursor += 1;
}

static inline void iw_append_quoted_wide_argument(wchar_t **cursor, const wchar_t *value) {
    size_t backslash_count = 0u;
    int needs_quotes = value[0] == L'\0' || wcspbrk(value, L" \t\n\v\"") != NULL;
    if (!needs_quotes) {
        while (*value != L'\0') {
            iw_append_wchar(cursor, *value);
            value += 1;
        }
        return;
    }
    iw_append_wchar(cursor, L'"');
    while (*value != L'\0') {
        if (*value == L'\\') {
            backslash_count += 1u;
            value += 1;
            continue;
        }
        if (*value == L'"') {
            while (backslash_count > 0u) {
                iw_append_wchar(cursor, L'\\');
                backslash_count -= 1u;
            }
            iw_append_wchar(cursor, L'\\');
            iw_append_wchar(cursor, L'"');
            value += 1;
            continue;
        }
        while (backslash_count > 0u) {
            iw_append_wchar(cursor, L'\\');
            backslash_count -= 1u;
        }
        iw_append_wchar(cursor, *value);
        value += 1;
    }
    while (backslash_count > 0u) {
        iw_append_wchar(cursor, L'\\');
        iw_append_wchar(cursor, L'\\');
        backslash_count -= 1u;
    }
    iw_append_wchar(cursor, L'"');
}

static inline wchar_t *iw_build_command_line(const wchar_t *path, iw_wide_string_array_t argv, const char *context) {
    size_t capacity = (wcslen(path) * 2u) + 4u;
    wchar_t *result;
    wchar_t *cursor;
    for (int64_t index = 0; index < argv.count; index += 1) {
        capacity += (wcslen(argv.items[index]) * 2u) + 4u;
    }
    result = (wchar_t*)iw_syscall_xmalloc(capacity * sizeof(wchar_t), context);
    cursor = result;
    iw_append_quoted_wide_argument(&cursor, path);
    for (int64_t index = 0; index < argv.count; index += 1) {
        iw_append_wchar(&cursor, L' ');
        iw_append_quoted_wide_argument(&cursor, argv.items[index]);
    }
    *cursor = L'\0';
    return result;
}

static inline wchar_t *iw_build_environment_block(iw_wide_string_array_t envp, const char *context) {
    if (envp.count == 0) {
        return NULL;
    }
    size_t total_wchars = 2u;
    wchar_t *result;
    wchar_t *cursor;
    for (int64_t index = 0; index < envp.count; index += 1) {
        total_wchars += wcslen(envp.items[index]) + 1u;
    }
    result = (wchar_t*)iw_syscall_xmalloc(total_wchars * sizeof(wchar_t), context);
    cursor = result;
    for (int64_t index = 0; index < envp.count; index += 1) {
        size_t length = wcslen(envp.items[index]);
        memcpy(cursor, envp.items[index], length * sizeof(wchar_t));
        cursor += length;
        *cursor = L'\0';
        cursor += 1;
    }
    *cursor = L'\0';
    cursor += 1;
    *cursor = L'\0';
    return result;
}

static inline wchar_t *iw_build_dir_search_pattern(const wchar_t *path, const char *context) {
    size_t length = wcslen(path);
    int needs_separator = length > 0u && path[length - 1u] != L'\\' && path[length - 1u] != L'/';
    size_t extra = needs_separator ? 3u : 2u;
    wchar_t *result = (wchar_t*)iw_syscall_xmalloc((length + extra) * sizeof(wchar_t), context);
    memcpy(result, path, length * sizeof(wchar_t));
    if (needs_separator) {
        result[length] = L'\\';
        length += 1u;
    }
    result[length] = L'*';
    result[length + 1u] = L'\0';
    return result;
}

static inline int iw_dir_entry_is_dot_name(const wchar_t *name) {
    return wcscmp(name, L".") == 0 || wcscmp(name, L"..") == 0;
}

static inline DWORD iw_timeout_from_i64(int64_t timeout_ms) {
    if (timeout_ms < 0) {
        return INFINITE;
    }
    if ((uint64_t)timeout_ms >= (uint64_t)INFINITE) {
        return INFINITE - 1u;
    }
    return (DWORD)timeout_ms;
}

static inline HANDLE iw_handle_from_fd(int fd, const char *context) {
    intptr_t raw_handle = _get_osfhandle(fd);
    if (raw_handle == -1) {
        iw_syscall_abort_errno(context);
    }
    return (HANDLE)raw_handle;
}

static inline HANDLE iw_raw_to_handle(iw_value_t raw_value) {
    return (HANDLE)(intptr_t)iw_as_i64(raw_value);
}

static inline SOCKET iw_raw_to_socket(iw_value_t raw_value) {
    return (SOCKET)(uintptr_t)iw_as_i64(raw_value);
}

static inline HMODULE iw_raw_to_module(iw_value_t raw_value) {
    return (HMODULE)(intptr_t)iw_as_i64(raw_value);
}

static inline int64_t iw_handle_to_i64(HANDLE value) {
    return (int64_t)(intptr_t)value;
}

static inline int64_t iw_socket_to_i64(SOCKET value) {
    return (int64_t)(uintptr_t)value;
}

static inline void iw_os_handle_table_grow(size_t min_capacity, const char *context) {
    if (iw_os_handle_capacity >= min_capacity) {
        return;
    }
    {
        size_t next_capacity = iw_os_handle_capacity == 0u ? 8u : iw_os_handle_capacity;
        iw_os_handle_entry_t *next_entries;
        while (next_capacity < min_capacity) {
            next_capacity *= 2u;
        }
        next_entries = (iw_os_handle_entry_t*)calloc(next_capacity, sizeof(iw_os_handle_entry_t));
        if (next_entries == NULL) {
            iw_syscall_abort_message(context, "failed to grow os handle table");
        }
        for (size_t index = 0u; index < iw_os_handle_capacity; index += 1u) {
            next_entries[index] = iw_os_handle_entries[index];
        }
        free(iw_os_handle_entries);
        iw_os_handle_entries = next_entries;
        iw_os_handle_capacity = next_capacity;
    }
}

static inline size_t iw_os_handle_alloc_entry(const char *context) {
    for (size_t index = 0u; index < iw_os_handle_capacity; index += 1u) {
        if (iw_os_handle_entries[index].active == 0u) {
            memset(&iw_os_handle_entries[index], 0, sizeof(iw_os_handle_entry_t));
            iw_os_handle_entries[index].active = 1u;
            return index;
        }
    }
    {
        size_t index = iw_os_handle_capacity;
        iw_os_handle_table_grow(iw_os_handle_capacity + 1u, context);
        memset(&iw_os_handle_entries[index], 0, sizeof(iw_os_handle_entry_t));
        iw_os_handle_entries[index].active = 1u;
        return index;
    }
}

static inline iw_os_handle_entry_t* iw_os_handle_lookup_locked(iw_value_t raw_handle, const char *context) {
    int64_t logical_handle = iw_as_i64(raw_handle);
    if (logical_handle <= 0) {
        iw_syscall_abort_invalid_handle(context, logical_handle);
    }
    {
        size_t index = (size_t)(logical_handle - 1);
        if (index >= iw_os_handle_capacity || iw_os_handle_entries[index].active == 0u) {
            iw_syscall_abort_invalid_handle(context, logical_handle);
        }
        return &iw_os_handle_entries[index];
    }
}

static inline void iw_os_handle_close_raw(iw_os_handle_entry_t *entry, const char *context) {
    HANDLE raw_handle = entry->handle;
    if (raw_handle == NULL || raw_handle == INVALID_HANDLE_VALUE) {
        memset(entry, 0, sizeof(iw_os_handle_entry_t));
        return;
    }
    switch (entry->kind) {
        case IW_OS_HANDLE_KIND_EVENT:
        case IW_OS_HANDLE_KIND_PROCESS:
        case IW_OS_HANDLE_KIND_THREAD:
            if (!CloseHandle(raw_handle)) {
                iw_syscall_abort_last_error(context);
            }
            break;
        case IW_OS_HANDLE_KIND_DIR:
            if (!FindClose(raw_handle)) {
                iw_syscall_abort_last_error(context);
            }
            break;
        default:
            iw_syscall_abort_message(context, "unknown os handle kind");
    }
    memset(entry, 0, sizeof(iw_os_handle_entry_t));
}

static inline int64_t iw_os_handle_store(HANDLE handle, uint8_t kind, const char *context) {
    size_t index;
    AcquireSRWLockExclusive(&iw_os_handle_table_lock);
    index = iw_os_handle_alloc_entry(context);
    iw_os_handle_entries[index].handle = handle;
    iw_os_handle_entries[index].kind = kind;
    ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
    return (int64_t)(index + 1u);
}

static inline int64_t iw_os_dir_handle_store(HANDLE handle, const WIN32_FIND_DATAW *initial_data, const char *context) {
    size_t index;
    AcquireSRWLockExclusive(&iw_os_handle_table_lock);
    index = iw_os_handle_alloc_entry(context);
    iw_os_handle_entries[index].handle = handle;
    iw_os_handle_entries[index].kind = IW_OS_HANDLE_KIND_DIR;
    iw_os_handle_entries[index].dir_data = *initial_data;
    iw_os_handle_entries[index].dir_has_current = 1u;
    ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
    return (int64_t)(index + 1u);
}

static inline HANDLE iw_os_handle_expect_kind(iw_value_t raw_handle, uint8_t expected_kind, const char *expected_kind_name, const char *context) {
    HANDLE handle;
    AcquireSRWLockShared(&iw_os_handle_table_lock);
    {
        iw_os_handle_entry_t *entry = iw_os_handle_lookup_locked(raw_handle, context);
        if (entry->kind != expected_kind) {
            ReleaseSRWLockShared(&iw_os_handle_table_lock);
            iw_syscall_abort_invalid_handle_kind(context, iw_as_i64(raw_handle), expected_kind_name);
        }
        handle = entry->handle;
    }
    ReleaseSRWLockShared(&iw_os_handle_table_lock);
    return handle;
}

static inline HANDLE iw_os_handle_expect_waitable(iw_value_t raw_handle, const char *context) {
    HANDLE handle;
    AcquireSRWLockShared(&iw_os_handle_table_lock);
    {
        iw_os_handle_entry_t *entry = iw_os_handle_lookup_locked(raw_handle, context);
        if (
            entry->kind != IW_OS_HANDLE_KIND_EVENT
            && entry->kind != IW_OS_HANDLE_KIND_PROCESS
            && entry->kind != IW_OS_HANDLE_KIND_THREAD
        ) {
            ReleaseSRWLockShared(&iw_os_handle_table_lock);
            iw_syscall_abort_invalid_handle_kind(context, iw_as_i64(raw_handle), "waitable handle");
        }
        handle = entry->handle;
    }
    ReleaseSRWLockShared(&iw_os_handle_table_lock);
    return handle;
}

static inline HANDLE iw_duplicate_inheritable_handle(HANDLE handle, const char *context) {
    HANDLE duplicate = NULL;
    if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &duplicate, 0u, TRUE, DUPLICATE_SAME_ACCESS)) {
        iw_syscall_abort_last_error(context);
    }
    return duplicate;
}

static inline HANDLE iw_duplicate_inheritable_fd_handle(int fd, const char *context) {
    return iw_duplicate_inheritable_handle(iw_handle_from_fd(fd, context), context);
}

static inline int64_t iw_filetime_to_unix_ms(const FILETIME *value) {
    ULARGE_INTEGER ticks;
    ticks.LowPart = value->dwLowDateTime;
    ticks.HighPart = value->dwHighDateTime;
    if (ticks.QuadPart < 116444736000000000ULL) {
        return 0;
    }
    return (int64_t)((ticks.QuadPart - 116444736000000000ULL) / 10000ULL);
}

static inline void iw_fill_stat_values_from_handle(HANDLE handle, int64_t mode_value, int64_t *values, const char *context) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, &info)) {
        iw_syscall_abort_last_error(context);
    }
    values[0] = (int64_t)info.dwVolumeSerialNumber;
    values[1] = ((int64_t)info.nFileIndexHigh << 32) | (int64_t)info.nFileIndexLow;
    values[2] = mode_value;
    values[3] = ((int64_t)info.nFileSizeHigh << 32) | (int64_t)info.nFileSizeLow;
    values[4] = iw_filetime_to_unix_ms(&info.ftLastAccessTime);
    values[5] = iw_filetime_to_unix_ms(&info.ftLastWriteTime);
    values[6] = iw_filetime_to_unix_ms(&info.ftCreationTime);
    values[7] = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ? 1 : 0;
    values[8] = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? 1 : 0;
}

static inline iw_value_t iw_builtin_sys_platform_name(void) {
    return iw_text_copy_bytes("windows", 7u, "sys_platform_name");
}

static inline iw_value_t iw_builtin_sys_process_getpid(void) {
    return iw_from_i64((int64_t)GetCurrentProcessId());
}

static inline iw_value_t iw_builtin_sys_thread_gettid(void) {
    return iw_from_i64((int64_t)GetCurrentThreadId());
}

static inline iw_value_t iw_builtin_sys_process_exit(iw_value_t raw_code) {
    ExitProcess((UINT)iw_as_i64(raw_code));
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_process_abort(void) {
    abort();
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_process_argc(void) {
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL) {
        iw_syscall_abort_last_error("sys_process_argc");
    }
    LocalFree(argv);
    return iw_from_i64((int64_t)argc);
}

static inline iw_value_t iw_builtin_sys_process_argv_s3(iw_value_t raw_index) {
    int argc = 0;
    int64_t index = iw_as_i64(raw_index);
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    iw_value_t result;
    if (argv == NULL) {
        iw_syscall_abort_last_error("sys_process_argv_s3");
    }
    if (index < 0 || index >= (int64_t)argc) {
        LocalFree(argv);
        iw_syscall_abort_message("sys_process_argv_s3", "argv index out of range");
    }
    result = iw_wide_to_text(argv[index], "sys_process_argv_s3");
    LocalFree(argv);
    return result;
}

static inline iw_value_t iw_builtin_sys_env_get_s3(iw_value_t raw_name) {
    wchar_t *name = iw_text_to_wide(raw_name, "sys_env_get_s3 name");
    wchar_t *value = _wgetenv(name);
    iw_value_t result = value == NULL ? iw_text_empty("sys_env_get_s3") : iw_wide_to_text(value, "sys_env_get_s3");
    free(name);
    return result;
}

static inline iw_value_t iw_builtin_sys_env_set_s3(iw_value_t raw_name, iw_value_t raw_value) {
    wchar_t *name = iw_text_to_wide(raw_name, "sys_env_set_s3 name");
    wchar_t *value = iw_text_to_wide(raw_value, "sys_env_set_s3 value");
    if (_wputenv_s(name, value) != 0) {
        free(name);
        free(value);
        iw_syscall_abort_errno("sys_env_set_s3");
    }
    free(name);
    free(value);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_env_unset_s3(iw_value_t raw_name) {
    wchar_t *name = iw_text_to_wide(raw_name, "sys_env_unset_s3 name");
    if (_wputenv_s(name, L"") != 0) {
        free(name);
        iw_syscall_abort_errno("sys_env_unset_s3");
    }
    free(name);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_path_getcwd_s3(void) {
    DWORD length = GetCurrentDirectoryW(0u, NULL);
    wchar_t *buffer;
    iw_value_t result;
    if (length == 0u) {
        iw_syscall_abort_last_error("sys_path_getcwd_s3");
    }
    buffer = (wchar_t*)iw_syscall_xmalloc((size_t)length * sizeof(wchar_t), "sys_path_getcwd_s3");
    if (GetCurrentDirectoryW(length, buffer) == 0u) {
        free(buffer);
        iw_syscall_abort_last_error("sys_path_getcwd_s3");
    }
    result = iw_wide_to_text(buffer, "sys_path_getcwd_s3");
    free(buffer);
    return result;
}

static inline iw_value_t iw_builtin_sys_path_chdir_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_chdir_s3 path");
    if (!SetCurrentDirectoryW(path)) {
        free(path);
        iw_syscall_abort_last_error("sys_path_chdir_s3");
    }
    free(path);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_path_exists_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_exists_s3 path");
    DWORD attributes = GetFileAttributesW(path);
    free(path);
    return iw_from_i64(attributes == INVALID_FILE_ATTRIBUTES ? 0 : 1);
}

static inline iw_value_t iw_builtin_sys_path_is_file_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_is_file_s3 path");
    DWORD attributes = GetFileAttributesW(path);
    free(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        return iw_from_i64(0);
    }
    return iw_from_i64((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ? 1 : 0);
}

static inline iw_value_t iw_builtin_sys_path_is_dir_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_is_dir_s3 path");
    DWORD attributes = GetFileAttributesW(path);
    free(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        return iw_from_i64(0);
    }
    return iw_from_i64((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? 1 : 0);
}

static inline iw_value_t iw_builtin_sys_path_mkdir_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_mkdir_s3 path");
    if (_wmkdir(path) != 0) {
        free(path);
        iw_syscall_abort_errno("sys_path_mkdir_s3");
    }
    free(path);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_path_rmdir_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_rmdir_s3 path");
    if (_wrmdir(path) != 0) {
        free(path);
        iw_syscall_abort_errno("sys_path_rmdir_s3");
    }
    free(path);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_path_unlink_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_unlink_s3 path");
    if (_wunlink(path) != 0) {
        free(path);
        iw_syscall_abort_errno("sys_path_unlink_s3");
    }
    free(path);
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_path_rename_s3(iw_value_t raw_source_path, iw_value_t raw_target_path) {
    wchar_t *source_path = iw_text_to_wide(raw_source_path, "sys_path_rename_s3 source_path");
    wchar_t *target_path = iw_text_to_wide(raw_target_path, "sys_path_rename_s3 target_path");
    if (!MoveFileExW(source_path, target_path, MOVEFILE_REPLACE_EXISTING)) {
        free(source_path);
        free(target_path);
        iw_syscall_abort_last_error("sys_path_rename_s3");
    }
    free(source_path);
    free(target_path);
    return iw_from_i64(0);
}

static inline int iw_open_wide_fd(const wchar_t *path, int flags, const char *context) {
    int fd = _wopen(path, flags, _S_IREAD | _S_IWRITE);
    if (fd < 0) {
        iw_syscall_abort_errno(context);
    }
    return fd;
}

static inline iw_value_t iw_builtin_sys_fd_open_read_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_file_open_read_s3 path");
    int fd = iw_open_wide_fd(path, _O_BINARY | _O_RDONLY, "sys_file_open_read_s3");
    free(path);
    return iw_from_i64(fd);
}

static inline iw_value_t iw_builtin_sys_fd_open_write_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_file_open_write_s3 path");
    int fd = iw_open_wide_fd(path, _O_BINARY | _O_WRONLY, "sys_file_open_write_s3");
    free(path);
    return iw_from_i64(fd);
}

static inline iw_value_t iw_builtin_sys_fd_open_append_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_file_open_append_s3 path");
    int fd = iw_open_wide_fd(path, _O_BINARY | _O_WRONLY | _O_APPEND | _O_CREAT, "sys_file_open_append_s3");
    free(path);
    return iw_from_i64(fd);
}

static inline iw_value_t iw_builtin_sys_fd_creat_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_file_create_s3 path");
    int fd = iw_open_wide_fd(path, _O_BINARY | _O_WRONLY | _O_CREAT | _O_TRUNC, "sys_file_create_s3");
    free(path);
    return iw_from_i64(fd);
}

static inline iw_value_t iw_builtin_sys_fd_close(iw_value_t raw_fd) {
    if (_close((int)iw_as_i64(raw_fd)) != 0) {
        iw_syscall_abort_errno("sys_file_close");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_fd_read_s3(iw_value_t raw_fd, iw_value_t raw_size) {
    int64_t requested = iw_as_i64(raw_size);
    char *buffer;
    size_t offset = 0u;
    if (requested < 0) {
        iw_syscall_abort_message("sys_file_read_s3", "size must be non-negative");
    }
    if (requested == 0) {
        return iw_text_empty("sys_file_read_s3");
    }
    buffer = (char*)iw_syscall_xmalloc((size_t)requested, "sys_file_read_s3");
    while (offset < (size_t)requested) {
        unsigned int chunk_size = (unsigned int)(((size_t)requested - offset) > (size_t)INT_MAX ? (size_t)INT_MAX : ((size_t)requested - offset));
        int chunk = _read((int)iw_as_i64(raw_fd), buffer + offset, chunk_size);
        if (chunk < 0) {
            free(buffer);
            iw_syscall_abort_errno("sys_file_read_s3");
        }
        if (chunk == 0) {
            break;
        }
        offset += (size_t)chunk;
    }
    {
        iw_value_t result = iw_text_copy_bytes(buffer, offset, "sys_file_read_s3");
        free(buffer);
        return result;
    }
}

static inline iw_value_t iw_builtin_sys_fd_write_s3(iw_value_t raw_fd, iw_value_t raw_value) {
    iw_text_value_t *value = iw_text_expect(raw_value, "sys_file_write_s3 value");
    size_t written = 0u;
    while (written < value->length) {
        unsigned int chunk_size = (unsigned int)((value->length - written) > (size_t)INT_MAX ? (size_t)INT_MAX : (value->length - written));
        int chunk = _write((int)iw_as_i64(raw_fd), value->data + written, chunk_size);
        if (chunk < 0) {
            iw_syscall_abort_errno("sys_file_write_s3");
        }
        if (chunk == 0) {
            iw_syscall_abort_message("sys_file_write_s3", "short write");
        }
        written += (size_t)chunk;
    }
    return iw_from_i64((int64_t)written);
}

static inline iw_value_t iw_builtin_sys_fd_pread_s3(iw_value_t raw_fd, iw_value_t raw_size, iw_value_t raw_offset) {
    int64_t requested = iw_as_i64(raw_size);
    int64_t file_offset = iw_as_i64(raw_offset);
    HANDLE handle;
    char *buffer;
    size_t completed = 0u;
    if (requested < 0 || file_offset < 0) {
        iw_syscall_abort_message("sys_file_pread_s3", "size and offset must be non-negative");
    }
    if (requested == 0) {
        return iw_text_empty("sys_file_pread_s3");
    }
    handle = iw_handle_from_fd((int)iw_as_i64(raw_fd), "sys_file_pread_s3");
    buffer = (char*)iw_syscall_xmalloc((size_t)requested, "sys_file_pread_s3");
    while (completed < (size_t)requested) {
        OVERLAPPED overlapped;
        DWORD chunk_count = 0u;
        DWORD chunk_size = (DWORD)(((size_t)requested - completed) > (size_t)UINT_MAX ? (size_t)UINT_MAX : ((size_t)requested - completed));
        memset(&overlapped, 0, sizeof(overlapped));
        overlapped.Offset = (DWORD)((uint64_t)(file_offset + (int64_t)completed) & 0xffffffffULL);
        overlapped.OffsetHigh = (DWORD)(((uint64_t)(file_offset + (int64_t)completed) >> 32) & 0xffffffffULL);
        if (!ReadFile(handle, buffer + completed, chunk_size, &chunk_count, &overlapped)) {
            DWORD error = GetLastError();
            if (error == ERROR_HANDLE_EOF) {
                break;
            }
            free(buffer);
            iw_syscall_abort_last_error("sys_file_pread_s3");
        }
        if (chunk_count == 0u) {
            break;
        }
        completed += (size_t)chunk_count;
    }
    {
        iw_value_t result = iw_text_copy_bytes(buffer, completed, "sys_file_pread_s3");
        free(buffer);
        return result;
    }
}

static inline iw_value_t iw_builtin_sys_fd_pwrite_s3(iw_value_t raw_fd, iw_value_t raw_value, iw_value_t raw_offset) {
    iw_text_value_t *value = iw_text_expect(raw_value, "sys_file_pwrite_s3 value");
    int64_t file_offset = iw_as_i64(raw_offset);
    HANDLE handle;
    size_t written = 0u;
    if (file_offset < 0) {
        iw_syscall_abort_message("sys_file_pwrite_s3", "offset must be non-negative");
    }
    handle = iw_handle_from_fd((int)iw_as_i64(raw_fd), "sys_file_pwrite_s3");
    while (written < value->length) {
        OVERLAPPED overlapped;
        DWORD chunk_count = 0u;
        DWORD chunk_size = (DWORD)((value->length - written) > (size_t)UINT_MAX ? (size_t)UINT_MAX : (value->length - written));
        memset(&overlapped, 0, sizeof(overlapped));
        overlapped.Offset = (DWORD)((uint64_t)(file_offset + (int64_t)written) & 0xffffffffULL);
        overlapped.OffsetHigh = (DWORD)(((uint64_t)(file_offset + (int64_t)written) >> 32) & 0xffffffffULL);
        if (!WriteFile(handle, value->data + written, chunk_size, &chunk_count, &overlapped)) {
            iw_syscall_abort_last_error("sys_file_pwrite_s3");
        }
        if (chunk_count == 0u) {
            iw_syscall_abort_message("sys_file_pwrite_s3", "short write");
        }
        written += (size_t)chunk_count;
    }
    return iw_from_i64((int64_t)written);
}

static inline iw_value_t iw_builtin_sys_fd_lseek(iw_value_t raw_fd, iw_value_t raw_offset, iw_value_t raw_whence) {
    __int64 result = _lseeki64((int)iw_as_i64(raw_fd), (__int64)iw_as_i64(raw_offset), (int)iw_as_i64(raw_whence));
    if (result < 0) {
        iw_syscall_abort_errno("sys_file_seek");
    }
    return iw_from_i64((int64_t)result);
}

static inline iw_value_t iw_builtin_sys_fd_fsync(iw_value_t raw_fd) {
    if (_commit((int)iw_as_i64(raw_fd)) != 0) {
        iw_syscall_abort_errno("sys_file_flush");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_fd_fstat(iw_value_t raw_fd) {
    struct _stat64 stat_value;
    HANDLE handle;
    int64_t values[9];
    if (_fstat64((int)iw_as_i64(raw_fd), &stat_value) != 0) {
        iw_syscall_abort_errno("sys_file_stat");
    }
    handle = iw_handle_from_fd((int)iw_as_i64(raw_fd), "sys_file_stat");
    iw_fill_stat_values_from_handle(handle, (int64_t)stat_value.st_mode, values, "sys_file_stat");
    values[3] = (int64_t)stat_value.st_size;
    return iw_make_i5_array_from_values(values, 9, "sys_file_stat");
}

static inline iw_value_t iw_builtin_sys_path_stat_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_path_stat_s3 path");
    DWORD attributes = GetFileAttributesW(path);
    HANDLE handle;
    int64_t values[9];
    int64_t mode_value;
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        free(path);
        iw_syscall_abort_last_error("sys_path_stat_s3");
    }
    mode_value = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? _S_IFDIR : _S_IFREG;
    mode_value |= _S_IREAD;
    if ((attributes & FILE_ATTRIBUTE_READONLY) == 0) {
        mode_value |= _S_IWRITE;
    }
    handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    free(path);
    if (handle == INVALID_HANDLE_VALUE) {
        iw_syscall_abort_last_error("sys_path_stat_s3");
    }
    iw_fill_stat_values_from_handle(handle, mode_value, values, "sys_path_stat_s3");
    CloseHandle(handle);
    return iw_make_i5_array_from_values(values, 9, "sys_path_stat_s3");
}

static inline iw_value_t iw_builtin_sys_fd_pipe2(void) {
    int fds[2] = { -1, -1 };
    if (_pipe(fds, 4096, _O_BINARY | _O_NOINHERIT) != 0) {
        iw_syscall_abort_errno("sys_pipe_create");
    }
    return iw_make_i5_pair_array((int64_t)fds[0], (int64_t)fds[1], "sys_pipe_create");
}

static inline iw_value_t iw_builtin_sys_dir_open_s3(iw_value_t raw_path) {
    wchar_t *path = iw_text_to_wide(raw_path, "sys_dir_open_s3 path");
    wchar_t *search_pattern = iw_build_dir_search_pattern(path, "sys_dir_open_s3 search_pattern");
    WIN32_FIND_DATAW find_data;
    HANDLE handle = FindFirstFileW(search_pattern, &find_data);
    free(path);
    free(search_pattern);
    if (handle == INVALID_HANDLE_VALUE) {
        iw_syscall_abort_last_error("sys_dir_open_s3");
    }
    return iw_from_i64(iw_os_dir_handle_store(handle, &find_data, "sys_dir_open_s3"));
}

static inline iw_value_t iw_builtin_sys_dir_read_s3(iw_value_t raw_dir_handle) {
    iw_value_t result = (iw_value_t)0;
    AcquireSRWLockExclusive(&iw_os_handle_table_lock);
    {
        iw_os_handle_entry_t *entry = iw_os_handle_lookup_locked(raw_dir_handle, "sys_dir_read_s3");
        if (entry->kind != IW_OS_HANDLE_KIND_DIR) {
            ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
            iw_syscall_abort_invalid_handle_kind("sys_dir_read_s3", iw_as_i64(raw_dir_handle), "directory handle");
        }
        for (;;) {
            if (entry->dir_has_current == 0u) {
                if (entry->dir_eof != 0u) {
                    result = iw_text_empty("sys_dir_read_s3");
                    break;
                }
                if (!FindNextFileW(entry->handle, &entry->dir_data)) {
                    DWORD error = GetLastError();
                    if (error == ERROR_NO_MORE_FILES) {
                        entry->dir_eof = 1u;
                        result = iw_text_empty("sys_dir_read_s3");
                        break;
                    }
                    ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
                    iw_syscall_abort_last_error("sys_dir_read_s3");
                }
                entry->dir_has_current = 1u;
            }
            entry->dir_has_current = 0u;
            if (!iw_dir_entry_is_dot_name(entry->dir_data.cFileName)) {
                result = iw_wide_to_text(entry->dir_data.cFileName, "sys_dir_read_s3");
                break;
            }
        }
    }
    ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
    return result;
}

static inline iw_value_t iw_builtin_sys_process_spawn_common(
    iw_value_t raw_path,
    iw_value_t raw_argv,
    iw_value_t raw_envp,
    int use_stdio,
    int child_stdin_fd,
    int child_stdout_fd,
    int child_stderr_fd,
    const char *context
) {
    wchar_t *path = iw_text_to_wide(raw_path, context);
    iw_wide_string_array_t argv = iw_text_array_to_wide_strings(raw_argv, context);
    iw_wide_string_array_t envp = iw_text_array_to_wide_strings(raw_envp, context);
    wchar_t *command_line = iw_build_command_line(path, argv, context);
    wchar_t *env_block = iw_build_environment_block(envp, context);
    DWORD creation_flags = env_block == NULL ? 0u : CREATE_UNICODE_ENVIRONMENT;
    STARTUPINFOW startup_info;
    PROCESS_INFORMATION process_info;
    HANDLE child_stdin_handle = NULL;
    HANDLE child_stdout_handle = NULL;
    HANDLE child_stderr_handle = NULL;
    int64_t values[3];
    memset(&startup_info, 0, sizeof(startup_info));
    memset(&process_info, 0, sizeof(process_info));
    startup_info.cb = (DWORD)sizeof(startup_info);
    if (use_stdio) {
        child_stdin_handle = iw_duplicate_inheritable_fd_handle(child_stdin_fd, context);
        child_stdout_handle = iw_duplicate_inheritable_fd_handle(child_stdout_fd, context);
        child_stderr_handle = iw_duplicate_inheritable_fd_handle(child_stderr_fd, context);
        startup_info.dwFlags |= STARTF_USESTDHANDLES;
        startup_info.hStdInput = child_stdin_handle;
        startup_info.hStdOutput = child_stdout_handle;
        startup_info.hStdError = child_stderr_handle;
    }
    if (!CreateProcessW(NULL, command_line, NULL, NULL, use_stdio ? TRUE : FALSE, creation_flags, env_block, NULL, &startup_info, &process_info)) {
        if (child_stdin_handle != NULL) {
            CloseHandle(child_stdin_handle);
        }
        if (child_stdout_handle != NULL) {
            CloseHandle(child_stdout_handle);
        }
        if (child_stderr_handle != NULL) {
            CloseHandle(child_stderr_handle);
        }
        free(path);
        free(command_line);
        free(env_block);
        iw_free_wide_string_array(argv);
        iw_free_wide_string_array(envp);
        iw_syscall_abort_last_error(context);
    }
    if (child_stdin_handle != NULL) {
        CloseHandle(child_stdin_handle);
    }
    if (child_stdout_handle != NULL) {
        CloseHandle(child_stdout_handle);
    }
    if (child_stderr_handle != NULL) {
        CloseHandle(child_stderr_handle);
    }
    values[0] = iw_os_handle_store(process_info.hProcess, IW_OS_HANDLE_KIND_PROCESS, context);
    values[1] = iw_os_handle_store(process_info.hThread, IW_OS_HANDLE_KIND_THREAD, context);
    values[2] = (int64_t)process_info.dwProcessId;
    free(path);
    free(command_line);
    free(env_block);
    iw_free_wide_string_array(argv);
    iw_free_wide_string_array(envp);
    return iw_make_i5_array_from_values(values, 3, context);
}

static inline iw_value_t iw_builtin_sys_process_spawn_s3(iw_value_t raw_path, iw_value_t raw_argv, iw_value_t raw_envp) {
    return iw_builtin_sys_process_spawn_common(raw_path, raw_argv, raw_envp, 0, -1, -1, -1, "sys_process_spawn_s3");
}

static inline iw_value_t iw_builtin_sys_process_spawn_stdio_s3(
    iw_value_t raw_path,
    iw_value_t raw_argv,
    iw_value_t raw_envp,
    iw_value_t raw_stdin_fd,
    iw_value_t raw_stdout_fd,
    iw_value_t raw_stderr_fd
) {
    return iw_builtin_sys_process_spawn_common(
        raw_path,
        raw_argv,
        raw_envp,
        1,
        (int)iw_as_i64(raw_stdin_fd),
        (int)iw_as_i64(raw_stdout_fd),
        (int)iw_as_i64(raw_stderr_fd),
        "sys_process_spawn_stdio_s3"
    );
}

static inline iw_value_t iw_builtin_sys_process_wait(iw_value_t raw_process_handle) {
    HANDLE handle = iw_os_handle_expect_kind(raw_process_handle, IW_OS_HANDLE_KIND_PROCESS, "process handle", "sys_process_wait");
    DWORD wait_result;
    DWORD exit_code = 0u;
    uintptr_t current_sp = (uintptr_t)&handle;
    iw_gc_blocking_section_begin(current_sp);
    wait_result = WaitForSingleObject(handle, INFINITE);
    iw_gc_blocking_section_end();
    if (wait_result != WAIT_OBJECT_0) {
        iw_syscall_abort_last_error("sys_process_wait");
    }
    if (!GetExitCodeProcess(handle, &exit_code)) {
        iw_syscall_abort_last_error("sys_process_wait");
    }
    return iw_from_i64((int64_t)exit_code);
}

static inline iw_value_t iw_builtin_sys_process_kill(iw_value_t raw_process_handle) {
    if (!TerminateProcess(iw_os_handle_expect_kind(raw_process_handle, IW_OS_HANDLE_KIND_PROCESS, "process handle", "sys_process_kill"), 1u)) {
        iw_syscall_abort_last_error("sys_process_kill");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_time_unix_ms(void) {
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    return iw_from_i64(iw_filetime_to_unix_ms(&now));
}

static inline iw_value_t iw_builtin_sys_time_monotonic_ms(void) {
    return iw_from_i64((int64_t)GetTickCount64());
}

static inline iw_value_t iw_builtin_sys_net_startup(void) {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
        iw_syscall_abort_wsa("sys_net_startup");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_cleanup(void) {
    if (WSACleanup() == SOCKET_ERROR) {
        int error = WSAGetLastError();
        if (error != WSANOTINITIALISED) {
            iw_syscall_abort_wsa("sys_net_cleanup");
        }
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_socket_tcp4(void) {
    SOCKET fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == INVALID_SOCKET) {
        iw_syscall_abort_wsa("sys_net_tcp4_socket");
    }
    return iw_from_i64(iw_socket_to_i64(fd));
}

static inline iw_value_t iw_builtin_sys_net_close(iw_value_t raw_fd) {
    if (closesocket(iw_raw_to_socket(raw_fd)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_close");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_bind_ipv4_any(iw_value_t raw_fd, iw_value_t raw_port) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((u_short)iw_as_i64(raw_port));
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(iw_raw_to_socket(raw_fd), (struct sockaddr*)&address, (int)sizeof(address)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_bind_ipv4_any");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_bind_ipv4_loopback(iw_value_t raw_fd, iw_value_t raw_port) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((u_short)iw_as_i64(raw_port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(iw_raw_to_socket(raw_fd), (struct sockaddr*)&address, (int)sizeof(address)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_bind_ipv4_loopback");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_getsockname_ipv4_port(iw_value_t raw_fd) {
    struct sockaddr_in address;
    int address_length = (int)sizeof(address);
    memset(&address, 0, sizeof(address));
    if (getsockname(iw_raw_to_socket(raw_fd), (struct sockaddr*)&address, &address_length) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_getsockname_ipv4_port");
    }
    return iw_from_i64((int64_t)ntohs(address.sin_port));
}

static inline iw_value_t iw_builtin_sys_net_listen(iw_value_t raw_fd, iw_value_t raw_backlog) {
    if (listen(iw_raw_to_socket(raw_fd), (int)iw_as_i64(raw_backlog)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_listen");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_accept(iw_value_t raw_fd) {
    SOCKET accepted_fd = accept(iw_raw_to_socket(raw_fd), NULL, NULL);
    if (accepted_fd == INVALID_SOCKET) {
        iw_syscall_abort_wsa("sys_net_accept");
    }
    return iw_from_i64(iw_socket_to_i64(accepted_fd));
}

static inline iw_value_t iw_builtin_sys_net_connect_ipv4_loopback(iw_value_t raw_fd, iw_value_t raw_port) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((u_short)iw_as_i64(raw_port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(iw_raw_to_socket(raw_fd), (struct sockaddr*)&address, (int)sizeof(address)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_connect_ipv4_loopback");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_send_s3(iw_value_t raw_fd, iw_value_t raw_value) {
    iw_text_value_t *value = iw_text_expect(raw_value, "sys_net_send_s3 value");
    size_t written = 0u;
    while (written < value->length) {
        int chunk = send(iw_raw_to_socket(raw_fd), value->data + written, (int)((value->length - written) > (size_t)INT_MAX ? (size_t)INT_MAX : (value->length - written)), 0);
        if (chunk == SOCKET_ERROR) {
            iw_syscall_abort_wsa("sys_net_send_s3");
        }
        if (chunk == 0) {
            iw_syscall_abort_message("sys_net_send_s3", "short send");
        }
        written += (size_t)chunk;
    }
    return iw_from_i64((int64_t)written);
}

static inline iw_value_t iw_builtin_sys_net_recv_s3(iw_value_t raw_fd, iw_value_t raw_size) {
    int64_t requested = iw_as_i64(raw_size);
    char *buffer;
    int count;
    if (requested < 0) {
        iw_syscall_abort_message("sys_net_recv_s3", "size must be non-negative");
    }
    if (requested == 0) {
        return iw_text_empty("sys_net_recv_s3");
    }
    buffer = (char*)iw_syscall_xmalloc((size_t)requested, "sys_net_recv_s3");
    count = recv(iw_raw_to_socket(raw_fd), buffer, (int)((size_t)requested > (size_t)INT_MAX ? (size_t)INT_MAX : (size_t)requested), 0);
    if (count == SOCKET_ERROR) {
        free(buffer);
        iw_syscall_abort_wsa("sys_net_recv_s3");
    }
    {
        iw_value_t result = iw_text_copy_bytes(buffer, (size_t)count, "sys_net_recv_s3");
        free(buffer);
        return result;
    }
}

static inline iw_value_t iw_builtin_sys_net_shutdown(iw_value_t raw_fd, iw_value_t raw_how) {
    if (shutdown(iw_raw_to_socket(raw_fd), (int)iw_as_i64(raw_how)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_shutdown");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_set_nonblocking(iw_value_t raw_fd, iw_value_t raw_enabled) {
    u_long mode = iw_as_i64(raw_enabled) != 0 ? 1ul : 0ul;
    if (ioctlsocket(iw_raw_to_socket(raw_fd), FIONBIO, &mode) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_set_nonblocking");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_setsockopt_reuseaddr(iw_value_t raw_fd) {
    int enabled = 1;
    if (setsockopt(iw_raw_to_socket(raw_fd), SOL_SOCKET, SO_REUSEADDR, (const char*)&enabled, (int)sizeof(enabled)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_set_reuseaddr");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_net_setsockopt_tcp_nodelay(iw_value_t raw_fd) {
    int enabled = 1;
    if (setsockopt(iw_raw_to_socket(raw_fd), IPPROTO_TCP, TCP_NODELAY, (const char*)&enabled, (int)sizeof(enabled)) == SOCKET_ERROR) {
        iw_syscall_abort_wsa("sys_net_set_tcp_nodelay");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_event_create(iw_value_t raw_manual_reset, iw_value_t raw_initial_state) {
    HANDLE handle = CreateEventW(NULL, iw_as_i64(raw_manual_reset) != 0 ? TRUE : FALSE, iw_as_i64(raw_initial_state) != 0 ? TRUE : FALSE, NULL);
    if (handle == NULL) {
        iw_syscall_abort_last_error("sys_event_create");
    }
    return iw_from_i64(iw_os_handle_store(handle, IW_OS_HANDLE_KIND_EVENT, "sys_event_create"));
}

static inline iw_value_t iw_builtin_sys_event_set(iw_value_t raw_handle) {
    if (!SetEvent(iw_os_handle_expect_kind(raw_handle, IW_OS_HANDLE_KIND_EVENT, "event handle", "sys_event_set"))) {
        iw_syscall_abort_last_error("sys_event_set");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_event_reset(iw_value_t raw_handle) {
    if (!ResetEvent(iw_os_handle_expect_kind(raw_handle, IW_OS_HANDLE_KIND_EVENT, "event handle", "sys_event_reset"))) {
        iw_syscall_abort_last_error("sys_event_reset");
    }
    return iw_from_i64(0);
}

static inline iw_value_t iw_builtin_sys_wait_one(iw_value_t raw_handle, iw_value_t raw_timeout_ms) {
    HANDLE handle = iw_os_handle_expect_waitable(raw_handle, "sys_wait_one");
    DWORD wait_result;
    uintptr_t current_sp = (uintptr_t)&handle;
    iw_gc_blocking_section_begin(current_sp);
    wait_result = WaitForSingleObject(handle, iw_timeout_from_i64(iw_as_i64(raw_timeout_ms)));
    iw_gc_blocking_section_end();
    if (wait_result == WAIT_FAILED) {
        iw_syscall_abort_last_error("sys_wait_one");
    }
    return iw_from_i64((int64_t)wait_result);
}

static inline iw_value_t iw_builtin_sys_wait_many(iw_value_t raw_handles, iw_value_t raw_wait_all, iw_value_t raw_timeout_ms) {
    iw_array_value_t *handles = iw_array_expect(raw_handles, "sys_wait_many handles");
    HANDLE *raw_handle_values;
    DWORD wait_result;
    uintptr_t current_sp = (uintptr_t)&raw_handle_values;
    if (handles->length <= 0) {
        iw_syscall_abort_message("sys_wait_many", "requires at least one handle");
    }
    if (handles->length > (int64_t)MAXIMUM_WAIT_OBJECTS) {
        iw_syscall_abort_message("sys_wait_many", "too many handles");
    }
    raw_handle_values = (HANDLE*)iw_syscall_xmalloc((size_t)handles->length * sizeof(HANDLE), "sys_wait_many");
    for (int64_t index = 0; index < handles->length; index += 1) {
        raw_handle_values[index] = iw_os_handle_expect_waitable(handles->items[index], "sys_wait_many");
    }
    iw_gc_blocking_section_begin(current_sp);
    wait_result = WaitForMultipleObjects((DWORD)handles->length, raw_handle_values, iw_as_i64(raw_wait_all) != 0 ? TRUE : FALSE, iw_timeout_from_i64(iw_as_i64(raw_timeout_ms)));
    iw_gc_blocking_section_end();
    free(raw_handle_values);
    if (wait_result == WAIT_FAILED) {
        iw_syscall_abort_last_error("sys_wait_many");
    }
    return iw_from_i64((int64_t)wait_result);
}

static inline iw_value_t iw_builtin_sys_handle_close(iw_value_t raw_handle) {
    AcquireSRWLockExclusive(&iw_os_handle_table_lock);
    {
        iw_os_handle_entry_t *entry = iw_os_handle_lookup_locked(raw_handle, "sys_handle_close");
        iw_os_handle_close_raw(entry, "sys_handle_close");
    }
    ReleaseSRWLockExclusive(&iw_os_handle_table_lock);
    return iw_from_i64(0);
}
