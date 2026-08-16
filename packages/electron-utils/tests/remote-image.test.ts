import { describe, expect, it, vi } from 'vitest'
import { fetchRemoteImage, remoteImageHeaders } from '../src/remote-image'

const png = () => new Response('img', { status: 200 })

describe('remoteImageHeaders', () => {
  it('sends a browser-like User-Agent and image Accept', () => {
    const headers = remoteImageHeaders('https://example.com/a.png')
    expect(headers['User-Agent']).toBeTruthy()
    expect(headers.Accept).toContain('image/')
  })

  it('does not advertise formats the insert pipelines mislabel (avif/webp)', () => {
    const accept = remoteImageHeaders('https://example.com/a.png').Accept!
    expect(accept).not.toContain('avif')
    expect(accept).not.toContain('webp')
  })
})

describe('fetchRemoteImage', () => {
  it('returns the response on first success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(png())
    const resp = await fetchRemoteImage('https://cdn.example.com/a.png', {
      fetchImpl,
      retryDelaysMs: [0, 0],
    })
    expect(resp?.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries transient statuses until success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(new Response('nope', { status: 403 }))
      .mockResolvedValueOnce(png())
    const resp = await fetchRemoteImage('https://cdn.example.com/a.png', {
      fetchImpl,
      retryDelaysMs: [0, 0],
    })
    expect(resp?.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('retries network errors and returns null when the budget is exhausted', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const resp = await fetchRemoteImage('https://cdn.example.com/a.png', {
      fetchImpl,
      retryDelaysMs: [0],
    })
    expect(resp).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent statuses like 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    const resp = await fetchRemoteImage('https://cdn.example.com/a.png', {
      fetchImpl,
      retryDelaysMs: [0, 0],
    })
    expect(resp?.status).toBe(404)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry SSRF-blocked URLs', async () => {
    const fetchImpl = vi.fn()
    const resp = await fetchRemoteImage('https://127.0.0.1/a.png', {
      fetchImpl,
      retryDelaysMs: [0, 0],
    })
    expect(resp).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
