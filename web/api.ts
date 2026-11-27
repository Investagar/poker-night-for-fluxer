export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Secure random command ID: 32 hex chars from crypto.getRandomValues, which browsers also provide on
 * insecure local origins (only crypto.subtle is limited to secure contexts).
 */
export function newCommandId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Same-origin JSON request; a body makes it a POST. */
export async function api<T>(path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'offline', 'The table server could not be reached. Check your connection.');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.code ?? 'error', data.error ?? 'That request could not be completed.');
  return data as T;
}
