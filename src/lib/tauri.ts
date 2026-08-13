/** Typed wrappers over the Tauri command and event surface. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  Profile,
  ServerVersion,
  Status,
  StreamItem,
  TilesetManifest,
  TilesetPayload,
} from "./protocol";

export const EVENTS = {
  stream: "nh://stream",
  status: "nh://status",
  tiledataSeen: "nh://tiledata-seen",
  serverVersion: "nh://server-version",
} as const;

export const listProfiles = () => invoke<Profile[]>("list_profiles");
export const lastUsedProfile = () => invoke<string | null>("last_used_profile");

/** `password` of `null` leaves any stored password untouched. */
export const saveProfile = (profile: Profile, password: string | null) =>
  invoke<void>("save_profile", { profile, password });

export const deleteProfile = (id: string) => invoke<void>("delete_profile", { id });
export const hasSavedPassword = (id: string) =>
  invoke<boolean>("has_saved_password", { id });

export const listTilesets = () => invoke<TilesetManifest[]>("list_tilesets");
export const getTileset = (id: string) => invoke<TilesetPayload>("get_tileset", { id });
export const addCustomTileset = (manifest: TilesetManifest, path: string) =>
  invoke<TilesetPayload>("add_custom_tileset", { manifest, path });

export const sessionConnect = (profileId: string, cols: number, rows: number) =>
  invoke<void>("session_connect", { request: { profileId, cols, rows } });

export const sessionWrite = (data: string) => invoke<void>("session_write", { data });
/** For bytes no UTF-8 string can carry, such as NetHack's meta commands. */
export const sessionWriteBytes = (bytes: number[]) =>
  invoke<void>("session_write_bytes", { bytes });
export const sessionResize = (cols: number, rows: number) =>
  invoke<void>("session_resize", { cols, rows });
export const sessionDisconnect = () => invoke<void>("session_disconnect");

/** Replaces the known files in a state-log directory. Unknown names are refused. */
export const writeStateLog = (directory: string, files: Record<string, string>) =>
  invoke<void>("state_log_write", { request: { directory, files } });

/**
 * Hands a link to the desktop browser.
 *
 * A bare `<a href>` would navigate the webview itself, replacing the game with
 * a web page and no way back, so every outbound link goes through here.
 */
export const openExternal = (url: string) =>
  openUrl(url).catch((error) => {
    void reportFrontendError(`openUrl(${url}) failed: ${error}`);
  });

/** Sends a frontend failure to the backend log, where it is actually visible. */
export const reportFrontendError = (message: string) =>
  invoke<void>("log_frontend_error", { message }).catch(() => {
    // Nothing more we can do; at least it reached the browser console.
    console.error(message);
  });

/**
 * `listen` throws synchronously when the Tauri IPC bridge is missing (for
 * example when the frontend is opened in a plain browser). Letting that
 * escape a React effect unmounts the whole tree, so subscriptions always
 * resolve to a no-op unsubscribe instead of throwing.
 */
function subscribe<T>(event: string, fn: (payload: T) => void): Promise<UnlistenFn> {
  const noop: UnlistenFn = () => {};
  try {
    return listen<T>(event, (e) => fn(e.payload)).catch((error) => {
      void reportFrontendError(`listen(${event}) failed: ${error}`);
      return noop;
    });
  } catch (error) {
    void reportFrontendError(`listen(${event}) threw: ${error}`);
    return Promise.resolve(noop);
  }
}

export const onStream = (fn: (items: StreamItem[]) => void) =>
  subscribe<StreamItem[]>(EVENTS.stream, fn);

export const onStatus = (fn: (status: Status) => void) =>
  subscribe<Status>(EVENTS.status, fn);

export const onTiledataSeen = (fn: () => void) =>
  subscribe<unknown>(EVENTS.tiledataSeen, () => fn());

export const onServerVersion = (fn: (found: ServerVersion) => void) =>
  subscribe<ServerVersion>(EVENTS.serverVersion, fn);
