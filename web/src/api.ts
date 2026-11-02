// Talks to the local server. Every call carries the per-launch token the server
// put in the page, so other websites can't drive the agent.

export const token = document.querySelector<HTMLMetaElement>('meta[name="m1-token"]')?.content ?? "";

/** Set by rc.mincoffical.codes when this UI runs remotely: requests and the live socket go through the encrypted relay. */
type Remote = {
  fetch: typeof fetch;
  WebSocket: new (path: string) => WebSocket;
  openFile: (path: string) => void;
  /** How this page can be installed: as an app already, by the browser's prompt, by Add to Home Screen on iPhone/iPad, or not here. */
  installable?: () => "standalone" | "prompt" | "ios" | "";
  install?: () => Promise<string>;
};
const remote = (window as unknown as { __M1_REMOTE__?: Remote }).__M1_REMOTE__;
export const isRemote = Boolean(remote);
export const installable = () => remote?.installable?.() ?? "";
export const install = () => remote?.install?.() ?? Promise.resolve("unavailable");
export const rawFetch: typeof fetch = remote ? remote.fetch : (input, init) => fetch(input, init);
export const openSocket = (path: string): WebSocket => (remote ? new remote.WebSocket(path) : new WebSocket(socketURL(path)));
/** Opens an attachment. Remotely it can't be a plain link, since the file lives on the computer. */
export function openFile(e: { preventDefault(): void }, id: string) {
  if (!remote) return;
  e.preventDefault();
  remote.openFile(`/api/uploads/${id}`);
}

export class ApiError extends Error {}

async function request(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-M1-Token": token, ...(init.headers as Record<string, string>) };
  let payload = init.body;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await rawFetch(path, { ...init, method, headers, body: payload });
  if (res.status === 401) {
    // The server restarted with a new token.
    location.reload();
    throw new ApiError("Reconnecting…");
  }
  if (!res.ok) {
    let message = `Something went wrong (${res.status}).`;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new ApiError(message);
  }
  return res;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function upload(file: Blob, name: string) {
  const res = await request("POST", "/api/uploads", undefined, {
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(name) },
  });
  return res.json();
}

export async function transcribe(wav: Blob): Promise<string> {
  const res = await request("POST", "/api/transcribe", undefined, { body: wav, headers: { "Content-Type": "audio/wav" } });
  return (await res.json()).text ?? "";
}

export const fileURL = (id: string) => `/api/uploads/${id}?t=${token}`;

export const socketURL = (path: string) => `ws://${location.host}${path}?t=${token}`;
