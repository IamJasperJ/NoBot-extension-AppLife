import { expect, test } from 'bun:test'
import { liveOf, liveStatus, pollLive } from './live'
import { todayCount } from './social'
import { socialFixture } from './social-test-utils'
import type { LiveMessage } from './types'

const message = (id: string, senderId = 'owner', text = id): LiveMessage => ({
  id,
  senderId,
  senderName: senderId,
  text,
  at: Number(id),
})
test('直播启动播种，只回最新命中、双去重、自身过滤、每日额度与房间缓存', async () => {
  const x = socialFixture(),
    sent: string[] = []
  x.p.settings.liveRoom = 'short'
  x.p.settings.liveDailyReplies = 2
  let messages = [message('1')],
    rooms = 0
  x.p.adapter.live.room = async () => {
    rooms++
    return { roomId: 'long', anchorId: 'anchor', title: '房间', live: true }
  }
  x.p.adapter.live.recent = async () => messages
  x.p.adapter.live.send = async (room, text) => {
    expect(room).toBe('long')
    sent.push(text)
  }
  await pollLive(x.p, 1)
  expect(sent).toHaveLength(0)
  messages = [message('1'), message('2'), message('3')]
  await pollLive(x.p, 60001)
  expect(sent).toHaveLength(1)
  expect(x.prompts[0]?.instruction).toContain('"text":"3"')
  messages = [message('4', 'owner', '3'), message('5', 'self', '@她'), message('6', 'stranger', 'hello')]
  await pollLive(x.p, 120001)
  expect(sent).toHaveLength(1)
  x.p.settings.liveScope = 'mention'
  messages = [message('7', 'stranger', '@她 嗨')]
  await pollLive(x.p, 180001)
  expect(sent).toHaveLength(2)
  messages = [message('8')]
  await pollLive(x.p, 240001)
  expect(sent).toHaveLength(2)
  expect(todayCount(x.p, 'live', 240001)).toBe(2)
  expect(rooms).toBe(1)
  expect(liveStatus(x.p, 240001)).toMatchObject({ enabled: true, roomId: 'long', live: true, today: 2 })
})
test('离线五分钟退避，不读弹幕，恢复先播种；房间变更也播种', async () => {
  const x = socialFixture()
  x.p.settings.liveRoom = 'one'
  let online = false,
    reads = 0,
    sends = 0
  x.p.adapter.live.room = async () => ({ roomId: 'one', anchorId: 'a', title: '房间', live: online })
  x.p.adapter.live.recent = async () => {
    reads++
    return [message(String(reads))]
  }
  x.p.adapter.live.send = async () => {
    sends++
  }
  await pollLive(x.p, 1)
  expect(liveOf(x.p).nextAt).toBe(300001)
  expect(reads).toBe(0)
  online = true
  await pollLive(x.p, 300001)
  expect(reads).toBe(1)
  expect(sends).toBe(0)
  await pollLive(x.p, 360001)
  expect(sends).toBe(1)
  x.p.settings.liveRoom = 'two'
  await pollLive(x.p, 360002)
  expect(sends).toBe(1)
})
test('未知写结果不重发，暂停与窗口外不读取', async () => {
  const x = socialFixture()
  x.p.settings.liveRoom = 'one'
  let calls = 0
  x.p.adapter.live.room = async () => {
    calls++
    throw new Error('offline')
  }
  x.p.paused = () => true
  await pollLive(x.p, 1)
  expect(calls).toBe(0)
  x.p.paused = () => false
  await pollLive(x.p, 1)
  expect(liveOf(x.p).failures).toBe(1)
})

test('直播未知写失败消费消息，恢复先播种，关闭后重开也播种', async () => {
  const x = socialFixture()
  x.p.settings.liveRoom = 'one'
  let messages = [message('1')],
    attempts = 0
  x.p.adapter.live.room = async () => ({ roomId: 'one', anchorId: 'a', title: '房间', live: true })
  x.p.adapter.live.recent = async () => messages
  x.p.adapter.live.send = async () => {
    attempts++
    throw new Error('unknown result')
  }
  await pollLive(x.p, 1)
  messages = [message('2')]
  await pollLive(x.p, 60001)
  expect(attempts).toBe(1)
  expect(liveOf(x.p).seen).toContain('2')
  expect(liveOf(x.p).seeded).toBe(false)
  messages = [message('2'), message('3')]
  await pollLive(x.p, 180001)
  expect(attempts).toBe(1)
  x.p.settings.liveRoom = ''
  await pollLive(x.p, 180002)
  x.p.settings.liveRoom = 'one'
  messages = [message('4')]
  await pollLive(x.p, 180003)
  expect(attempts).toBe(1)
})
