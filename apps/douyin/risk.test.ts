import { expect, test } from 'bun:test'
import { captchaScript, douyinRiskPolicy, isCaptchaElement, UI_CODES } from './risk'

const visible = {
  src: 'https://rmc.bytedance.com/verifycenter/captcha/v2?from=iframe&fp=verify_test',
  width: 380,
  height: 554,
  display: 'block',
  visibility: 'visible',
}

test('验证码判定只接受可见且尺寸足够的验证 iframe 或容器', () => {
  expect(isCaptchaElement(visible)).toBe(true)
  expect(isCaptchaElement({ ...visible, src: undefined, container: true })).toBe(true)
  for (const element of [
    { ...visible, src: 'https://rmc.bytedance.com/rmc-nocaptcha', width: 0, height: 0, display: 'none' },
    { ...visible, width: 50 },
    { ...visible, height: 50 },
    { ...visible, display: 'none' },
    { ...visible, visibility: 'hidden' },
    { ...visible, src: 'https://example.com/verifycenter/captcha/v2' },
    { ...visible, src: 'https://rmc.bytedance.com.evil.test/verifycenter/captcha/v2' },
    { ...visible, src: 'https://rmc.bytedance.com/rmc-nocaptcha' },
    { ...visible, src: 'invalid' },
    { ...visible, src: undefined },
  ])
    expect(isCaptchaElement(element)).toBe(false)
})

test('序列化 DOM 脚本使用同一判定，跳过首个隐藏 iframe 后仍能找到可见验证码', () => {
  const element = (value: typeof visible) => ({
    tagName: 'IFRAME',
    src: value.src,
    getBoundingClientRect: () => value,
    style: value,
  })
  const hidden = element({ ...visible, width: 0, height: 0, display: 'none' })
  const shown = element(visible)
  const run = new Function(
    'document',
    'getComputedStyle',
    `return (${captchaScript.toString()})(${isCaptchaElement.toString()})`,
  )
  const style = (el: { style: unknown }) => el.style
  expect(run({ querySelectorAll: () => [hidden, shown] }, style)).toBe(true)
  expect(run({ querySelectorAll: () => [hidden] }, style)).toBe(false)
})

test('发送后遇到验证码同时保留人工暂停与结果不确定', () => {
  expect(douyinRiskPolicy.judge(new Response(), { status_code: UI_CODES.VERIFY, uncertain: true }, true)).toMatchObject(
    { manual: true, ok: false, code: null },
  )
})
