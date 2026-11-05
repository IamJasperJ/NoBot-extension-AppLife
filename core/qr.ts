import { t } from '../i18n'

// 按 ISO/IEC 18004 的字节模式、M 级纠错实现；多项式在 GF(256)/0x11d 中运算。
const ecc = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24]
const blocks = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10]
export function multiply(a: number, b: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((b >>> i) & 1) * a
  }
  return z
}
export function reedSolomon(data: number[], degree: number): number[] {
  let gen = [1]
  for (let i = 0, x = 1; i < degree; i++, x = multiply(x, 2)) {
    const next = Array(gen.length + 1).fill(0) as number[]
    gen.forEach((c, j) => {
      next[j] = next[j]! ^ c
      next[j + 1] = next[j + 1]! ^ multiply(c, x)
    })
    gen = next
  }
  const rem = Array(degree).fill(0) as number[]
  for (const b of data) {
    const factor = b ^ rem.shift()!
    rem.push(0)
    for (let j = 0; j < degree; j++) rem[j] = rem[j]! ^ multiply(gen[j + 1]!, factor)
  }
  return rem
}
export function formatBits(mask: number, level = 0): number {
  const data = (level << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}
function rawModules(v: number) {
  let n = (16 * v + 128) * v + 64
  if (v >= 2) {
    const a = Math.floor(v / 7) + 2
    n -= (25 * a - 10) * a - 55
    if (v >= 7) n -= 36
  }
  return n
}
function capacity(v: number) {
  return Math.floor(rawModules(v) / 8) - ecc[v]! * blocks[v]!
}
function alignment(v: number): number[] {
  if (v === 1) return []
  const count = Math.floor(v / 7) + 2,
    step = Math.floor((v * 4 + count * 2 + 1) / (count * 2 - 2)) * 2,
    result = [6]
  for (let pos = v * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}
const masks = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number, _y: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]
export function penalty(m: boolean[][]): number {
  const n = m.length
  let score = 0,
    dark = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++
      if (x && y && m[y]![x] === m[y - 1]![x] && m[y]![x] === m[y]![x - 1] && m[y]![x] === m[y - 1]![x - 1]) score += 3
    }
  for (let axis = 0; axis < 2; axis++)
    for (let a = 0; a < n; a++) {
      const line = Array.from({ length: n }, (_, b) => (axis ? m[b]![a]! : m[a]![b]!))
      let run = 1
      for (let i = 1; i < n; i++) {
        if (line[i] === line[i - 1]) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score++
        } else run = 1
      }
      const str = line.map((v) => (v ? '1' : '0')).join('')
      for (let i = 0; i <= n - 11; i++) if (['00001011101', '10111010000'].includes(str.slice(i, i + 11))) score += 40
    }
  return score + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10
}
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  while (v <= 15 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > capacity(v) * 8) v++
  if (v > 15) throw new Error(t('二维码内容超过版本十五的容量'))
  const bits: number[] = []
  const append = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(4, 4)
  append(bytes.length, v < 10 ? 8 : 16)
  bytes.forEach((b) => {
    append(b, 8)
  })
  append(0, Math.min(4, capacity(v) * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
  for (let pad = 0; data.length < capacity(v); pad++) data.push(pad % 2 ? 0x11 : 0xec)
  const total = Math.floor(rawModules(v) / 8),
    num = blocks[v]!,
    degree = ecc[v]!,
    short = Math.floor(total / num),
    shortCount = num - (total % num),
    chunks: number[][] = [],
    checks: number[][] = []
  let at = 0
  for (let b = 0; b < num; b++) {
    const len = short - degree + (b < shortCount ? 0 : 1),
      chunk = data.slice(at, at + len)
    at += len
    chunks.push(chunk)
    checks.push(reedSolomon(chunk, degree))
  }
  const code: number[] = []
  for (let i = 0; i <= short - degree; i++) for (const c of chunks) if (i < c.length) code.push(c[i]!)
  for (let i = 0; i < degree; i++) for (const c of checks) code.push(c[i]!)
  const n = v * 4 + 17,
    base = Array.from({ length: n }, () => Array<boolean>(n).fill(false)),
    fixed = base.map((row) => row.slice())
  const set = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && y >= 0 && x < n && y < n) {
      base[y]![x] = dark
      fixed[y]![x] = true
    }
  }
  for (let i = 0; i < n; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx! + dx, cy! + dy, dist !== 2 && dist !== 4)
      }
  const align = alignment(v)
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  function format(mask: number) {
    const f = formatBits(mask)
    const bit = (i: number) => !!((f >>> i) & 1)
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i))
    set(8, n - 8, true)
  }
  format(0)
  if (v >= 7) {
    const b = versionBits(v)
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3),
        c = Math.floor(i / 3)
      set(a, c, !!((b >>> i) & 1))
      set(c, a, !!((b >>> i) & 1))
    }
  }
  let index = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++) {
      const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (!fixed[y]![x]) {
          base[y]![x] = index < code.length * 8 && !!((code[index >>> 3]! >>> (7 - (index & 7))) & 1)
          index++
        }
      }
    }
  }
  const unmasked = base.map((row) => row.slice())
  let best = base.map((row) => row.slice()),
    bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) base[y]![x] = unmasked[y]![x]! !== (!fixed[y]![x] && masks[mask]!(x, y))
    format(mask)
    const score = penalty(base)
    if (score < bestScore) {
      bestScore = score
      best = base.map((row) => row.slice())
    }
  }
  return best
}
export function qrSvg(text: string, { margin = 4 }: { margin?: number } = {}): string {
  const m = qrMatrix(text),
    pad = Math.max(0, Math.floor(margin)),
    n = m.length + pad * 2
  let path = ''
  m.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + pad},${y + pad}h1v1h-1z`
    })
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`
}
