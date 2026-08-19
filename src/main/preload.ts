/**
 * Preload — bridges the sandboxed renderer to the main process via contextBridge.
 * Exposes a minimal, typed `sq` API on the renderer's window.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  ConnectResult,
  LogPayload,
  ModelSpec,
  SnapshotPayload,
  StatusPayload,
} from "../shared/ipc";

contextBridge.exposeInMainWorld("sq", {
  connect: (host: string, port?: number): Promise<ConnectResult> =>
    ipcRenderer.invoke("sq:connect", host, port),
  disconnect: (): Promise<boolean> => ipcRenderer.invoke("sq:disconnect"),
  getSnapshot: (): Promise<SnapshotPayload> => ipcRenderer.invoke("sq:getSnapshot"),
  demoRefresh: (): Promise<SnapshotPayload> => ipcRenderer.invoke("sq:demoRefresh"),
  setMonitorOutput: (side: "L" | "R", destType: number, destChannel: number): Promise<boolean> =>
    ipcRenderer.invoke("sq:setMonitorOutput", side, destType, destChannel),
  setPafl: (b3: number, on: boolean): Promise<boolean> =>
    ipcRenderer.invoke("sq:setPafl", b3, on),
  setOutputPatch: (sourceB3: number, destType: number, destChannel: number): Promise<boolean> =>
    ipcRenderer.invoke("sq:setOutputPatch", sourceB3, destType, destChannel),
  requestDump: (): Promise<boolean> => ipcRenderer.invoke("sq:requestDump"),
  applyRouting: (
    data: { inputs?: SnapshotPayload["inputs"]; outputs?: SnapshotPayload["outputs"] }
  ): Promise<{ ok: boolean; applied: number; skipped: number; error?: string }> =>
    ipcRenderer.invoke("sq:applyRouting", data),
  setInputPatch: (destB3: number, source: number, sourceChannel: number): Promise<boolean> =>
    ipcRenderer.invoke("sq:setInputPatch", destB3, source, sourceChannel),
  startDemo: (): Promise<ConnectResult> => ipcRenderer.invoke("sq:startDemo"),
  getStatus: (): Promise<StatusPayload> => ipcRenderer.invoke("sq:getStatus"),
  onStatus: (cb: (p: StatusPayload) => void): (() => void) => {
    const h = (_e: unknown, p: StatusPayload) => cb(p);
    ipcRenderer.on("sq:status", h);
    return () => ipcRenderer.off("sq:status", h);
  },
  onRouting: (cb: (p: SnapshotPayload) => void): (() => void) => {
    const h = (_e: unknown, p: SnapshotPayload) => cb(p);
    ipcRenderer.on("sq:routing", h);
    return () => ipcRenderer.off("sq:routing", h);
  },
  onLog: (cb: (p: LogPayload) => void): (() => void) => {
    const h = (_e: unknown, p: LogPayload) => cb(p);
    ipcRenderer.on("sq:log", h);
    return () => ipcRenderer.off("sq:log", h);
  },
  /** Fired once the console's initial state burst has been fully received. */
  onInitialState: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on("sq:initialState", h);
    return () => ipcRenderer.off("sq:initialState", h);
  },
});
