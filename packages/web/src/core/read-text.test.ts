import { describe, expect, it, vi } from 'vitest'
import { decodeText, fetchHead, lineCount, TextFetchError } from './read-text'

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

describe('reading text for the preview', () => {
  it('reads only the head of a long file, and says it stopped', async () => {
    const body = streamOf(new Uint8Array(6).fill(65), new Uint8Array(6).fill(66))
    const fetchFn = vi.fn().mockResolvedValue(new Response(body))
    const { bytes, truncated } = await fetchHead('/x', 8, new AbortController().signal, fetchFn)
    expect(new TextDecoder().decode(bytes)).toBe('AAAAAABB')
    expect(truncated).toBe(true)
  })

  it('reads a short file whole', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('abc'))
    const { bytes, truncated } = await fetchHead('/x', 8, new AbortController().signal, fetchFn)
    expect(new TextDecoder().decode(bytes)).toBe('abc')
    expect(truncated).toBe(false)
  })

  it('tells a missing file from a failed fetch', async () => {
    const missing = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    const gone = await fetchHead('/x', 8, new AbortController().signal, missing).catch(
      (error: unknown) => error,
    )
    expect((gone as TextFetchError).missing).toBe(true)
    const broken = vi.fn().mockRejectedValue(new Error('offline'))
    const failed = await fetchHead('/x', 8, new AbortController().signal, broken).catch(
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(TextFetchError)
    expect((failed as TextFetchError).missing).toBe(false)
  })

  it('decodes UTF-8 and UTF-16, and knows binary when it sees a NUL', () => {
    expect(decodeText(new TextEncoder().encode('﻿grüß'))).toEqual({
      text: 'grüß',
      binary: false,
    })
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])).text).toBe('hi')
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])).binary).toBe(true)
  })

  it('counts lines, a trailing newline starting none', () => {
    expect(lineCount('')).toBe(1)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('a\nb\n')).toBe(2)
  })
})
