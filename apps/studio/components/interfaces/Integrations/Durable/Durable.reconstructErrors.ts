import { t as $t } from '@/lib/i18n'

type Translator = (match: RegExpMatchArray) => string

const POSITIONS: Record<string, () => string> = {
  left: () => $t('left'),
  right: () => $t('right'),
  then: () => $t('then branch'),
  else: () => $t('else branch'),
  body: () => $t('body'),
}

// Each entry mirrors a message thrown by `reconstructExpression` (Durable.reconstruct.ts), which
// stays free of i18n. Keep the patterns in sync with that file.
const PATTERNS: Array<[RegExp, Translator]> = [
  [/^Step (.+) is missing$/, (m) => $t('Step {{id}} is missing', { id: m[1] })],
  [
    /^Step (.+) is missing its (left|right|then|else|body) step$/,
    (m) =>
      $t('Step {{id}} is missing its {{position}} step', { id: m[1], position: POSITIONS[m[2]]() }),
  ],
  [/^The workflow graph contains a cycle$/, () => $t('The workflow graph contains a cycle')],
  [/^The workflow has no steps$/, () => $t('The workflow has no steps')],
  [
    /^Step (.+) has an invalid configuration$/,
    (m) => $t('Step {{id}} has an invalid configuration', { id: m[1] }),
  ],
  [/^Step (.+) has no SQL$/, (m) => $t('Step {{id}} has no SQL', { id: m[1] })],
  [
    /^Step (.+) has an invalid sleep duration$/,
    (m) => $t('Step {{id}} has an invalid sleep duration', { id: m[1] }),
  ],
  [/^Step (.+) has no signal name$/, (m) => $t('Step {{id}} has no signal name', { id: m[1] })],
  [
    /^Step (.+) has an invalid signal timeout$/,
    (m) => $t('Step {{id}} has an invalid signal timeout', { id: m[1] }),
  ],
  [
    /^Step (.+) has no cron expression$/,
    (m) => $t('Step {{id}} has no cron expression', { id: m[1] }),
  ],
  [
    /^Step (.+) has an invalid HTTP configuration$/,
    (m) => $t('Step {{id}} has an invalid HTTP configuration', { id: m[1] }),
  ],
  [
    /^Step (.+) has invalid HTTP headers$/,
    (m) => $t('Step {{id}} has invalid HTTP headers', { id: m[1] }),
  ],
  [
    /^Step (.+) has an invalid HTTP timeout$/,
    (m) => $t('Step {{id}} has an invalid HTTP timeout', { id: m[1] }),
  ],
  [
    /^Step (.+) has an invalid HTTP body$/,
    (m) => $t('Step {{id}} has an invalid HTTP body', { id: m[1] }),
  ],
  [
    /^Step (.+) has no multipart parts$/,
    (m) => $t('Step {{id}} has no multipart parts', { id: m[1] }),
  ],
  [
    /^Step (.+) has an invalid break value$/,
    (m) => $t('Step {{id}} has an invalid break value', { id: m[1] }),
  ],
  [
    /^Step (.+) has an invalid list of parallel branches$/,
    (m) => $t('Step {{id}} has an invalid list of parallel branches', { id: m[1] }),
  ],
  [
    /^Step (.+) does not name the result it checks$/,
    (m) => $t('Step {{id}} does not name the result it checks', { id: m[1] }),
  ],
  [/^Step (.+) has no condition$/, (m) => $t('Step {{id}} has no condition', { id: m[1] })],
  [
    /^Step (.+) has an invalid condition$/,
    (m) => $t('Step {{id}} has an invalid condition', { id: m[1] }),
  ],
  [/^Unsupported step type (.+)$/, (m) => $t('Unsupported step type {{type}}', { type: m[1] })],
]

/** Translates a reason returned by `reconstructExpression`, falling back to the raw reason. */
export const translateReconstructError = (reason: string): string => {
  for (const [pattern, translate] of PATTERNS) {
    const match = reason.match(pattern)
    if (match) return translate(match)
  }
  return reason
}
