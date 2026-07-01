import type { TranslationEngine } from './translate'

// Default engine: calls an OpenAI-compatible chat-completions endpoint and asks
// for a strict JSON map of English -> Simplified Chinese. Configurable so it can
// be swapped for any provider without touching call sites.
export function createDefaultEngine(): TranslationEngine {
  const endpoint = process.env.I18N_TRANSLATE_ENDPOINT
  const apiKey = process.env.I18N_TRANSLATE_API_KEY
  const model = process.env.I18N_TRANSLATE_MODEL ?? 'gpt-4o-mini'
  const batchSize = Number(process.env.I18N_TRANSLATE_BATCH ?? '50')

  if (!endpoint || !apiKey) {
    throw new Error(
      'Set I18N_TRANSLATE_ENDPOINT and I18N_TRANSLATE_API_KEY (and optionally I18N_TRANSLATE_MODEL) to run machine translation.'
    )
  }

  async function translateBatch(keys: string[]): Promise<Record<string, string>> {
    const prompt =
      'Translate each English UI string to Simplified Chinese (zh-CN). ' +
      'Preserve {{placeholders}} verbatim. Return ONLY a JSON object mapping ' +
      'each original English string to its translation.\n\n' +
      JSON.stringify(keys)
    const res = await fetch(endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    })
    if (!res.ok) throw new Error(`Translate API ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? '{}'
    return JSON.parse(content) as Record<string, string>
  }

  return {
    async translate(keys: string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {}
      for (let i = 0; i < keys.length; i += batchSize) {
        Object.assign(out, await translateBatch(keys.slice(i, i + batchSize)))
      }
      return out
    },
  }
}
