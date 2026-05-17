#ifndef IW_EXPORT_ABI_H
#define IW_EXPORT_ABI_H

#include <stdint.h>
#include <stdlib.h>

#include "iw_value_abi.h"

typedef struct iw_host_array_i5_t {
    int64_t length;
    int32_t *items;
} iw_host_array_i5_t;

typedef struct iw_host_array_s3_t {
    int64_t length;
    char **items;
} iw_host_array_s3_t;

static inline void iw_host_free_s3(char *value) {
    free(value);
}

static inline void iw_host_free_array_i5(iw_host_array_i5_t value) {
    free(value.items);
}

static inline void iw_host_free_array_s3(iw_host_array_s3_t value) {
    if (value.items == NULL) {
        return;
    }
    for (int64_t index = 0; index < value.length; index += 1) {
        free(value.items[index]);
    }
    free(value.items);
}

#endif