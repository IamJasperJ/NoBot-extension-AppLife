import en from './en'

let language: () => 'zh' | 'en' = () => 'zh'
export function setLanguageSource(source: () => 'zh' | 'en'): void {
  language = source
}
export function t(zh: string, vars: Record<string, string | number> = {}): string {
  const text = language() === 'en' ? (en[zh] ?? zh) : zh
  return text.replace(/\{(\w+)\}/g, (match, key: string) => String(vars[key] ?? match))
}

export const getLanguage = () => language()
