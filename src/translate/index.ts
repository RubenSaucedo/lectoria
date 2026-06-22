import type { Glossary, LanguageCode, PodcastScript, ProgressListener, ScriptModel } from '../types.js';

/**
 * Thin wrapper around a ScriptModel that turns a single source-language script
 * into one script per target language. If the source language is in the target
 * list, the original is reused without re-running the model.
 *
 * Emits translate:start / translate:complete events per target language; the
 * model itself emits translate:segment events when chunking.
 */
export async function translateToAll(
  model: ScriptModel,
  source: PodcastScript,
  targetLanguages: LanguageCode[],
  opts: { signal?: AbortSignal; onProgress?: ProgressListener; glossary?: Glossary } = {}
): Promise<PodcastScript[]> {
  const out: PodcastScript[] = [];
  for (const lang of targetLanguages) {
    opts.signal?.throwIfAborted();
    if (lang === source.language) {
      out.push(source);
      continue;
    }
    opts.onProgress?.({
      phase: 'translate:start',
      scriptId: source.id,
      language: lang,
      segments: source.segments.length,
      chunked: source.segments.length > 1,
    });
    const translated = await model.translateScript(source, lang, {
      signal: opts.signal,
      glossary: opts.glossary,
    });
    opts.onProgress?.({
      phase: 'translate:complete',
      scriptId: translated.id,
      language: lang,
    });
    out.push(translated);
  }
  return out;
}
