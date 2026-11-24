/**
 * A JSON Pointer (RFC 6901) as the path the query bar takes: `/a/b c/0` is
 * `$.a["b c"][0]`. A segment of digits reads as an index; a pointer does not say
 * whether its parent was an array, and in a refusal message the index is the
 * likelier reading.
 */
export function pointerToPath(pointer: string): string {
  if (pointer === "") return "$";
  let path = "$";
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (/^(0|[1-9][0-9]*)$/.test(segment)) path += `[${segment}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}
