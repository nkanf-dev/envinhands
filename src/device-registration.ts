/** Lightweight device inventory registration; never installs SSH keys or privileges. */
import { hostname, platform, arch, userInfo } from "node:os";
import { PrimeBridge, BridgeError } from "./prime-bridge.ts";
import type { RegisterMachine, StoredMachine } from "./storage.ts";

export interface DeviceObservation {
  hostname: string;
  platform: string;
  arch: string;
  sshUser: string;
  sshPort: number;
}
export type DeviceCollector = () => DeviceObservation;
export interface DeviceRegistrationOptions {
  /** User-chosen stable catalog ID, not derived from hostname. */
  id: string;
  /** Explicit reachable address selected by the user, not the detected hostname. */
  host: string;
  name?: string;
  sshUser?: string;
  sshPort?: number;
  relayNodeId?: string;
}
export interface CollectedDevice {
  machine: RegisterMachine;
  observation: DeviceObservation;
}
export interface DeviceRegistrationReceipt extends Omit<CollectedDevice, "machine"> {
  machine: StoredMachine;
  verificationRequested: boolean;
  verificationScope: string | null;
}
const safeId = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !safeId.test(value) || /[\r\n]/.test(value)) throw new BridgeError("Invalid device ID");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new BridgeError("Invalid device metadata");
  return value.trim();
}
export function collectLocalDevice(): DeviceObservation {
  return { hostname: hostname(), platform: platform(), arch: arch(), sshUser: userInfo().username, sshPort: 22 };
}
export function collectDeviceRegistration(options: DeviceRegistrationOptions, collect: DeviceCollector = collectLocalDevice): CollectedDevice {
  id(options.id);
  if (options.relayNodeId !== undefined) id(options.relayNodeId);
  const local = collect();
  const os = { linux: "linux", darwin: "macos", win32: "windows" }[local.platform];
  if (!os) throw new BridgeError("Unsupported device platform");
  const observed = { hostname: text(local.hostname, 200), platform: local.platform, arch: text(local.arch, 100),
    sshUser: text(options.sshUser ?? local.sshUser, 64), sshPort: options.sshPort ?? local.sshPort };
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(observed.sshUser) || !Number.isInteger(observed.sshPort) || observed.sshPort < 1 || observed.sshPort > 65535)
    throw new BridgeError("Invalid device SSH endpoint");
  return { machine: { id: options.id, name: text(options.name ?? observed.hostname, 200), host: text(options.host, 253), os,
    sshUser: observed.sshUser, sshPort: observed.sshPort, ...(options.relayNodeId === undefined ? {} : { relayNodeId: options.relayNodeId }) }, observation: observed };
}
function responseMachine(value: unknown, expected: RegisterMachine): StoredMachine {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Invalid device response");
  const machine = value as Record<string, unknown>;
  if (!["pending", "ready", "not-ready"].includes(String(machine.status)) ||
      !["id", "name", "host", "os", "sshUser", "sshPort"].every(key => machine[key] === expected[key as keyof RegisterMachine]) ||
      machine.relayNodeId !== (expected.relayNodeId ?? null) || typeof machine.registeredAt !== "string")
    throw new BridgeError("Invalid device response");
  return machine as unknown as StoredMachine;
}
export class DeviceRegistrationClient extends PrimeBridge {
  /** Register only by default. Explicit verification checks the service's SSH identity, not this client's. */
  async registerDevice(options: DeviceRegistrationOptions, settings: { verify?: boolean } = {}, collect: DeviceCollector = collectLocalDevice): Promise<DeviceRegistrationReceipt> {
    const collected = collectDeviceRegistration(options, collect);
    const created = await this.request("/v1/machines", "POST", collected.machine, true, 256 * 1024);
    const accepted = created as { machine?: unknown } | null;
    let machine = responseMachine(accepted?.machine, collected.machine);
    if (machine.status !== "pending") throw new BridgeError("Unexpected initial device state");
    if (!settings.verify) return { ...collected, machine, verificationRequested: false, verificationScope: null };
    const verified = await this.request(`/v1/machines/${encodeURIComponent(machine.id)}/verify`, "POST", undefined, true, 256 * 1024);
    const receipt = verified as { machine?: unknown; verificationScope?: unknown } | null;
    machine = responseMachine(receipt?.machine, collected.machine);
    if (machine.status === "pending" || typeof receipt?.verificationScope !== "string") throw new BridgeError("Invalid device verification response");
    return { ...collected, machine, verificationRequested: true, verificationScope: receipt.verificationScope };
  }
}
