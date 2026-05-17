#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

typedef intptr_t iw_value_t;

static inline iw_value_t iw_from_i64(int64_t value) {
    return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL);
}

static const char *SQLITE_TOOL_PATH = "sqlite-tools-linux-x64-3530100/sqlite3";
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

static int remove_if_exists(const char *path) {
    if (unlink(path) == 0 || errno == ENOENT) {
        return 0;
    }
    return -1;
}

static int write_text_file(const char *path, const char *text) {
    FILE *handle = fopen(path, "wb");
    if (handle == NULL) {
        return -1;
    }
    size_t length = strlen(text);
    int ok = fwrite(text, 1u, length, handle) == length ? 0 : -1;
    if (fclose(handle) != 0) {
        return -1;
    }
    return ok;
}

static int run_sqlite_script(const char *db_path, const char *script_text, const char *output_path) {
    char script_path[512];
    char command[2048];
    snprintf(script_path, sizeof(script_path), "%s.sql", output_path);
    if (write_text_file(script_path, script_text) != 0) {
        return -1;
    }
    snprintf(
        command,
        sizeof(command),
        "%s -batch -noheader '%s' < '%s' > '%s'",
        SQLITE_TOOL_PATH,
        db_path,
        script_path,
        output_path
    );
    int status = system(command);
    remove_if_exists(script_path);
    if (status == -1) {
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        return -1;
    }
    return 0;
}

static int read_trimmed_file(const char *path, char *buffer, size_t buffer_size) {
    FILE *handle = fopen(path, "rb");
    if (handle == NULL) {
        return -1;
    }
    size_t length = fread(buffer, 1u, buffer_size - 1u, handle);
    if (ferror(handle)) {
        fclose(handle);
        return -1;
    }
    fclose(handle);
    while (length > 0u && (buffer[length - 1u] == '\n' || buffer[length - 1u] == '\r')) {
        length -= 1u;
    }
    buffer[length] = '\0';
    return 0;
}

static int query_single_i64(const char *db_path, const char *sql, long long *result) {
    char script[512];
    char output_path[] = "runtime/sqlite-single.out";
    char buffer[128];
    snprintf(script, sizeof(script), ".mode list\n%s\n", sql);
    if (run_sqlite_script(db_path, script, output_path) != 0) {
        return -1;
    }
    if (read_trimmed_file(output_path, buffer, sizeof(buffer)) != 0) {
        remove_if_exists(output_path);
        return -1;
    }
    remove_if_exists(output_path);
    *result = strtoll(buffer, NULL, 10);
    return 0;
}

static int exec_and_expect_changes(const char *db_path, const char *sql, int expected, const char *label) {
    char script[8192];
    char output_path[] = "runtime/sqlite-exec.out";
    FILE *handle = NULL;
    char line[128];
    long long before = 0;
    long long after = 0;
    int saw_before = 0;
    int saw_after = 0;
    snprintf(script, sizeof(script), ".mode list\nSELECT total_changes();\n%s\nSELECT total_changes();\n", sql);
    if (run_sqlite_script(db_path, script, output_path) != 0) {
        fprintf(stderr, "ffi-sqlite %s failed exec\n", label);
        remove_if_exists(output_path);
        return 1;
    }
    handle = fopen(output_path, "rb");
    if (handle == NULL) {
        remove_if_exists(output_path);
        return 1;
    }
    while (fgets(line, sizeof(line), handle) != NULL) {
        if (!saw_before) {
            before = strtoll(line, NULL, 10);
            saw_before = 1;
        } else {
            after = strtoll(line, NULL, 10);
            saw_after = 1;
        }
    }
    fclose(handle);
    remove_if_exists(output_path);
    if (!saw_before || !saw_after || (after - before) != expected) {
        fprintf(stderr, "ffi-sqlite %s change mismatch\n", label);
        return 1;
    }
    return 0;
}

static int expect_text_rows(const char *db_path, const char *sql, const char *const *expected_rows, int expected_count, const char *label) {
    char script[4096];
    char output_path[] = "runtime/sqlite-rows.out";
    FILE *handle = NULL;
    char line[512];
    int row_index = 0;
    snprintf(script, sizeof(script), ".mode list\n.separator |\n%s\n", sql);
    if (run_sqlite_script(db_path, script, output_path) != 0) {
        fprintf(stderr, "ffi-sqlite %s failed query\n", label);
        return 1;
    }
    handle = fopen(output_path, "rb");
    if (handle == NULL) {
        remove_if_exists(output_path);
        return 1;
    }
    while (fgets(line, sizeof(line), handle) != NULL) {
        size_t length = strlen(line);
        while (length > 0u && (line[length - 1u] == '\n' || line[length - 1u] == '\r')) {
            line[--length] = '\0';
        }
        if (row_index >= expected_count || strcmp(line, expected_rows[row_index]) != 0) {
            fclose(handle);
            remove_if_exists(output_path);
            fprintf(stderr, "ffi-sqlite %s row mismatch\n", label);
            return 1;
        }
        row_index += 1;
    }
    fclose(handle);
    remove_if_exists(output_path);
    if (row_index != expected_count) {
        fprintf(stderr, "ffi-sqlite %s row count mismatch\n", label);
        return 1;
    }
    return 0;
}

static int expect_i64_rows(const char *db_path, const char *sql, const long long *expected_rows, int expected_count, const char *label) {
    char script[4096];
    char output_path[] = "runtime/sqlite-metrics.out";
    FILE *handle = NULL;
    char line[128];
    int row_index = 0;
    snprintf(script, sizeof(script), ".mode list\n%s\n", sql);
    if (run_sqlite_script(db_path, script, output_path) != 0) {
        fprintf(stderr, "ffi-sqlite %s failed query\n", label);
        return 1;
    }
    handle = fopen(output_path, "rb");
    if (handle == NULL) {
        remove_if_exists(output_path);
        return 1;
    }
    while (fgets(line, sizeof(line), handle) != NULL) {
        long long value = 0;
        if (row_index >= expected_count) {
            fclose(handle);
            remove_if_exists(output_path);
            fprintf(stderr, "ffi-sqlite %s row count mismatch\n", label);
            return 1;
        }
        value = strtoll(line, NULL, 10);
        if (value != expected_rows[row_index]) {
            fclose(handle);
            remove_if_exists(output_path);
            fprintf(stderr, "ffi-sqlite %s metric mismatch\n", label);
            return 1;
        }
        row_index += 1;
    }
    fclose(handle);
    remove_if_exists(output_path);
    if (row_index != expected_count) {
        fprintf(stderr, "ffi-sqlite %s row count mismatch\n", label);
        return 1;
    }
    return 0;
}

static int run_setup_script(const char *db_path) {
    char script[16384];
    char output_path[] = "runtime/sqlite-setup.out";
    snprintf(
        script,
        sizeof(script),
        "%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n",
        SQL_SCHEMA,
        SQL_BEGIN,
        SQL_INSERT_ACCOUNTS,
        SQL_INSERT_PROJECTS,
        SQL_INSERT_TASKS,
        SQL_INSERT_EVENTS,
        SQL_SAVEPOINT,
        SQL_INSERT_TEMP_TASK,
        SQL_INSERT_TEMP_EVENT,
        SQL_ROLLBACK_TEMP,
        SQL_APPLY_UPDATES,
        SQL_INSERT_AUDIT,
        SQL_DELETE_NOISE,
        SQL_UPDATE_BUDGET,
        SQL_COMMIT
    );
    if (run_sqlite_script(db_path, script, output_path) != 0) {
        remove_if_exists(output_path);
        return 1;
    }
    remove_if_exists(output_path);
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
    char temp_root[] = "runtime/sqlite-db-XXXXXX";
    char db_path[512];

    if (mkdir("runtime", 0777) != 0 && errno != EEXIST) {
        return 1;
    }
    if (mkdtemp(temp_root) == NULL) {
        return 1;
    }
    snprintf(db_path, sizeof(db_path), "%s/example.db", temp_root);

    if (run_setup_script(db_path) != 0 ||
        expect_text_rows(db_path, SQL_PROJECT_ROLLUP, expected_rollup_rows, 3, "project_rollup") != 0 ||
        expect_text_rows(db_path, SQL_STATUS_SNAPSHOT, expected_status_rows, 4, "status_snapshot") != 0 ||
        expect_i64_rows(db_path, SQL_METRICS, expected_metric_rows, 6, "metrics") != 0) {
        remove_if_exists(db_path);
        rmdir(temp_root);
        return 1;
    }

    remove_if_exists(db_path);
    rmdir(temp_root);
    return 0;
}

iw_value_t _4e3d7b21f9c84d7db8c1e45a6f9230ab_clang_iw_release_sqlite_self_check_b8076262(void) {
    return iw_from_i64((int64_t)run_sqlite_self_check());
}