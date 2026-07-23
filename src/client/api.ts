interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const envelope = await response.json() as Envelope<T>;
  if (!response.ok || !envelope.ok || !envelope.data) {
    throw new ApiClientError(
      envelope.error?.message ?? "系統暫時無法處理要求。",
      response.status,
      envelope.error?.details,
    );
  }
  return envelope.data;
}

export function jsonBody(value: object): Pick<RequestInit, "headers" | "body"> {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
