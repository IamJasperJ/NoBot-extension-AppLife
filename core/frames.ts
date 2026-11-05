// 抽帧逻辑改编自 Alterssss/dsh-bili-whale（MIT），见 NOTICE.md。
import { t } from '../i18n'
import type { ContentDigest, Runtime } from './types'
export function ffmpegPath(): string | null {
  return process.env.FFMPEG || Bun.which('ffmpeg')
}
/** CDN 只认 UA 和 Referer；Cookie 一律不带给视频 / 图片 CDN。 */
export interface MediaHeaders {
  userAgent: string
  referer: string
}
function headerArgs(h: MediaHeaders) {
  return ['-headers', `User-Agent: ${h.userAgent}\r\nReferer: ${h.referer}\r\n`]
}
export async function frameGrid(
  runtime: Runtime,
  url: string,
  duration: number,
  tile = 720,
  signal?: AbortSignal,
  media: MediaHeaders = { userAgent: '', referer: '' },
): Promise<NonNullable<ContentDigest['frames']>> {
  const path = ffmpegPath()
  if (!path || !runtime.spawn) throw new Error(t('找不到 ffmpeg 或运行环境不支持抽帧'))
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(t('视频时长无效，无法抽帧'))
  const start = duration * 0.05,
    step = (duration * 0.9) / 8
  const timestampsSec = Array.from({ length: 9 }, (_, i) => start + i * step)
  const width = Number.isFinite(tile) && tile > 0 ? Math.floor(tile) : 720
  // 从 5% 起按固定间距采样，保留 95% 处的第九帧；不落盘。
  const cmd = [
    path,
    '-hide_banner',
    '-loglevel',
    'error',
    ...headerArgs(media),
    '-ss',
    String(start),
    '-i',
    url,
    '-vf',
    `fps=1/${step}:start_time=0:round=up,scale=${width}:-1,tile=3x3:nb_frames=9`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]
  const result = await runtime.spawn(cmd, { signal, timeoutMs: 120000 })
  if (result.code !== 0 || !result.stdout.length) throw new Error(t('ffmpeg 抽帧失败'))
  return { grid: result.stdout, mime: 'image/jpeg', timestampsSec }
}
/**
 * 图文作品没有视频：把最多 9 张图缩放补边成正方形后拼成一张网格（列数不超过 3）。
 * timestampsSec 对图文没有意义，按图片序号填。
 */
export async function imageGrid(
  runtime: Runtime,
  urls: string[],
  tile = 720,
  signal?: AbortSignal,
  media: MediaHeaders = { userAgent: '', referer: '' },
): Promise<NonNullable<ContentDigest['frames']>> {
  const path = ffmpegPath()
  if (!path || !runtime.spawn) throw new Error(t('找不到 ffmpeg 或运行环境不支持抽帧'))
  const list = urls.slice(0, 9)
  if (!list.length) throw new Error(t('作品没有可用图片'))
  // 单格边长按列数缩小，整张网格的宽度保持在 tile 左右
  const cols = Math.min(3, list.length),
    rows = Math.ceil(list.length / cols),
    cell = Math.max(160, Math.floor((Number.isFinite(tile) && tile > 0 ? tile : 720) / cols) * 2)
  const scaled = list
    .map(
      (_, i) =>
        `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuvj420p[v${i}]`,
    )
    .join(';')
  const joined = `${list.map((_, i) => `[v${i}]`).join('')}concat=n=${list.length}:v=1:a=0,tile=${cols}x${rows}:nb_frames=${list.length}[out]`
  const cmd = [
    path,
    '-hide_banner',
    '-loglevel',
    'error',
    ...list.flatMap((url) => [...headerArgs(media), '-i', url]),
    '-filter_complex',
    `${scaled};${joined}`,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]
  const result = await runtime.spawn(cmd, { signal, timeoutMs: 120000 })
  if (result.code !== 0 || !result.stdout.length) throw new Error(t('ffmpeg 拼图失败'))
  return { grid: result.stdout, mime: 'image/jpeg', timestampsSec: list.map((_, i) => i + 1) }
}
