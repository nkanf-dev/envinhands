/** One explicit relay wire version; binary payloads remain opaque. */
export const RELAY_VERSION = "2";
export const REGISTERED = "registered-v2";
export const READY = "ready-v2";
export const FIN = "fin";
export const FIN_ACK = "fin-ack";
export function relayControl(value: unknown): "fin" | "fin-ack" | null {
  return value === FIN || value === FIN_ACK ? value : null;
}
export function relayEndpoint(base: string, path: string, key: string, value: string): string {
  const url = new URL(path, base);
  url.searchParams.set(key, value); url.searchParams.set("v", RELAY_VERSION);
  return url.toString();
}
