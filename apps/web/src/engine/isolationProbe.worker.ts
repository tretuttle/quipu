// Reports whether a dedicated worker served by this host is cross-origin
// isolated, which is what the engine's SharedArrayBuffers need. The isolation
// tests load it by URL on the dev server and on preview.
const report = {
  crossOriginIsolated: self.crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer === "function",
};
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worker's second argument is a transfer list, not a target origin.
self.postMessage(report);
