/**
 * Shared IPC payload types and the `sq` bridge API surface.
 * Used by both the main process (preload) and the renderer.
 */

export interface VersionInfo {
  model: number;
  modelName: string;
  fwA: number;
  fwB: number;
  build?: number;
}

export interface ModelSpec {
  id: number;
  name: string;
  inputChannels: number;
  localInputs: number;
  /** Local line outputs on XLR sockets (12/14/16). */
  xlrOutputs: number;
  /** Local line outputs on TRS jack sockets (A/B) — 2 on all models. */
  trsOutputs: number;
  /** Total assignable local outputs (XLR + TRS). */
  localOutputs: number;
  usbChannels: number;
  mixBuses: number;
  dcaGroups: number;
  description: string;
}

export interface ConnectResult {
  ok: boolean;
  version?: VersionInfo;
  spec?: ModelSpec;
  error?: string;
}

export interface SnapshotInput {
  destB3: number;
  destLabel: string;
  name: string;
  source: number;
  sourceLabel: string;
  sourceChannel: number;
}

export interface SnapshotOutput {
  kind: string;
  sourceLabel: string;
  dest: number;
  destLabel: string;
  destChannel: number;
}

export interface SnapshotPayload {
  inputs: SnapshotInput[];
  outputs: SnapshotOutput[];
  stereoPairs: number[][];
  updates: number;
  routingBlockBytes: number | null;
  /** Name of the console's currently-active scene, if known. */
  currentSceneName?: string | null;
}

export interface StatusPayload {
  connected: boolean;
  host?: string;
  version?: VersionInfo;
  spec?: ModelSpec;
}

export interface MetersPayload {
  /** dBFS levels for input channels 0..47 (null = no signal / floor). */
  inputs: (number | null)[];
  /** true when a channel's peak is at or above 0 dBFS (clip). */
  clip: boolean[];
}

export type LogLevel = "dsp" | "frame" | "ok" | "warn" | "error";

export interface LogPayload {
  level: LogLevel;
  msg: string;
}

/**
 * The typed `window.sq` bridge exposed by the preload script.
 */
export interface SqApi {
  connect(host: string, port?: number): Promise<ConnectResult>;
  disconnect(): Promise<boolean>;
  getSnapshot(): Promise<SnapshotPayload>;
  demoRefresh(): Promise<SnapshotPayload>;
  setMonitorOutput(side: "L" | "R", destType: number, destChannel: number): Promise<boolean>;
  setPafl(b3: number, on: boolean): Promise<boolean>;
  setOutputPatch(sourceB3: number, destType: number, destChannel: number): Promise<boolean>;
  requestDump(): Promise<boolean>;
  applyRouting(data: {
    inputs?: SnapshotInput[];
    outputs?: SnapshotOutput[];
  }): Promise<{ ok: boolean; applied: number; skipped: number; error?: string }>;
  setInputPatch(destB3: number, source: number, sourceChannel: number): Promise<boolean>;
  startDemo(): Promise<ConnectResult>;
  getStatus(): Promise<StatusPayload>;
  onStatus(cb: (p: StatusPayload) => void): () => void;
  onRouting(cb: (p: SnapshotPayload) => void): () => void;
  onLog(cb: (p: LogPayload) => void): () => void;
  /** Live input channel levels/meters. Fired from UDP at up to ~30 Hz. */
  onMeters(cb: (p: MetersPayload) => void): () => void;
  /** Fired once the console's initial state burst has been fully received. */
  onInitialState(cb: () => void): () => void;
}
