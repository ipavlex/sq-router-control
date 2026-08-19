/**
 * Renderer-side type declarations: the `sq` bridge exposed by the preload
 * script, plus re-exports of the shared IPC payload types.
 */
import type { SqApi } from "../shared/ipc";

declare global {
  interface Window {
    sq: SqApi;
  }
}

export type {
  ModelSpec,
  SnapshotPayload,
  SnapshotInput,
  SnapshotOutput,
  StatusPayload,
  LogPayload,
  LogLevel,
  VersionInfo,
  ConnectResult,
} from "../shared/ipc";
