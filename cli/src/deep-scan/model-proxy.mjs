// The scan phase's only route out (#370): the model proxy's core
// (../model-proxy/core.mjs), which runs in the launcher, on the host, outside
// the sandbox, with the `anthropic` provider profile (ADR 0023). The core's
// header says what is forwarded and how the run's token cap (#371) holds; the
// profile's says what of the Messages API passes, and how the real credential
// goes in. Node core only (ADR 0001).

import { startProxy } from "../model-proxy/core.mjs";
import { anthropic } from "../model-proxy/profiles/anthropic.mjs";

export { MAX_IN_FLIGHT, MODEL_ID } from "../model-proxy/core.mjs";
export {
  COUNTED_USAGE,
  FORWARDED,
  MAX_REQUEST,
  MODEL_API,
  requestRefusal,
} from "../model-proxy/profiles/anthropic.mjs";

/**
 * Start the Deep scan's model proxy on `bind`. See startProxy in the core for
 * every option and for what it returns.
 * @param {{ credential: string, kind?: "api-key" | "subscription", bind: string, upstream?: string, maxTokens?: number, onCap?: () => void, callerKey?: string }} opts
 *   `kind` is the credential's (default an API key). `upstream` is the
 *   model API; only tests pass another. `callerKey`, when given, is the
 *   only value accepted as the caller's `x-api-key` or `Authorization`
 *   bearer value; the launcher always gives one.
 */
export async function startModelProxy({
  credential,
  kind = "api-key",
  bind,
  upstream,
  maxTokens,
  onCap,
  callerKey,
}) {
  return startProxy(anthropic, {
    credential,
    kind,
    bind,
    upstream,
    maxTokens,
    onCap,
    callerKey,
    name: "deep-scan model proxy",
  });
}
