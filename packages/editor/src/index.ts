/**
 * @parallax/editor — the Parallax editor page. `parallax edit <project>`
 * bundles this entry next to the engine and serves it; the page calls `bootEditor`.
 */

import './styles.css';
import './host.css';
import './hierarchy.css';

export { bootEditor } from './boot.js';
export type { EditorBootFailure, EditorBootOptions } from './boot.js';
export { Editor, playStartScene, projectLabel, SNAP } from './editor.js';
export type { Change, GizmoSettings, LogEntry, LogLevel, SaveOptions, SaveRecord } from './editor.js';
export { MAX_TOASTS, setToastRoot, showToast, TOAST_MS, toastSaves } from './toast.js';
export type { ToastHandle, ToastLevel } from './toast.js';
export { qualityFromSearch, urlQuality } from './quality_override.js';
export { EVENTS_URL, needsCode, SAVE_URL, save, saveRequest } from './server_link.js';
export { DEFAULT_STYLE, formatJson, jsonStyle } from './format_json.js';
export type { JsonStyle } from './format_json.js';
export type { BuildEvent, SaveRequest } from './server_link.js';
export { createEditorHost, HostEvents, whenEditorReady } from './host.js';
export type {
  BottomTab, CameraMode, Disposer, EditorEventSource, EditorHost, EditorHostEvent, EditorHostEvents, HostParts, PublishAction, PublishContext,
  SettingsEntry, ToolbarItem, ToolbarSlot, LogoAction, RenameAction, RenameContext,
} from './host.js';
export { EditorLayout } from './layout.js';
export type { Banner, BannerTone, EditorChrome } from './layout.js';
export { fetchProjectFiles, isDocument, planOutsideChanges } from './outside_changes.js';
export type { OutsidePlan } from './outside_changes.js';
export { currentSite, DEFAULT_SITE, setSite } from './site.js';
export type { EditorSite } from './site.js';
export { serverUrl, setServerBase } from './paths.js';
export { comingSoonPublish } from './publish_dialog.js';
