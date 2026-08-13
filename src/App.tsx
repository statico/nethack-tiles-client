import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { DisplayControls } from "./components/DisplayControls";
import { GameTerminal } from "./components/GameTerminal";
import { ProfileForm } from "./components/ProfileForm";
import { TILES, Tile } from "./components/Tile";
import type {
  DisplaySettings,
  Profile,
  ServerVersion,
  Status,
  TilesetManifest,
  TilesetPayload,
} from "./lib/protocol";
import {
  deleteProfile,
  getTileset,
  listProfiles,
  listTilesets,
  lastUsedProfile,
  onServerVersion,
  onStatus,
  onTiledataSeen,
  openExternal,
  saveProfile,
  sessionConnect,
  sessionDisconnect,
} from "./lib/tauri";

/** Where the source lives, and where bugs should be reported. */
const REPO_URL = "https://github.com/statico/nethack-tiles-client";
const AUTHOR_URL = "https://github.com/statico";

/** How long to wait for tile codes before suggesting the .nethackrc fix. */
const TILEDATA_GRACE_MS = 40_000;

/**
 * How long to let display sliders settle before writing the profile. Dragging
 * a slider fires continuously and each save is a disk write.
 */
const DISPLAY_SAVE_DEBOUNCE_MS = 600;

function newProfile(tilesetId: string): Profile {
  return {
    id: `profile-${Date.now().toString(36)}`,
    name: "",
    transport: "ssh",
    command: "",
    host: "",
    port: 22,
    sshUser: "nethack",
    gameUser: "",
    version: "v36",
    tilesetId,
    fontFamily: "Menlo, DejaVu Sans Mono, Consolas, monospace",
    fontSize: 16,
    scale: 1,
    lineHeight: 1,
    letterSpacing: 0,
    pixelPerfect: false,
    stateLogEnabled: false,
    stateLogDirectory: "",
  };
}

type Screen = { kind: "list" } | { kind: "edit"; profile: Profile; isNew: boolean };

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tilesets, setTilesets] = useState<TilesetManifest[]>([]);
  const [tileset, setTileset] = useState<TilesetPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState<Profile | null>(null);
  const [tilesEnabled, setTilesEnabled] = useState(true);
  const [tiledataHint, setTiledataHint] = useState(false);
  const [sheetMismatch, setSheetMismatch] = useState<number | null>(null);
  const [serverVersion, setServerVersion] = useState<ServerVersion | null>(null);
  const [showDisplay, setShowDisplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const graceTimer = useRef<number | null>(null);
  const displaySaveTimer = useRef<number | null>(null);
  const unsavedDisplay = useRef<Profile | null>(null);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const refreshProfiles = useCallback(async () => {
    const [list, last] = await Promise.all([listProfiles(), lastUsedProfile()]);
    setProfiles(list);
    setSelectedId((current) => current ?? last ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const sheets = await listTilesets();
        setTilesets(sheets);
        if (sheets[0]) setTileset(await getTileset(sheets[0].id));
        await refreshProfiles();
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshProfiles]);

  // Load the sheet the selected profile asks for.
  useEffect(() => {
    if (!selected) return;
    if (tileset?.manifest.id === selected.tilesetId) return;
    getTileset(selected.tilesetId)
      .then(setTileset)
      .catch(() => {
        /* keep the previous sheet; the picker still shows the mismatch */
      });
  }, [selected, tileset]);

  useEffect(() => {
    const unlisten = onStatus((next) => {
      setStatus(next);
      if (next.state === "error") setError(next.message);
      if (next.state === "closed") {
        setConnected(null);
        setTiledataHint(false);
      }
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  useEffect(() => {
    const unlisten = onServerVersion(setServerVersion);
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  useEffect(() => {
    const unlisten = onTiledataSeen(() => {
      setTiledataHint(false);
      if (graceTimer.current) window.clearTimeout(graceTimer.current);
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  const connect = async (profile: Profile) => {
    setError(null);
    try {
      await sessionConnect(profile.id, 80, 24);
      setConnected(profile);
      setSheetMismatch(null);
      setServerVersion(null);
      if (graceTimer.current) window.clearTimeout(graceTimer.current);
      graceTimer.current = window.setTimeout(
        () => setTiledataHint(true),
        TILEDATA_GRACE_MS,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const disconnect = async () => {
    // A tweak made a moment before quitting is still worth keeping.
    await flushDisplay();
    await sessionDisconnect().catch(() => {});
    setConnected(null);
    setShowDisplay(false);
    setTiledataHint(false);
  };

  /**
   * Applies a display change to the running game immediately, and writes it to
   * the profile once the player stops adjusting.
   */
  const changeDisplay = (settings: DisplaySettings) => {
    if (!connected) return;
    const updated = { ...connected, ...settings };
    setConnected(updated);
    setProfiles((list) => list.map((p) => (p.id === updated.id ? updated : p)));

    unsavedDisplay.current = updated;
    if (displaySaveTimer.current) window.clearTimeout(displaySaveTimer.current);
    displaySaveTimer.current = window.setTimeout(() => {
      void flushDisplay();
    }, DISPLAY_SAVE_DEBOUNCE_MS);
  };

  /** Writes any adjustment still waiting out its debounce. */
  const flushDisplay = async () => {
    const profile = unsavedDisplay.current;
    if (!profile) return;
    unsavedDisplay.current = null;
    if (displaySaveTimer.current) window.clearTimeout(displaySaveTimer.current);
    await saveProfile(profile, null).catch((e) => setError(String(e)));
  };

  const handleSave = async (profile: Profile, password: string | null) => {
    try {
      await saveProfile(profile, password);
      await refreshProfiles();
      setSelectedId(profile.id);
      setScreen({ kind: "list" });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProfile(id);
      setSelectedId(null);
      await refreshProfiles();
      setScreen({ kind: "list" });
    } catch (e) {
      setError(String(e));
    }
  };

  if (connected) {
    return (
      <div className="app app--playing">
        <header className="play-bar">
          <span className="play-bar__where">
            <Tile tileset={tileset} index={TILES.openDoor} size={14} />
            {connected.name || connected.host}
          </span>
          <span className="play-bar__status">{statusLine(status)}</span>
          <label className="play-bar__toggle">
            <input
              type="checkbox"
              checked={tilesEnabled}
              onChange={(e) => setTilesEnabled(e.target.checked)}
            />
            Tiles
          </label>
          <button
            onClick={() => setShowDisplay((open) => !open)}
            aria-pressed={showDisplay}
          >
            Display
          </button>
          <button onClick={() => void disconnect()}>Disconnect</button>
        </header>

        {tiledataHint && (
          <p className="banner">
            <span className="banner__text">
              {connected.transport === "local" ? (
                <>
                  No tiles yet. Your <code>~/.nethackrc</code> needs{" "}
                  <code>OPTIONS=vt_tiledata</code> <em>and</em>{" "}
                  <code>OPTIONS=windowtype:tty</code>. If that changes nothing,
                  this NetHack was built without <code>TTY_TILES_ESCCODES</code>
                  , which is a compile-time option most packaged builds leave
                  out — the game plays fine, just in ASCII.
                </>
              ) : (
                <>
                  No tiles yet. Your <code>.nethackrc</code> on the server needs{" "}
                  <code>OPTIONS=vt_tiledata</code> <em>and</em>{" "}
                  <code>OPTIONS=windowtype:tty</code> — tile data comes from the
                  tty interface, so <code>windowtype:curses</code> never sends
                  any. Fix it, then start a new game.
                </>
              )}
            </span>
          </p>
        )}

        {serverVersion?.warning && (
          <p className="banner banner--error">
            <span className="banner__text">{serverVersion.warning}</span>
          </p>
        )}

        {sheetMismatch !== null && (
          <p className="banner banner--error">
            <span className="banner__text">
              These tiles do not match the server. It asked for tile{" "}
              {sheetMismatch}, but{" "}
              <strong>{tileset?.manifest.name ?? "this tileset"}</strong> only
              has {tileset?.manifest.tileCount ?? 0}. Disconnect and set this
              profile's NetHack version to{" "}
              {connected.version === "v36" ? "5.0 / 3.7" : "3.6.x"}.
            </span>
          </p>
        )}

        <div className="play-area">
          <GameTerminal
            profile={connected}
            tileset={tileset}
            tilesEnabled={tilesEnabled}
            onSheetMismatch={setSheetMismatch}
          />
          {showDisplay && (
            <DisplayControls
              settings={connected}
              onChange={changeDisplay}
              onClose={() => setShowDisplay(false)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__glyphs" aria-hidden="true">
          {[
            TILES.verticalWall,
            TILES.corridor,
            TILES.littleDog,
            TILES.valkyrie,
            TILES.openDoor,
            TILES.staircaseDown,
            TILES.fountain,
            TILES.horizontalWall,
          ].map((index, i) => (
            <Tile key={i} tileset={tileset} index={index} size={24} />
          ))}
        </div>
        <h1>NetHack Tiles Client</h1>
        <p className="masthead__sub">
          Play on the public servers, with tiles. Your scores stay on their
          leaderboards.
        </p>
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          <span className="banner__text">{error}</span>
          <button className="banner__dismiss" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {screen.kind === "edit" ? (
        <ProfileForm
          profile={screen.profile}
          tilesets={tilesets}
          onSave={(p, pw) => void handleSave(p, pw)}
          onCancel={() => setScreen({ kind: "list" })}
          onDelete={screen.isNew ? null : (id) => void handleDelete(id)}
        />
      ) : (
        <main className="servers">
          <div className="servers__head">
            <h2>Servers</h2>
            <button
              onClick={() =>
                setScreen({
                  kind: "edit",
                  profile: newProfile(tilesets[0]?.id ?? ""),
                  isNew: true,
                })
              }
            >
              Add server
            </button>
          </div>

          {profiles.length === 0 ? (
            <p className="empty">
              Nothing here yet. Add <strong>nethack.alt.org</strong> or{" "}
              <strong>hardfought.org</strong>, or point a profile at a NetHack
              installed on this computer.
            </p>
          ) : (
            <ul className="server-list">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <button
                    className={`server${profile.id === selectedId ? " server--on" : ""}`}
                    onClick={() => {
                      // Selecting is also what loads this profile's tile sheet,
                      // so it has to happen even though we leave immediately.
                      setSelectedId(profile.id);
                      void connect(profile);
                    }}
                    title={`Connect to ${profile.name || profile.host}`}
                  >
                    <Tile
                      tileset={tileset}
                      index={
                        profile.id === selectedId ? TILES.openDoor : TILES.verticalWall
                      }
                      size={20}
                    />
                    <span className="server__name">
                      {profile.name || profile.host || "This computer"}
                    </span>
                    <span className="server__where">
                      {profile.transport === "local"
                        ? profile.command || "NetHack on this computer"
                        : `${profile.sshUser}@${profile.host}${
                            profile.port !== 22 ? `:${profile.port}` : ""
                          }`}
                    </span>
                    <span className="server__tag">
                      {profile.version === "v36" ? "3.6" : "5.0"}
                    </span>
                  </button>
                  <button
                    className="server__edit"
                    onClick={() => setScreen({ kind: "edit", profile, isNew: false })}
                  >
                    Edit
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="connect-row">
            <span className="connect-row__status">
              {statusLine(status) || "Click a server to connect."}
            </span>
          </div>
        </main>
      )}

      <footer className="colophon">
        <ExternalLink href={AUTHOR_URL}>by @statico</ExternalLink>
        <span aria-hidden="true"> · </span>
        <ExternalLink href={REPO_URL}>source on GitHub</ExternalLink>
      </footer>
    </div>
  );
}

/** A link that leaves the app instead of navigating the game away. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function statusLine(status: Status | null): string {
  if (!status) return "";
  switch (status.state) {
    case "connecting":
      return `Connecting to ${status.message}`;
    case "connected":
      return `Connected to ${status.message}`;
    case "info":
      return status.message;
    case "error":
      return status.message;
    case "closed":
      return status.message ? `Disconnected: ${status.message}` : "Disconnected";
  }
}
