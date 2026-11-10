// Experimental loopback control transport, independent of the installed bb app.
export async function controlRequest(url: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; text: string }> {
  const method = body === undefined ? 'GET' : 'POST';
  try {
    const response = await fetch(`${url}${path}`, {
      method,
      // Synchronous CLI operations can outlive the server's idle timeout while
      // blocking our event loop. Never reuse that possibly closed connection.
      headers: { 'content-type': 'application/json', connection: 'close' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (cause) {
    // Do not include the URL, credentials or request body. No mutation retries.
    throw new Error(`Control request failed: ${method} ${path}`, { cause });
  }
}
