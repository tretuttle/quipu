/** Byte constants and the class table shared by every pass. */
export const QUOTE = 0x22;
export const BACKSLASH = 0x5c;
export const OBJ_OPEN = 0x7b;
export const OBJ_CLOSE = 0x7d;
export const ARR_OPEN = 0x5b;
export const ARR_CLOSE = 0x5d;
export const COLON = 0x3a;
export const COMMA = 0x2c;

export const CLASS_OTHER = 0;
export const CLASS_WS = 1;
export const CLASS_QUOTE = 2;
export const CLASS_BACKSLASH = 3;
export const CLASS_OPEN = 4;
export const CLASS_CLOSE = 5;
export const CLASS_COLON = 6;
export const CLASS_COMMA = 7;
/** A byte that can start a number or literal. */
export const CLASS_SCALAR_START = 8;

export const BYTE_CLASS = new Uint8Array(256);
BYTE_CLASS[0x20] = CLASS_WS;
BYTE_CLASS[0x09] = CLASS_WS;
BYTE_CLASS[0x0a] = CLASS_WS;
BYTE_CLASS[0x0d] = CLASS_WS;
BYTE_CLASS[QUOTE] = CLASS_QUOTE;
BYTE_CLASS[BACKSLASH] = CLASS_BACKSLASH;
BYTE_CLASS[OBJ_OPEN] = CLASS_OPEN;
BYTE_CLASS[ARR_OPEN] = CLASS_OPEN;
BYTE_CLASS[OBJ_CLOSE] = CLASS_CLOSE;
BYTE_CLASS[ARR_CLOSE] = CLASS_CLOSE;
BYTE_CLASS[COLON] = CLASS_COLON;
BYTE_CLASS[COMMA] = CLASS_COMMA;
for (let b = 0x30; b <= 0x39; b++) BYTE_CLASS[b] = CLASS_SCALAR_START;
BYTE_CLASS[0x2d] = CLASS_SCALAR_START; // -
BYTE_CLASS[0x74] = CLASS_SCALAR_START; // t
BYTE_CLASS[0x66] = CLASS_SCALAR_START; // f
BYTE_CLASS[0x6e] = CLASS_SCALAR_START; // n

/** Bytes that continue a number or literal once started. */
export const SCALAR_CHAR = new Uint8Array(256);
for (let b = 0x30; b <= 0x39; b++) SCALAR_CHAR[b] = 1;
for (let b = 0x61; b <= 0x7a; b++) SCALAR_CHAR[b] = 1;
SCALAR_CHAR[0x45] = 1; // E
SCALAR_CHAR[0x2b] = 1; // +
SCALAR_CHAR[0x2d] = 1; // -
SCALAR_CHAR[0x2e] = 1; // .
