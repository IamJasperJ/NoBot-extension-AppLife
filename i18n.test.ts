import { expect, test } from 'bun:test'
import en from './en'
import { setLanguageSource, t } from './i18n'

test('全部中文文案都有英文，语言源和变量替换', async () => {
  const glob = new Bun.Glob('**/*.ts')
  for await (const name of glob.scan(import.meta.dir)) {
    if (name.endsWith('.test.ts') || name === 'en.ts') continue
    const text = await Bun.file(`${import.meta.dir}/${name}`).text()
    for (const match of text.matchAll(/\bt\('([^']+)'/g))
      expect(en[(match[1] ?? '').replace(/\\n/g, '\n')]).toBeString()
  }
  try {
    setLanguageSource(() => 'en')
    expect(t('哔哩哔哩')).toBe('Bilibili')
    expect(t('登录凭据 {field} 不能为空或包含分号、换行', { field: 'SESSDATA' })).toContain('credential SESSDATA')
  } finally {
    setLanguageSource(() => 'zh')
  }
  expect(t('哔哩哔哩')).toBe('哔哩哔哩')
})
test('设置 schema 的工厂标签和风控提示也有英文，读取时跟随语言', async () => {
  const { settingsSchema } = await import('./settings')
  setLanguageSource(() => 'zh')
  const zh = settingsSchema()
  try {
    setLanguageSource(() => 'en')
    const english = settingsSchema()
    const check = (a: typeof zh, b: typeof zh) => {
      for (let i = 0; i < a.length; i++) {
        expect(en[a[i]!.label]).toBeString()
        expect(b[i]!.label).toBe(en[a[i]!.label]!)
        const field = a[i]!,
          translated = b[i]!
        if (field.hint) {
          expect(en[field.hint]).toBeString()
          expect(translated.hint).toBe(en[field.hint]!)
        }
        if (field.type === 'list' && translated.type === 'list') check(field.itemFields, translated.itemFields)
      }
    }
    check(zh, english)
    expect(english.some((f) => f.key === 'app')).toBe(false)
    expect(english.find((f) => f.key === 'douyinEnabled')?.hint).toContain('190 MB')
    expect(english.find((f) => f.key === 'riskHeading')?.hint).toContain('new account')
  } finally {
    setLanguageSource(() => 'zh')
  }
})
