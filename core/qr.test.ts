import { expect, test } from 'bun:test'
import { formatBits, qrMatrix, qrSvg, reedSolomon, versionBits } from './qr'

test('Thonky 1-M HELLO WORLD Reed–Solomon 发布向量', () => {
  expect(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([
    196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
  ])
})
test('所有级别与 mask 的格式 BCH、v7 信息', () => {
  const vectors = [
    [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
    [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
    [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
    [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
  ]
  vectors.forEach((row, level) => {
    row.forEach((bits, mask) => {
      expect(formatBits(mask, level)).toBe(bits)
    })
  })
  expect(versionBits(7)).toBe(0x07c94)
})
test('定位、分隔、时序、对齐与稳定 URL 输出', () => {
  const url = `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${'0123456789abcdef'.repeat(5)}`,
    m = qrMatrix(url),
    n = m.length
  expect(qrMatrix(url)).toEqual(m)
  expect(n).toBeGreaterThan(21)
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ])
    for (let y = -3; y <= 3; y++)
      for (let x = -3; x <= 3; x++) expect(m[cy! + y]![cx! + x]).toBe(Math.max(Math.abs(x), Math.abs(y)) !== 2)
  for (let x = 8; x < n - 8; x++) expect(m[6]![x]).toBe(x % 2 === 0)
  for (let y = -2; y <= 2; y++)
    for (let x = -2; x <= 2; x++) expect(m[n - 7 + y]![n - 7 + x]).toBe(Math.max(Math.abs(x), Math.abs(y)) !== 1)
  const svg = qrSvg(url, { margin: 4 })
  expect(svg.match(/<path /g)?.length).toBe(1)
  expect(svg).toContain(`viewBox="0 0 ${n + 8} ${n + 8}"`)
  expect(svg).toContain('crispEdges')
  expect(qrMatrix('你好🌟')).toHaveLength(21)
  expect(() => qrMatrix('x'.repeat(10000))).toThrow()
})
test('v7 中间对齐图案固定在 22，版本信息两份', () => {
  const m = qrMatrix('x'.repeat(110))
  expect(m.length).toBe(45)
  for (const [cx, cy] of [
    [22, 22],
    [22, 6],
    [6, 22],
    [38, 22],
    [22, 38],
  ])
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++) expect(m[cy! + y]![cx! + x]).toBe(Math.max(Math.abs(x), Math.abs(y)) !== 1)
  for (let i = 0; i < 18; i++) {
    expect(m[Math.floor(i / 3)]![34 + (i % 3)]).toBe(!!((0x7c94 >>> i) & 1))
    expect(m[34 + (i % 3)]![Math.floor(i / 3)]).toBe(!!((0x7c94 >>> i) & 1))
  }
})
