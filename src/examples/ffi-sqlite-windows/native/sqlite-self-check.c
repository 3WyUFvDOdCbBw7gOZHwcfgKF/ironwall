#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

typedef intptr_t iw_value_t;

static inline int64_t iw_as_i64(iw_value_t value) {
    return ((int64_t)value) >> 1;
}

static inline iw_value_t iw_from_i64(int64_t value) {
    return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL);
}

typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;

typedef int (*sqlite3_open_fn)(const char *filename, sqlite3 **ppDb);
typedef int (*sqlite3_close_fn)(sqlite3 *db);
typedef const char *(*sqlite3_errmsg_fn)(sqlite3 *db);
typedef int (*sqlite3_prepare_v2_fn)(sqlite3 *db, const char *sql, int bytes, sqlite3_stmt **statement, const char **tail);
typedef int (*sqlite3_column_count_fn)(sqlite3_stmt *statement);
typedef const unsigned char *(*sqlite3_column_text_fn)(sqlite3_stmt *statement, int column);
typedef int (*sqlite3_column_bytes_fn)(sqlite3_stmt *statement, int column);
typedef long long (*sqlite3_column_int64_fn)(sqlite3_stmt *statement, int column);
typedef int (*sqlite3_total_changes_fn)(sqlite3 *db);
typedef int (*sqlite3_exec_fn)(sqlite3 *db, const char *sql, int (*callback)(void *, int, char **, char **), void *context, char **error_message);
typedef void (*sqlite3_free_fn)(void *pointer);
typedef int (*sqlite3_step_fn)(sqlite3_stmt *statement);
typedef int (*sqlite3_finalize_fn)(sqlite3_stmt *statement);

static HMODULE iw_sqlite_module = NULL;
static sqlite3_open_fn iw_sqlite3_open = NULL;
static sqlite3_close_fn iw_sqlite3_close = NULL;
static sqlite3_errmsg_fn iw_sqlite3_errmsg = NULL;
static sqlite3_prepare_v2_fn iw_sqlite3_prepare_v2 = NULL;
static sqlite3_column_count_fn iw_sqlite3_column_count = NULL;
static sqlite3_column_text_fn iw_sqlite3_column_text = NULL;
static sqlite3_column_bytes_fn iw_sqlite3_column_bytes = NULL;
static sqlite3_column_int64_fn iw_sqlite3_column_int64 = NULL;
static sqlite3_total_changes_fn iw_sqlite3_total_changes = NULL;
static sqlite3_exec_fn iw_sqlite3_exec = NULL;
static sqlite3_free_fn iw_sqlite3_free = NULL;
static sqlite3_step_fn iw_sqlite3_step = NULL;
static sqlite3_finalize_fn iw_sqlite3_finalize = NULL;

enum {
    SQLITE_OK = 0,
    SQLITE_ROW = 100,
    SQLITE_DONE = 101
};

static FARPROC iw_load_sqlite_symbol(const char *name) {
    FARPROC symbol = GetProcAddress(iw_sqlite_module, name);
    if (symbol == NULL) {
        fprintf(stderr, "ffi-sqlite missing sqlite symbol: %s\n", name);
        abort();
    }
    return symbol;
}

static void iw_ensure_sqlite_loaded(void) {
    if (iw_sqlite_module != NULL) {
        return;
    }

    static const char *const candidate_paths[] = {
        "sqlite-dll-win/sqlite3.dll"
    };

    for (size_t index = 0; index < sizeof(candidate_paths) / sizeof(candidate_paths[0]); index += 1u) {
        iw_sqlite_module = LoadLibraryA(candidate_paths[index]);
        if (iw_sqlite_module != NULL) {
            break;
        }
    }

    if (iw_sqlite_module == NULL) {
        fprintf(stderr, "ffi-sqlite failed to load bundled sqlite3.dll\n");
        abort();
    }

    iw_sqlite3_open = (sqlite3_open_fn)iw_load_sqlite_symbol("sqlite3_open");
    iw_sqlite3_close = (sqlite3_close_fn)iw_load_sqlite_symbol("sqlite3_close");
    iw_sqlite3_errmsg = (sqlite3_errmsg_fn)iw_load_sqlite_symbol("sqlite3_errmsg");
    iw_sqlite3_prepare_v2 = (sqlite3_prepare_v2_fn)iw_load_sqlite_symbol("sqlite3_prepare_v2");
    iw_sqlite3_column_count = (sqlite3_column_count_fn)iw_load_sqlite_symbol("sqlite3_column_count");
    iw_sqlite3_column_text = (sqlite3_column_text_fn)iw_load_sqlite_symbol("sqlite3_column_text");
    iw_sqlite3_column_bytes = (sqlite3_column_bytes_fn)iw_load_sqlite_symbol("sqlite3_column_bytes");
    iw_sqlite3_column_int64 = (sqlite3_column_int64_fn)iw_load_sqlite_symbol("sqlite3_column_int64");
    iw_sqlite3_total_changes = (sqlite3_total_changes_fn)iw_load_sqlite_symbol("sqlite3_total_changes");
    iw_sqlite3_exec = (sqlite3_exec_fn)iw_load_sqlite_symbol("sqlite3_exec");
    iw_sqlite3_free = (sqlite3_free_fn)iw_load_sqlite_symbol("sqlite3_free");
    iw_sqlite3_step = (sqlite3_step_fn)iw_load_sqlite_symbol("sqlite3_step");
    iw_sqlite3_finalize = (sqlite3_finalize_fn)iw_load_sqlite_symbol("sqlite3_finalize");
}

static const char *SQL_SCHEMA =
    "PRAGMA foreign_keys = ON;\n"
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, tier INTEGER NOT NULL);\n"
    "CREATE TABLE projects (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), code TEXT NOT NULL UNIQUE, budget INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);\n"
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL UNIQUE, points INTEGER NOT NULL, status TEXT NOT NULL);\n"
    "CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, delta INTEGER NOT NULL);\n"
    "CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);";
static const char *SQL_BEGIN = "BEGIN IMMEDIATE;";
static const char *SQL_INSERT_ACCOUNTS = "INSERT INTO accounts(name, tier) VALUES ('Acme', 2), ('Globex', 3);";
static const char *SQL_INSERT_PROJECTS =
    "INSERT INTO projects(account_id, code, budget, archived) VALUES\n"
    "  ((SELECT id FROM accounts WHERE name = 'Acme'), 'API', 120, 0),\n"
    "  ((SELECT id FROM accounts WHERE name = 'Acme'), 'WEB', 80, 0),\n"
    "  ((SELECT id FROM accounts WHERE name = 'Globex'), 'OPS', 60, 0);";
static const char *SQL_INSERT_TASKS =
    "INSERT INTO tasks(project_id, title, points, status) VALUES\n"
    "  ((SELECT id FROM projects WHERE code = 'API'), 'design schema', 5, 'done'),\n"
    "  ((SELECT id FROM projects WHERE code = 'API'), 'ship backend', 8, 'in_progress'),\n"
    "  ((SELECT id FROM projects WHERE code = 'WEB'), 'draft docs', 3, 'todo'),\n"
    "  ((SELECT id FROM projects WHERE code = 'WEB'), 'landing page', 4, 'done'),\n"
    "  ((SELECT id FROM projects WHERE code = 'OPS'), 'rotate keys', 2, 'todo'),\n"
    "  ((SELECT id FROM projects WHERE code = 'OPS'), 'audit trail', 6, 'in_review');";
static const char *SQL_INSERT_EVENTS =
    "INSERT INTO task_events(task_id, kind, delta) VALUES\n"
    "  ((SELECT id FROM tasks WHERE title = 'design schema'), 'estimate', 3),\n"
    "  ((SELECT id FROM tasks WHERE title = 'design schema'), 'bonus', 1),\n"
    "  ((SELECT id FROM tasks WHERE title = 'ship backend'), 'estimate', 5),\n"
    "  ((SELECT id FROM tasks WHERE title = 'ship backend'), 'rework', -2),\n"
    "  ((SELECT id FROM tasks WHERE title = 'draft docs'), 'estimate', 1),\n"
    "  ((SELECT id FROM tasks WHERE title = 'landing page'), 'estimate', 2),\n"
    "  ((SELECT id FROM tasks WHERE title = 'rotate keys'), 'estimate', 1),\n"
    "  ((SELECT id FROM tasks WHERE title = 'rotate keys'), 'noise', 99),\n"
    "  ((SELECT id FROM tasks WHERE title = 'audit trail'), 'estimate', 4);";
static const char *SQL_SAVEPOINT = "SAVEPOINT scratch;";
static const char *SQL_INSERT_TEMP_TASK = "INSERT INTO tasks(project_id, title, points, status) VALUES ((SELECT id FROM projects WHERE code = 'WEB'), 'temporary import', 9, 'todo');";
static const char *SQL_INSERT_TEMP_EVENT = "INSERT INTO task_events(task_id, kind, delta) VALUES ((SELECT id FROM tasks WHERE title = 'temporary import'), 'estimate', 7);";
static const char *SQL_ROLLBACK_TEMP = "ROLLBACK TO scratch; RELEASE scratch;";
static const char *SQL_APPLY_UPDATES =
    "UPDATE tasks SET status = 'done', points = points + 2 WHERE title = 'draft docs';\n"
    "UPDATE tasks SET status = 'done' WHERE title = 'ship backend';\n"
    "UPDATE tasks SET points = points + 1 WHERE title = 'rotate keys';";
static const char *SQL_INSERT_AUDIT = "INSERT INTO task_events(task_id, kind, delta) SELECT id, 'audit', 2 FROM tasks WHERE status = 'done';";
static const char *SQL_DELETE_NOISE = "DELETE FROM task_events WHERE kind = 'noise';";
static const char *SQL_UPDATE_BUDGET = "UPDATE projects SET budget = budget + 15 WHERE code = 'API';";
static const char *SQL_COMMIT = "COMMIT;";
static const char *SQL_PROJECT_ROLLUP =
    "WITH event_totals AS (\n"
    "  SELECT task_id, SUM(delta) AS delta_total\n"
    "  FROM task_events\n"
    "  GROUP BY task_id\n"
    ")\n"
    "SELECT\n"
    "  a.name,\n"
    "  p.code,\n"
    "  p.budget,\n"
    "  COALESCE(SUM(t.points), 0),\n"
    "  COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0),\n"
    "  COALESCE(SUM(COALESCE(event_totals.delta_total, 0)), 0)\n"
    "FROM accounts a\n"
    "JOIN projects p ON p.account_id = a.id\n"
    "LEFT JOIN tasks t ON t.project_id = p.id\n"
    "LEFT JOIN event_totals ON event_totals.task_id = t.id\n"
    "WHERE p.archived = 0\n"
    "GROUP BY a.name, p.code, p.budget\n"
    "HAVING COUNT(t.id) > 0\n"
    "ORDER BY a.name, p.code;";
static const char *SQL_STATUS_SNAPSHOT =
    "SELECT\n"
    "  p.code,\n"
    "  t.title,\n"
    "  t.status,\n"
    "  CASE WHEN t.status = 'done' THEN 'closed' ELSE 'open' END\n"
    "FROM tasks t\n"
    "JOIN projects p ON p.id = t.project_id\n"
    "WHERE t.points >= 5\n"
    "ORDER BY p.code, t.title;";
static const char *SQL_METRICS =
    "SELECT value FROM (\n"
    "  SELECT 1 AS ord, COUNT(*) AS value FROM tasks WHERE status = 'done'\n"
    "  UNION ALL\n"
    "  SELECT 2 AS ord, COALESCE(SUM(points), 0) AS value FROM tasks\n"
    "  UNION ALL\n"
    "  SELECT 3 AS ord, COALESCE(SUM(delta), 0) AS value FROM task_events\n"
    "  UNION ALL\n"
    "  SELECT 4 AS ord, COUNT(*) AS value FROM task_events WHERE kind = 'audit'\n"
    "  UNION ALL\n"
    "  SELECT 5 AS ord, COUNT(*) AS value FROM projects WHERE budget >= 100\n"
    "  UNION ALL\n"
    "  SELECT 6 AS ord, COUNT(*) AS value FROM tasks WHERE title = 'temporary import'\n"
    ") ORDER BY ord;";

static int fail_sqlite(sqlite3 *db, const char *context, int rc) {
    fprintf(stderr, "ffi-sqlite %s failed: rc=%d sqlite=%s\n", context, rc, db == NULL ? "<null>" : iw_sqlite3_errmsg(db));
    return 1;
}

static int exec_and_expect_changes(sqlite3 *db, const char *sql, int expected, const char *label) {
    char *error_message = NULL;
    int before = iw_sqlite3_total_changes(db);
    int rc = iw_sqlite3_exec(db, sql, NULL, NULL, &error_message);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "ffi-sqlite %s exec detail=%s\n", label, error_message == NULL ? "sqlite3_exec" : error_message);
        if (error_message != NULL) {
            iw_sqlite3_free(error_message);
        }
        return fail_sqlite(db, label, rc);
    }
    if (error_message != NULL) {
        iw_sqlite3_free(error_message);
    }
    if ((iw_sqlite3_total_changes(db) - before) != expected) {
        fprintf(stderr, "ffi-sqlite %s change mismatch\n", label);
        return 1;
    }
    return 0;
}

static int expect_text_rows(sqlite3 *db, const char *sql, const char *const *expected_rows, int expected_count, const char *label) {
    sqlite3_stmt *stmt = NULL;
    int rc = iw_sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK || stmt == NULL) {
        return fail_sqlite(db, label, rc);
    }

    for (int row_index = 0; row_index < expected_count; row_index += 1) {
        rc = iw_sqlite3_step(stmt);
        if (rc != SQLITE_ROW) {
            iw_sqlite3_finalize(stmt);
            return fail_sqlite(db, label, rc);
        }

        int column_count = iw_sqlite3_column_count(stmt);
        char buffer[512];
        size_t cursor = 0u;
        for (int column = 0; column < column_count; column += 1) {
            const unsigned char *text = iw_sqlite3_column_text(stmt, column);
            size_t text_length = text == NULL ? 4u : (size_t)iw_sqlite3_column_bytes(stmt, column);
            if (cursor + text_length + 2u >= sizeof(buffer)) {
                iw_sqlite3_finalize(stmt);
                fprintf(stderr, "ffi-sqlite %s row buffer overflow\n", label);
                return 1;
            }
            if (text == NULL) {
                memcpy(buffer + cursor, "NULL", 4u);
                cursor += 4u;
            } else {
                memcpy(buffer + cursor, text, text_length);
                cursor += text_length;
            }
            if (column + 1 < column_count) {
                buffer[cursor] = '|';
                cursor += 1u;
            }
        }
        buffer[cursor] = '\0';
        if (strcmp(buffer, expected_rows[row_index]) != 0) {
            iw_sqlite3_finalize(stmt);
            fprintf(stderr, "ffi-sqlite %s row mismatch: expected=%s actual=%s\n", label, expected_rows[row_index], buffer);
            return 1;
        }
    }

    rc = iw_sqlite3_step(stmt);
    if (rc != SQLITE_DONE) {
        iw_sqlite3_finalize(stmt);
        return fail_sqlite(db, label, rc);
    }
    if (iw_sqlite3_finalize(stmt) != SQLITE_OK) {
        return fail_sqlite(db, label, rc);
    }
    return 0;
}

static int expect_i64_rows(sqlite3 *db, const char *sql, const long long *expected_rows, int expected_count, const char *label) {
    sqlite3_stmt *stmt = NULL;
    int rc = iw_sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK || stmt == NULL) {
        return fail_sqlite(db, label, rc);
    }
    if (iw_sqlite3_column_count(stmt) != 1) {
        iw_sqlite3_finalize(stmt);
        fprintf(stderr, "ffi-sqlite %s column count mismatch\n", label);
        return 1;
    }

    for (int row_index = 0; row_index < expected_count; row_index += 1) {
        rc = iw_sqlite3_step(stmt);
        if (rc != SQLITE_ROW) {
            iw_sqlite3_finalize(stmt);
            return fail_sqlite(db, label, rc);
        }
        if (iw_sqlite3_column_int64(stmt, 0) != expected_rows[row_index]) {
            iw_sqlite3_finalize(stmt);
            fprintf(stderr, "ffi-sqlite %s metric mismatch at row %d\n", label, row_index);
            return 1;
        }
    }

    rc = iw_sqlite3_step(stmt);
    if (rc != SQLITE_DONE) {
        iw_sqlite3_finalize(stmt);
        return fail_sqlite(db, label, rc);
    }
    if (iw_sqlite3_finalize(stmt) != SQLITE_OK) {
        return fail_sqlite(db, label, rc);
    }
    return 0;
}

static int run_sqlite_self_check(void) {
    static const char *const expected_rollup_rows[] = {
        "Acme|API|135|13|2|11",
        "Acme|WEB|80|9|2|7",
        "Globex|OPS|60|9|0|5"
    };
    static const char *const expected_status_rows[] = {
        "API|design schema|done|closed",
        "API|ship backend|done|closed",
        "OPS|audit trail|in_review|open",
        "WEB|draft docs|done|closed"
    };
    static const long long expected_metric_rows[] = { 4, 31, 23, 4, 1, 0 };
    sqlite3 *db = NULL;
    iw_ensure_sqlite_loaded();
    int rc = iw_sqlite3_open(":memory:", &db);
    if (rc != SQLITE_OK || db == NULL) {
        return fail_sqlite(db, "sqlite3_open", rc);
    }

    if (exec_and_expect_changes(db, SQL_SCHEMA, 0, "schema") != 0 ||
        exec_and_expect_changes(db, SQL_BEGIN, 0, "begin") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_ACCOUNTS, 2, "insert_accounts") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_PROJECTS, 3, "insert_projects") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_TASKS, 6, "insert_tasks") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_EVENTS, 9, "insert_events") != 0 ||
        exec_and_expect_changes(db, SQL_SAVEPOINT, 0, "savepoint") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_TEMP_TASK, 1, "insert_temp_task") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_TEMP_EVENT, 1, "insert_temp_event") != 0 ||
        exec_and_expect_changes(db, SQL_ROLLBACK_TEMP, 0, "rollback_temp") != 0 ||
        exec_and_expect_changes(db, SQL_APPLY_UPDATES, 3, "apply_updates") != 0 ||
        exec_and_expect_changes(db, SQL_INSERT_AUDIT, 4, "insert_audit") != 0 ||
        exec_and_expect_changes(db, SQL_DELETE_NOISE, 1, "delete_noise") != 0 ||
        exec_and_expect_changes(db, SQL_UPDATE_BUDGET, 1, "update_budget") != 0 ||
        exec_and_expect_changes(db, SQL_COMMIT, 0, "commit") != 0 ||
        expect_text_rows(db, SQL_PROJECT_ROLLUP, expected_rollup_rows, 3, "project_rollup") != 0 ||
        expect_text_rows(db, SQL_STATUS_SNAPSHOT, expected_status_rows, 4, "status_snapshot") != 0 ||
        expect_i64_rows(db, SQL_METRICS, expected_metric_rows, 6, "metrics") != 0) {
        iw_sqlite3_close(db);
        return 1;
    }

    rc = iw_sqlite3_close(db);
    if (rc != SQLITE_OK) {
        return fail_sqlite(db, "sqlite3_close", rc);
    }
    return 0;
}

iw_value_t _4e3d7b21f9c84d7db8c1e45a6f9230ab_clang_iw_release_sqlite_self_check_b8076262(void) {
    return iw_from_i64((int64_t)run_sqlite_self_check());
}