export interface APIErrorBody {
  error?: { code?: string; message?: string }
}

export class APIError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'APIError'
    this.status = status
    this.code = code
  }
}

export class APIClient {
  readonly baseURL: string
  readonly origin: string

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/$/, '')
    this.origin = this.baseURL.startsWith('http')
      ? new URL(this.baseURL).origin
      : typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    let response: Response
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed'
      throw new APIError(0, 'network_error', `Couldn’t reach the MELO API. ${message}`)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        if (!response.ok) throw new APIError(response.status, 'invalid_response', `MELO API returned HTTP ${response.status}`)
        throw new APIError(response.status, 'invalid_response', 'MELO API returned an invalid response')
      }
    }
    if (!response.ok) {
      const apiError = body as APIErrorBody | null
      throw new APIError(
        response.status,
        apiError?.error?.code ?? 'api_error',
        apiError?.error?.message ?? `MELO API returned HTTP ${response.status}`,
      )
    }
    return body as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path)
  }

  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  absoluteURL(path: string): string {
    if (/^https?:\/\//i.test(path) || path.startsWith('blob:')) return path
    return new URL(path, `${this.origin}/`).toString()
  }
}
