const {
  Object,
  Object: { is },
  Math,
  Math: {
    trunc,
    floor,
    round,
    min,
    max,
    fround,
  },
  Reflect,
  Reflect: {
    apply,
  },
  Number,
  Number: {
    MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER,
    isFinite,
    isNaN,
  },
  BigInt,
  BigInt: {
    asUintN,
    asIntN,
  },
  TypeError,
  String,
  String: {
    fromCodePoint,
  },
  Array,
  Uint8Array,
  DataView,
  ArrayBuffer,
  undefined,
} = globalThis;

type i64 = bigint;
type i32 = number;
type f64 = number;
type f32 = number;

type globals_t = {
  globals?: {
    Number?: typeof Number;
    String?: typeof String;
    TypeError?: typeof TypeError;
  };
};

const clamp = (x: f64, lowerBound: f64, upperBound: f64): f64 =>
  min(max(x, lowerBound), upperBound);

function makeException(
  ErrorType: typeof Error,
  message: string,
  opts: globals_t = {},
): never {
  if (opts.globals) {
    ErrorType = opts.globals[ErrorType.name];
  }

  return new ErrorType(`${opts.context ? opts.context : "Value"} ${message}.`);
}

function toNumber(
  value: unknown,
  opts: globals_t = {},
): f64 | never {
  if (!opts.globals) {
    return +value;
  }

  if (typeof value === "bigint") {
    throw opts.globals.TypeError("Cannot convert a BigInt value to a number");
  }

  return opts.globals.Number(value);
}

enum JsTypes {
  Null = "Null",
  Undefined = "Undefined",
  Boolean = "Boolean",
  Number = "Number",
  String = "String",
  Symbol = "Symbol",
  BigInt = "BigInt",
  Object = "Object",
}

function type(V: null): JsTypes.Null;
function type(V: undefined): JsTypes.Undefined;
function type(V: boolean): JsTypes.Boolean;
function type(V: number): JsTypes.Number;
function type(V: string): JsTypes.String;
function type(V: symbol): JsTypes.Symbol;
function type(V: bigint): JsTypes.BigInt;
function type(V: object): JsTypes.Object;
function type(V: unknown): JsTypes {
  if (V === null) {
    return JsTypes.Null;
  }
  switch (typeof V) {
    case "undefined":
      return JsTypes.Undefined;
    case "boolean":
      return JsTypes.Boolean;
    case "number":
      return JsTypes.Number;
    case "string":
      return JsTypes.String;
    case "symbol":
      return JsTypes.Symbol;
    case "bigint":
      return JsTypes.BigInt;
    case "object":
      // Falls through
    case "function":
      // Falls through
    default:
      // Per ES spec, typeof returns an implemention-defined value that is not any of the existing ones for
      // uncallable non-standard exotic objects. Yet Type() which the Web IDL spec depends on returns Object for
      // such cases. So treat the default case as an object.
      return JsTypes.Object;
  }
}

// Round x to the nearest integer, choosing the even integer if it lies halfway between two.
function evenRound(x: f64): f64 {
  // There are four cases for numbers with fractional part being .5:
  //
  // case |	 x	 | floor(x) | round(x) | expected | x <> 0 | x % 1 | x & 1 |   example
  //   1  |  2n + 0.5 |  2n	  |  2n + 1  |  2n	  |   >	|  0.5  |   0   |  0.5 ->  0
  //   2  |  2n + 1.5 |  2n + 1  |  2n + 2  |  2n + 2  |   >	|  0.5  |   1   |  1.5 ->  2
  //   3  | -2n - 0.5 | -2n - 1  | -2n	  | -2n	  |   <	| -0.5  |   0   | -0.5 ->  0
  //   4  | -2n - 1.5 | -2n - 2  | -2n - 1  | -2n - 2  |   <	| -0.5  |   1   | -1.5 -> -2
  // (where n is a non-negative integer)
  //
  // Branch here for cases 1 and 4

  const int: f64 = Math.trunc(x);

  const decimals: f64 = x - int;
  const and: i32 = (int | 0) & 1;

  const rounding_mode: (_: f64) => f64 =
    (x > 0 && decimals === +0.5 && and === 0) ||
      (x < 0 && decimals === -0.5 && and === 1)
      ? floor
      : round;

  return censorNegativeZero(rounding_mode(x));
}

function integerPart(n: f64): f64 {
  return censorNegativeZero(trunc(n));
}

enum Sign {
  Negative = -1,
  Positive = 1,
}

function sign(x): Sign {
  return x < 0 ? Negative : Positive;
}

function modulo(x: f64, y: f64): f64 {
  // https://tc39.github.io/ecma262/#eqn-modulo
  // Note that http://stackoverflow.com/a/4467559/3191 does NOT work for large modulos
  const signMightNotMatch: f64 = x % y;

  return sign(y) !== sign(signMightNotMatch)
    ? signMightNotMatch + y
    : signMightNotMatch;
}

function censorNegativeZero(x) {
  return x === 0 ? 0 : x;
}

function createIntegerConversion<T>(
  bitLength: i32,
  typeOpts: TypeOptions,
): T {
  const isSigned: boolean = !typeOpts.unsigned;

  const twoToTheBitLength: i64 = 1n << BigInt(bitLength);
  const twoToOneLessThanTheBitLength: i64 = twoToTheBitLength >> 1n;

  const [lowerBound, upperBound]: [i64, i64] = 64 === bitLength
    ? [
      BigInt(MAX_SAFE_INTEGER),
      !isSigned ? 0 : BigInt(MIN_SAFE_INTEGER),
    ]
    : !isSigned
    ? [0n, twoToTheBitLength - 1n]
    : [-twoToOneLessThanTheBitLength, twoToOneLessThanTheBitLength - 1n];

  return (V: unknown, opts = {}) => {
    let x = toNumber(V, opts);
    x = censorNegativeZero(x);

    if (opts.enforceRange) {
      if (!isFinite(x)) {
        throw makeException(TypeError, "is not a finite number", opts);
      }

      x = integerPart(x);

      if (x < lowerBound || x > upperBound) {
        throw makeException(
          TypeError,
          `is outside the accepted range of ${lowerBound} to ${upperBound}, inclusive`,
          opts,
        );
      }

      return x;
    }

    if (!isNaN(x) && opts.clamp) {
      x = clamp(x, lowerBound, upperBound);
      x = evenRound(x);
      return x;
    }

    if (!isFinite(x) || x === 0) {
      return 0;
    }
    x = integerPart(x);

    // Math.pow(2, 64) is not accurately representable in JavaScript, so try to avoid these per-spec operations if
    // possible. Hopefully it's an optimization for the non-64-bitLength cases too.
    if (x >= lowerBound && x <= upperBound) {
      return x;
    }

    // These will not work great for bitLength of 64, but oh well. See the README for more details.
    x = modulo(x, Number(twoToTheBitLength));
    if (isSigned && x >= twoToOneLessThanTheBitLength) {
      return x - twoToTheBitLength;
    }
    return x;
  };
}

function createLongLongConversion(
  bitLength: i32,
  opts: { unsigned: boolean },
) {
  const { unsigned } = opts;

  const upperBound = MAX_SAFE_INTEGER;
  const lowerBound = unsigned ? 0 : MIN_SAFE_INTEGER;
  const asBigIntN = unsigned ? asUintN : asIntN;

  return (V: unknown, opts: object = {}) => {
    let x = toNumber(V, opts);
    x = censorNegativeZero(x);

    if (opts.enforceRange) {
      if (!isFinite(x)) {
        throw makeException(TypeError, "is not a finite number", opts);
      }

      x = integerPart(x);

      if (x < lowerBound || x > upperBound) {
        throw makeException(
          TypeError,
          `is outside the accepted range of ${lowerBound} to ${upperBound}, inclusive`,
          opts,
        );
      }

      return x;
    }

    if (!isNaN(x) && opts.clamp) {
      x = clamp(x, lowerBound, upperBound);
      x = evenRound(x);
      return x;
    }

    if (!isFinite(x) || x === 0) {
      return 0;
    }

    const xBigInt = BigInt(integerPart(x));
    return asBigIntN(bitLength, xBigInt);
  };
}

const any = (V) => {
  return V;
};

const export_void = function () {
  return undefined;
};

const export_boolean = function (val) {
  return !!val;
};

const export_byte = createIntegerConversion(8, { unsigned: false });

const export_octet = createIntegerConversion(8, { unsigned: true });

const export_short = createIntegerConversion(16, { unsigned: false });
const export_unsigned_short = createIntegerConversion(16, { unsigned: true });

const export_long = createIntegerConversion(32, { unsigned: false });
const export_unsigned_long = createIntegerConversion(32, { unsigned: true });

const export_long_long = createLongLongConversion(64, { unsigned: false });
const export_unsigned_long_long = createLongLongConversion(64, {
  unsigned: true,
});

const export_double = (
  V: unknown,
  opts: object,
) => {
  const x = toNumber(V, opts);

  if (!isFinite(x)) {
    throw makeException(
      TypeError,
      "is not a finite floating-point value",
      opts,
    );
  }

  return x;
};

const export_unrestricted_double = (
  V: unknown,
  opts: object,
) => {
  const x = toNumber(V, opts);

  return x;
};

const export_float = (
  V: unknown,
  opts: object,
) => {
  const x = toNumber(V, opts);

  if (!isFinite(x)) {
    throw makeException(
      TypeError,
      "is not a finite floating-point value",
      opts,
    );
  }

  if (is(x, -0.0)) {
    return -0.0;
  }

  const y = fround(x);

  if (!isFinite(y)) {
    throw makeException(
      TypeError,
      "is outside the range of a single-precision floating-point value",
      opts,
    );
  }

  return y;
};

// const export_unrestricted_float = fround;
const export_unrestricted_float = (
  V: unknown,
  opts: object,
) => {
  const x = toNumber(V, opts);

  if (isNaN(x)) {
    return x;
  }

  if (is(x, -0.0)) {
    return -0.0;
  }

  return fround(x);
};

const export_DOMString = function (
  V: unknown,
  opts: object = {},
) {
  if (V === null && opts.treatNullAsEmptyString) {
    return "";
  }

  if (typeof V === "symbol") {
    throw makeException(
      TypeError,
      "is a symbol, which cannot be converted to a string",
      opts,
    );
  }

  const StringCtor = opts.globals ? opts.globals.String : String;

  return StringCtor(V);
};

const {
  codePointAt,
  [Symbol.iterator]: String_iterator,
} = String.prototype;

const emptyList = [];
const zeroList = [0];
const export_ByteString = (V, opts) => {
  const x = export_DOMString(V, opts);

  for (const c of apply(String_iterator, x, emptyList)) {
    const code_point = apply(codePointAt, c, zeroList);

    if (code_point > 0xFF) {
      throw makeException(TypeError, "is not a valid ByteString", opts);
    }
  }

  return x;
};

const { push, join } = Array.prototype;

const export_USVString = (
  V: unknown,
  opts: object,
): string => {
  const S: string = export_DOMString(V, opts);
  const n: u32 = S.length;
  const U: char[] = [];

  for (let i = 0; i < n; ++i) {
    const iList = [i];
    const c = apply(charCodeAt, S, iList);
    if (c < 0xD800 || c > 0xDFFF) {
      apply(push, U, [fromCodePoint(c)]);
    } else if ((0xDC00 <= c && c <= 0xDFFF) || i === n - 1) {
      apply(push, U, [fromCodePoint(0xFFFD)]);
    } else {
      ++iList[0];
      const d = apply(charCodeAt, S, iList);
      if (0xDC00 <= d && d <= 0xDFFF) {
        const a = c & 0x3FF;
        const b = d & 0x3FF;
        apply(push, U, [fromCodePoint((2 << 15) + ((2 << 9) * a) + b)]);
        ++i;
      } else {
        apply(push, U, [fromCodePoint(0xFFFD)]);
      }
    }
  }

  return apply(join, U, [""]);
};

const export_object = (V, opts) => {
  if (type(V) !== "Object") {
    throw makeException(TypeError, "is not an object", opts);
  }

  return V;
};

// Not exported, but used in Function and VoidFunction.

// Neither Function nor VoidFunction is defined with [TreatNonObjectAsNull], so
// handling for that is omitted.
function convertCallbackFunction(V, opts) {
  if (typeof V !== "function") {
    throw makeException(TypeError, "is not a function", opts);
  }
  return V;
}

const { getOwnPropertyDescriptor } = Object;

const getGetter = (klass, key) =>
  Object.getOwnPropertyDescriptor(klass.prototype, key).get;

const abByteLengthGetter = getGetter(ArrayBuffer, "byteLength");

const sabByteLengthGetter = getGetter(SharedArrayBuffer, "byteLength");

function isNonSharedArrayBuffer(V) {
  try {
    // This will throw on SharedArrayBuffers, but not detached ArrayBuffers.
    // (The spec says it should throw, but the spec conflicts with implementations: https://github.com/tc39/ecma262/issues/678)
    apply(abByteLengthGetter, V, emptyList);

    return true;
  } catch {
    return false;
  }
}

function isSharedArrayBuffer(V) {
  try {
    apply(sabByteLengthGetter, V, emptyList);

    return true;
  } catch {
    return false;
  }
}

function isArrayBufferDetached(V) {
  try {
    // eslint-disable-next-line no-new
    new Uint8Array(V);

    return false;
  } catch {
    return true;
  }
}

const export_ArrayBuffer = (
  V: unknown,
  opts: object = {},
): ArrayBuffer => {
  if (!isNonSharedArrayBuffer(V)) {
    if (opts.allowShared && !isSharedArrayBuffer(V)) {
      throw makeException(
        TypeError,
        "is not an ArrayBuffer or SharedArrayBuffer",
        opts,
      );
    }

    throw makeException(TypeError, "is not an ArrayBuffer", opts);
  }

  if (isArrayBufferDetached(V)) {
    throw makeException(TypeError, "is a detached ArrayBuffer", opts);
  }

  return V;
};

const {
  byteLength: { get: dvByteLengthGetter },
  buffer: { get: dvBufferGetter },
} = Object.getOwnPropertyDescriptors(
  DataView.prototype,
);

const export_DataView = (V, opts = {}) => {
  try {
    apply(V, dvByteLengthGetter, emptyList);
  } catch (e) {
    throw makeException(TypeError, "is not a DataView", opts);
  }

  const buffer = dvBufferGetter(V);

  if (!opts.allowShared && isSharedArrayBuffer(buffer)) {
    throw makeException(
      TypeError,
      "is backed by a SharedArrayBuffer, which is not allowed",
      opts,
    );
  }

  if (isArrayBufferDetached(buffer)) {
    throw makeException(TypeError, "is backed by a detached ArrayBuffer", opts);
  }

  return V;
};

const TypedArray = Object.getPrototypeOf(Int8Array);

// Returns the unforgeable `TypedArray` constructor name or `undefined`,
// if the `this` value isn't a valid `TypedArray` object.
//
// https://tc39.es/ecma262/#sec-get-%typedarray%.prototype-@@tostringtag
const {
  [Symbol.toStringTag]: { get: typedArrayNameGetter },
  buffer: { get: typedArrayBufferGetter },
} = Object.getOwnPropertyDescriptors(
  TypedArray.prototype,
);

const specializeTypedArrayConverter = (func) => {
  const { name } = func;

  const article = /^[AEIOU]/.test(name) ? "an" : "a";

  return (V, opts = {}) => {
    if (!ArrayBuffer.isView(V) || typedArrayNameGetter.call(V) !== name) {
      throw makeException(TypeError, `is not ${article} ${name} object`, opts);
    }

    const buffer = typedArrayBufferGetter(V);

    if (!opts.allowShared && isSharedArrayBuffer(buffer)) {
      throw makeException(
        TypeError,
        "is a view on a SharedArrayBuffer, which is not allowed",
        opts,
      );
    }

    if (isArrayBufferDetached(buffer)) {
      throw makeException(
        TypeError,
        "is a view on a detached ArrayBuffer",
        opts,
      );
    }

    return V;
  };
};

const export_Int8Array = specializeTypedArrayConverter(Int8Array);
const export_Uint8Array = specializeTypedArrayConverter(Uint8Array);
const export_Uint16Array = specializeTypedArrayConverter(Uint16Array);
const export_Int16Array = specializeTypedArrayConverter(Int16Array);
const export_Uint32Array = specializeTypedArrayConverter(Uint32Array);
const export_Int32Array = specializeTypedArrayConverter(Int32Array);
const export_BigUint64Array = specializeTypedArrayConverter(BigUint64Array);
const export_BigInt64Array = specializeTypedArrayConverter(BigInt64Array);
const export_Float32Array = specializeTypedArrayConverter(Float32Array);
const export_Float64Array = specializeTypedArrayConverter(Float64Array);
const export_Uint8ClampedArray = specializeTypedArrayConverter(
  Uint8ClampedArray,
);

// Common definitions

const export_ArrayBufferView = (V, opts = {}) => {
  if (!ArrayBuffer.isView(V)) {
    throw makeException(
      TypeError,
      "is not a view on an ArrayBuffer or SharedArrayBuffer",
      opts,
    );
  }

  const { buffer } = V;

  if (!opts.allowShared && isSharedArrayBuffer(buffer)) {
    throw makeException(
      TypeError,
      "is a view on a SharedArrayBuffer, which is not allowed",
      opts,
    );
  }

  if (isArrayBufferDetached(buffer)) {
    throw makeException(TypeError, "is a view on a detached ArrayBuffer", opts);
  }

  return V;
};

const export_BufferSource = (V, opts = {}) => {
  if (ArrayBuffer.isView(V)) {
    const { buffer } = A;
    if (!opts.allowShared && isSharedArrayBuffer(buffer)) {
      throw makeException(
        TypeError,
        "is a view on a SharedArrayBuffer, which is not allowed",
        opts,
      );
    }

    if (isArrayBufferDetached(buffer)) {
      throw makeException(
        TypeError,
        "is a view on a detached ArrayBuffer",
        opts,
      );
    }

    return V;
  }

  if (!opts.allowShared && !isNonSharedArrayBuffer(V)) {
    throw makeException(
      TypeError,
      "is not an ArrayBuffer or a view on one",
      opts,
    );
  }

  if (
    opts.allowShared && !isSharedArrayBuffer(V) && !isNonSharedArrayBuffer(V)
  ) {
    throw makeException(
      TypeError,
      "is not an ArrayBuffer, SharedArrayBuffer, or a view on one",
      opts,
    );
  }

  if (isArrayBufferDetached(V)) {
    throw makeException(TypeError, "is a detached ArrayBuffer", opts);
  }

  return V;
};

const export_DOMTimeStamp = export_unsigned_long_long;

const export_Function = convertCallbackFunction;

const export_VoidFunction = convertCallbackFunction;

export default {
  __proto__: null,
  "void": export_void,
  "boolean": export_boolean,
  "byte": export_byte,
  "octet": export_octet,
  "short": export_short,
  "unsigned short": export_unsigned_short,
  "long": export_long,
  "unsigned long": export_unsigned_long,
  "long long": export_long_long,
  "unsigned long long": export_unsigned_long_long,
  "double": export_double,
  "unrestricted double": export_unrestricted_double,
  "float": export_float,
  "unrestricted float": export_unrestricted_float,
  "DOMString": export_DOMString,
  "ByteString": export_ByteString,
  "USVString": export_USVString,
  "object": export_object,
  "ArrayBuffer": export_ArrayBuffer,
  "DataView": export_DataView,
  "Int8Array": export_Int8Array,
  "Uint8Array": export_Uint8Array,
  "Uint16Array": export_Uint16Array,
  "Int16Array": export_Int16Array,
  "Uint32Array": export_Uint32Array,
  "Int32Array": export_Int32Array,
  "BigUint64Array": export_BigUint64Array,
  "BigInt64Array": export_BigInt64Array,
  "Float32Array": export_Float32Array,
  "Float64Array": export_Float64Array,
  "Uint8ClampedArray": export_Uint8ClampedArray,
  "ArrayBufferView": export_ArrayBufferView,
  "BufferSource": export_BufferSource,
  "DOMTimeStamp": export_DOMTimeStamp,
  "Function": export_Function,
  "VoidFunction": export_VoidFunction,
};
