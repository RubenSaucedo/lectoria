import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';

/**
 * Shared Azure auth surface for both Azure OpenAI (script generation) and
 * Azure Speech (TTS).
 *
 * Three modes, ordered from most explicit to most magical:
 *
 *  1. `credential`  Caller supplies their own `TokenCredential` (the
 *                   official @azure/identity interface). This is the
 *                   recommended path for library consumers — pick any
 *                   credential variant: AzureCliCredential,
 *                   ManagedIdentityCredential, WorkloadIdentityCredential,
 *                   InteractiveBrowserCredential, etc.
 *
 *  2. `apiKey`      Caller supplies a static API key. Useful for hosts
 *                   that don't speak Entra ID, and for quick scripts.
 *                   Azure OpenAI accepts keys directly; Azure Speech
 *                   accepts them via SpeechConfig.fromSubscription.
 *
 *  3. `default`     Fall back to DefaultAzureCredential, which walks a
 *                   chain (env vars, Managed Identity, Azure CLI, VS
 *                   Code, etc.). This is what the CLI uses so `az login`
 *                   "just works" locally.
 *
 * Required Azure RBAC roles when using credential / default modes:
 *   - Azure Speech: "Cognitive Services User" (or "Speech User")
 *   - Azure OpenAI: "Cognitive Services OpenAI User"
 */
export type LectoriaAuth =
  | { kind: 'credential'; credential: TokenCredential }
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'default' };

export const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

let cachedDefault: TokenCredential | undefined;

/**
 * Returns the credential to use for token-based auth. Used internally by
 * adapters; callers should normally supply a credential via
 * `LectoriaAuth.credential` instead of calling this directly.
 */
export function resolveCredential(auth: LectoriaAuth): TokenCredential {
  if (auth.kind === 'credential') return auth.credential;
  if (auth.kind === 'apiKey') {
    throw new Error(
      'resolveCredential called for apiKey auth; adapters must branch on auth.kind first.'
    );
  }
  if (!cachedDefault) cachedDefault = new DefaultAzureCredential();
  return cachedDefault;
}

/**
 * Back-compat shim. Prefer passing an explicit `LectoriaAuth` into adapters.
 */
export function getAzureCredential(): TokenCredential {
  return resolveCredential({ kind: 'default' });
}
