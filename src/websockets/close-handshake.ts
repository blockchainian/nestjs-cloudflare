/** Completes a peer close when the runtime has not already replied. */
export function completeWebSocketClose(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CLOSING
  ) {
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
}
