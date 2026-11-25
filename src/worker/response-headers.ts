const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
] as const;

/** Removes connection-specific metadata at the Node-to-Worker boundary. */
export function stripHopByHopHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  const connection = headers.get('connection');

  for (const name of connection?.split(',') ?? []) {
    const token = name.trim();

    if (token) {
      headers.delete(token);
    }
  }

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
