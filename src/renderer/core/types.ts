/**
 * Renderer-side type declarations: the `sq` bridge exposed by the preload
 * script, plus re-exports of the shared IPC payload types.
 */
import type { ModelSpec, SnapshotInput, SqApi } from "../../shared/ipc";

declare global {
  interface Window {
    sq: SqApi;
  }
}

/** Typed refs to every element the renderer touches. */
export interface ElementRefs {
  connectScreen: HTMLElement;
  dashScreen: HTMLElement;
  ip: HTMLInputElement;
  port: HTMLInputElement;
  connectBtn: HTMLButtonElement;
  demoBtn: HTMLButtonElement;
  connectMsg: HTMLElement;
  recentRow: HTMLElement;
  recentList: HTMLElement;
  topbarTitle: HTMLElement;
  topbarSub: HTMLElement;
  requestBtn: HTMLButtonElement;
  logBtn: HTMLButtonElement;
  viewRouting: HTMLElement;
  viewLog: HTMLElement;
  viewMonitor: HTMLElement;
  routingBtn: HTMLButtonElement;
  monitorBtn: HTMLButtonElement;
  monLDest: HTMLSelectElement;
  monRDest: HTMLSelectElement;
  mixButtons: HTMLElement;
  chButtons: HTMLElement;
  mainlrBtn: HTMLButtonElement;
  monEnable: HTMLInputElement;
  disconnectBtn: HTMLButtonElement;
  inputTbody: HTMLTableSectionElement;
  inEmpty: HTMLElement;
  editInputTbody: HTMLTableSectionElement;
  editInEmpty: HTMLElement;
  updateStat: HTMLElement;
  log: HTMLElement;
  clearLog: HTMLButtonElement;
  saveRoutingBtn: HTMLButtonElement;
  topbarScene: HTMLElement;
  saveFeedback: HTMLElement;
  saveModal: HTMLElement;
  saveNameInput: HTMLInputElement;
  saveCancelBtn: HTMLButtonElement;
  saveConfirmBtn: HTMLButtonElement;
  loadRoutingBtn: HTMLButtonElement;
  loadModal: HTMLElement;
  loadList: HTMLElement;
  loadEmpty: HTMLElement;
  loadCancelBtn: HTMLButtonElement;
  loadConfirmBtn: HTMLButtonElement;
  loadIgnoreConfig: HTMLElement;
  loadIgnoreConfigInput: HTMLInputElement;
  uploadBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  abBtn: HTMLButtonElement;
  bBtn: HTMLButtonElement;
  activePatchingTitle: HTMLElement;
  inputPatchingTitle: HTMLElement;
  syncScrollBtn: HTMLButtonElement;
  editTableWrap: HTMLElement;
  activeTableWrap: HTMLElement;
}

/** Cross-tab state shared by all renderer modules. */
export interface RendererState {
  /** Current model spec; drives input/output count adaptation. */
  modelSpec: ModelSpec | null;
  /** Stereo pairs from snapshot: [[leftB3, rightB3], ...] */
  stereoPairs: number[][];
  /** Last routing snapshot received from the console (Active Patching data). */
  activeInputs: SnapshotInput[];
  /** Name of the console's currently-active scene (from snapshot), or null. */
  currentSceneName: string | null;
  /** Whether the current session is running in demo (simulated) mode. */
  isDemoMode: boolean;
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
} from "../../shared/ipc";
