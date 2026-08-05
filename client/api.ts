/**
 * Action helper — POST to /action/:name with JSON body.
 * Throws on non-OK responses with the server error message.
 */
export async function call(name: string, ...args: unknown[]): Promise<void> {
  const res = await fetch(`/action/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  if (!res.ok) {
    let errMsg = `Action ${name} failed: ${res.status}`
    try {
      const body = await res.json() as { error?: string }
      if (body.error) errMsg = body.error
    } catch {
      // ignore json parse failure
    }
    throw new Error(errMsg)
  }
}
