export function generateId(): string {
  return Date.now().toString();
}

export function generateSessionId(): string {
  return Date.now().toString();
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString();
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}
