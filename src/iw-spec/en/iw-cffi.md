# Ironwall C FFI Specification

This document defines Ironwall's current C FFI rules, including Ironwall calling C, C calling Ironwall, and the types and naming rules allowed across the boundary.

## 1. Position

Ironwall does not encourage FFI.

FFI is a temporary compromise, not Ironwall's ideal boundary. The reason is direct:

- C does not provide the memory-safety and type-safety guarantees that Ironwall wants to provide
- C code can read and write out of bounds, keep dangling pointers, corrupt the runtime heap, corrupt GC metadata, and free memory incorrectly
- Once execution enters C, Ironwall's safety model can only treat C as a trusted but unsafe external world

Therefore:

- FFI should be used only at necessary system boundaries, for existing C libraries, platform syscall wrappers, and transitional runtime glue
- FFI should not be treated as a routine abstraction mechanism
- FFI should not be used to bypass the Ironwall type system, GC, safety boundary, or module rules
- A bug on the C side is a bug that can break the whole process; it is not an ordinary error that Ironwall can fully isolate

The existence of FFI is an engineering reality, not a language direction. Ironwall's long-term direction should be to reduce FFI surface area, not to expand it.

## 2. Core Model

C FFI has two directions:

- Ironwall calls C: external C functions are declared in Ironwall with `declare`
- C calls Ironwall: Ironwall functions with names following the export rule are exported as C-callable functions

The two directions use different ABIs:

- `declare ... clang ...` uses the low-level runtime ABI, where C functions directly receive and return `iw_value_t`
- `iwlang` export uses the C boundary ABI, where C functions use `int64_t`, `const char *`, `char *`, and array structs

This split is intentional:

- When Ironwall calls C, C is treated as an internal runtime extension and must understand `iw_value_t`
- When C calls Ironwall, the external caller should not depend directly on heap-object layout; cross-boundary values must use ABI representations allowed by the specification

## 3. Naming Rules

FFI symbols must use a full name carrying a namespace UUID and confirmation tag. Old-style bare C symbols do not conform to the spec.

### 3.1 names for Ironwall calling C

Format:

```text
_<uuid>_clang_<function_name>_<tag1>
```

Where:

- `<uuid>` is a namespace string containing only ASCII letters and digits
- `clang` is fixed and indicates "this symbol is provided by C"
- `<function_name>` must match the C-identifier shape: `[A-Za-z_][A-Za-z0-9_]*`
- `<tag1>` is an 8-digit hexadecimal confirmation tag

Example:

```text
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
```

If the tag does not match the uuid / function name, compilation must reject it.

### 3.2 export names for C calling Ironwall

Format:

```text
_<uuid>_iwlang_<function_name>_<tag1>
```

Where:

- `iwlang` is fixed and indicates "this symbol is exported by Ironwall"
- The other fields follow the same rules as the `clang` naming form

Example:

```text
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
```

### 3.3 purpose of the tag

The confirmation tag is not a security key and not a permission mechanism. Its purpose is:

- To prevent hand-written symbols from silently linking when the namespace or function name was typed incorrectly
- To provide a low-cost consistency check for cross-language boundary names
- To keep old-style bare symbols from silently mixing into the formal FFI spec

Users may calculate tags by the following rule, or use a naming tool that follows this rule.

### 3.4 confirmation-tag calculation rule

The confirmation tag is calculated with 64-bit FNV-1a.

`hashText(input)` is defined as follows:

- Initial value: `14695981039346656037`
- Prime: `1099511628211`
- For each UTF-16 code unit in the input:
- `hash = hash xor code_unit`
- `hash = (hash * prime) mod 2^64`
- The final output is a 16-digit lowercase hexadecimal string, left-padded with `0` if needed

The hash input for a declared C function using `clang` is:

```text
<uuid>clang<function_name>
```

The hash input for an exported Ironwall function using `iwlang` is:

```text
<uuid>iwlang<function_name>
```

`tag1` is the last 8 hexadecimal digits of `hashText(hash_input)`.

Example:

```text
uuid = 81af42c9d7354eb08bfe95163c04ad20
language = clang
function_name = iw_build_json_add_seven
hash_input = 81af42c9d7354eb08bfe95163c04ad20clangiw_build_json_add_seven
hashText(hash_input) = 6d7038b4c267f2a7
tag1 = c267f2a7
```

Therefore the full symbol is:

```text
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
```

## 4. Ironwall Calling C

### 4.1 Ironwall declaration syntax

Ironwall declares C functions through `declare`:

```ironwall
(declare
  (function _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
    ([value i5])
    to i5))
```

It is then used like an ordinary function:

```ironwall
{program app@main
  (declare
    (function _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
      ([value i5])
      to i5))

  (function main ([args <array s3>]) to i5 in
    (_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7 $35^i5))
}
```

### 4.2 C-side function signature

The current C ABI for `declare` is the `iw_value_t` ABI. A C function must directly receive and return `iw_value_t`:

```c
#include <stdint.h>

typedef intptr_t iw_value_t;

static inline int64_t iw_as_i64(iw_value_t value) {
    return ((int64_t)value) >> 1;
}

static inline iw_value_t iw_from_i64(int64_t value) {
    return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL);
}

iw_value_t _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7(iw_value_t value) {
    int32_t raw = (int32_t)iw_as_i64(value);
    uint32_t wrapped = ((uint32_t)raw) + 7u;
    return iw_from_i64((int64_t)(int32_t)wrapped);
}
```

Note: `iw_as_i64` / `iw_from_i64` on `iw_value_t` describe the carrying format of the tagged immediate, not the semantic width of every integer type. The semantic width of `i5` is 32-bit. If a declared C function wants to use an `i5` as a native number, it must first explicitly convert it to `int32_t` on the C side before doing arithmetic.

### 4.3 `unit` return values

In the C ABI, Ironwall `unit` is still represented as `iw_value_t`. The C side should return `iw_from_i64(0)`:

```ironwall
(declare
  (function _5e8f0a4c71d24b6fa39ce2158bd7f043_clang_iw_sys_fd_close_a14b05cf
    ([fd i5])
    to unit))
```

```c
iw_value_t _5e8f0a4c71d24b6fa39ce2158bd7f043_clang_iw_sys_fd_close_a14b05cf(iw_value_t raw_fd) {
    int fd = (int)iw_as_i64(raw_fd);
    close(fd);
    return iw_from_i64(0);
}
```

### 4.4 building heap values on the C side

If a declared C function needs to return an Ironwall heap value, it must not manually allocate or forge heap objects; it must use boundary functions provided by the declared C ABI.

Public heap values that C may create include:

- `s3`
- `<array i5>`
- `<array s3>`

The declared C ABI must provide these operations:

```c
iw_value_t iw_make_s3(const char *data);
iw_value_t iw_make_array_i5(int64_t length);
iw_value_t iw_make_array_s3(int64_t length);

int32_t iw_array_i5_get(iw_value_t value, int64_t index);
void iw_array_i5_set(iw_value_t value, int64_t index, int32_t element_value);
int64_t iw_array_i5_length(iw_value_t value);

iw_value_t iw_array_s3_get(iw_value_t value, int64_t index);
void iw_array_s3_set(iw_value_t value, int64_t index, iw_value_t element_value);
int64_t iw_array_s3_length(iw_value_t value);
```

Rules:

- `iw_make_s3` must copy C string content into Ironwall `s3`; Ironwall must not depend on the C buffer after the function returns
- `iw_make_array_i5` / `iw_make_array_s3` create fixed-length Ironwall arrays
- Array `get` / `set` must obey Ironwall array bounds rules; out-of-bounds access is an unrecoverable runtime failure
- The element value passed to `iw_array_s3_set` must be a valid Ironwall `s3` value, usually created by `iw_make_s3`
- C must not keep `iw_value_t` values returned by these functions as long-lived state across calls

Example:

```ironwall
{program app@main
  (declare
    (function _9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00
      ()
      to <array i5>))

  (function main ([args <array s3>]) to i5 in
    (array_get (_9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00) $0^i5))
}
```

```c
iw_value_t _9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00(void) {
    iw_value_t value = iw_make_array_i5(3);
    iw_array_i5_set(value, 0, 7);
    iw_array_i5_set(value, 1, 11);
    iw_array_i5_set(value, 2, 13);
    return value;
}
```

### 4.5 portable declared-C types

The `declare ... clang ...` direction may currently use value types from ordinary Ironwall function types, but the formal, portable, and recommended set is:

- `unit`
- `bool`
- `i5`
- `i6`
- `i7`
- `u5`
- `u6`
- `u7`
- `f5`
- `f6`
- `f7`
- `c3`
- `c4`
- `c5`
- `s3`
- `s4`
- `s5`
- `z5`
- `z6`
- `z7`
- `<array i5>`
- `<array s3>`

Where:

- All values cross the declared-C ABI as `iw_value_t`
- Integer, unsigned, bool, and unit are immediate `iw_value_t`
- Float, text, complex, and array values are heap/reference `iw_value_t`
- `<array i5>` and `<array s3>` have stable boundary operations
- Other heap types should not be used as public C FFI API types

The following are not recommended across the declared-C boundary:

- Class instances
- Closures
- Unions
- Nested arrays
- Generic class instances other than `<array i5>` / `<array s3>`

These types would tie C to Ironwall's internal layout, GC metadata, and runtime tags, which is poor for both safety and compatibility.

## 5. C Calling Ironwall

### 5.1 export mode

If an Ironwall function is to be exported to C, its function name must use the `iwlang` naming rule:

```ironwall
{program app@main
  (function _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
    ([value i5])
    to i5
    in
    (add value $1^i5))
}
```

### 5.2 C-visible signatures

When C calls Ironwall, it does not use the declared-C `iw_value_t` ABI directly. Instead it uses the C boundary ABI:

| Ironwall type | C parameter type | C return type |
| --- | --- | --- |
| `i5` | `int32_t` | `int32_t` |
| `s3` | `const char *` | `char *` |
| `<array i5>` | `iw_c_array_i5_t` | `iw_c_array_i5_t` |
| `<array s3>` | `iw_c_array_s3_t` | `iw_c_array_s3_t` |

At present, only the types in the table above are supported for C calling Ironwall. Other types must not be used as parameters or return values of exported Ironwall functions.

C array ABI:

```c
typedef struct iw_c_array_i5_t {
    int64_t length;
    int32_t *items;
} iw_c_array_i5_t;

typedef struct iw_c_array_s3_t {
    int64_t length;
    char **items;
} iw_c_array_s3_t;
```

### 5.3 memory ownership

Exported functions perform copying at the C/Ironwall boundary.

Rules:

- When C passes `const char *`, the boundary function copies it into Ironwall `s3`
- When C passes an array struct, the boundary function copies the array contents
- When Ironwall returns `s3`, the boundary function allocates a C `char *`
- When Ironwall returns `<array i5>` or `<array s3>`, the boundary function allocates the `items` field inside the C array struct
- The C caller must free heap memory returned by the C boundary

The C boundary ABI must provide corresponding free operations:

```c
void iw_c_free_s3(char *value);
void iw_c_free_array_i5(iw_c_array_i5_t value);
void iw_c_free_array_s3(iw_c_array_s3_t value);
```

## 6. GC and Safety Requirements

C FFI must obey the following rules:

- C must not retain Ironwall heap pointers as long-lived state unless the spec explicitly allows it
- C must not manually `free` Ironwall heap objects
- C must not forge `iw_value_t` heap references
- C must not modify the Ironwall heap header, runtime type tag, GC tag, or metadata table
- If C needs to construct Ironwall heap values, it must use boundary functions allowed by the specification
- If C needs to return `unit`, it must return `iw_from_i64(0)`
- If C takes ownership of `char *` / C arrays returned by an exported Ironwall function, it must release them using the corresponding C boundary free operation

## 7. Discouraged Patterns

The following patterns do not fit Ironwall's safety position:

- Writing large amounts of business logic in C while treating Ironwall only as glue
- Using C to directly manipulate internal layouts of Ironwall class / closure / union values
- Passing raw pointers, integerized addresses, or unmarked ownership across FFI
- Treating C global state as shared mutable state outside the Ironwall type system
- Depending on undocumented runtime struct layouts
- Using FFI to bypass semantic rules around `unit`, array bounds, GC roots, or module identity

If a feature can be written in Ironwall, it should be written in Ironwall first. FFI should serve only as a narrow bridge across an unsafe external world.
