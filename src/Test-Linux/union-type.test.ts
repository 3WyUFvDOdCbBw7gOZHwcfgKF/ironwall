import { notStrictEqual, strictEqual, throws } from "assert";
import {
    PrimitiveTypeValue,
    UnionTypeValue,
    getRuntimeTypeId,
    getUnionTypeId,
    printTypeValue,
    typeEqual
} from "../Typecheck-Core";

const i5 = new PrimitiveTypeValue("i5");
const f5 = new PrimitiveTypeValue("f5");

const i5OrF5 = new UnionTypeValue([i5, f5]);
const f5OrI5 = new UnionTypeValue([f5, i5]);
const nestedMember = new UnionTypeValue([f5, i5]);
const i5OrNestedUnion = new UnionTypeValue([i5, nestedMember]);

strictEqual(typeEqual(i5OrF5, f5OrI5), true, "union member order should not affect type equality");
strictEqual(getUnionTypeId(i5OrF5), getUnionTypeId(f5OrI5), "order-equivalent unions should share a runtime union tag");

throws(
    () => new UnionTypeValue([i5, f5, i5]),
    /Duplicate union member type: i5/,
    "duplicate immediate union members should be rejected instead of deduplicated"
);

strictEqual(i5OrNestedUnion.types.length, 2, "nested union should remain an immediate member");
strictEqual(
    i5OrNestedUnion.types.some((member) => member instanceof UnionTypeValue),
    true,
    "nested union should not be flattened during canonicalization"
);
strictEqual(
    typeEqual(i5OrF5, i5OrNestedUnion),
    false,
    "flat union and union containing a nested union member should be distinct types"
);
notStrictEqual(
    getUnionTypeId(i5OrF5),
    getUnionTypeId(i5OrNestedUnion),
    "flat union and nested union structure should not share a runtime union tag"
);
notStrictEqual(
    getRuntimeTypeId(i5).slice(1),
    getUnionTypeId(i5OrF5).slice(1),
    "runtime numeric tag suffixes should remain namespaced across primitive and union kinds"
);

strictEqual(
    getRuntimeTypeId(nestedMember),
    getUnionTypeId(nestedMember),
    "a nested union member should carry its own union runtime type tag"
);
notStrictEqual(
    getRuntimeTypeId(nestedMember),
    getUnionTypeId(i5OrNestedUnion),
    "nested member tag must not collide with its containing union tag"
);

strictEqual(printTypeValue(i5OrF5), "<union f5 i5>");
strictEqual(printTypeValue(i5OrNestedUnion), "<union i5 <union f5 i5>>");

process.stdout.write("union type canonicalization ok\n");
