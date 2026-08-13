import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Profile, TilesetManifest } from "../lib/protocol";
import { hasSavedPassword } from "../lib/tauri";

interface Props {
  profile: Profile;
  tilesets: TilesetManifest[];
  onSave: (profile: Profile, password: string | null) => void;
  onCancel: () => void;
  onDelete: ((id: string) => void) | null;
}

export function ProfileForm({ profile, tilesets, onSave, onCancel, onDelete }: Props) {
  const [draft, setDraft] = useState(profile);
  const [password, setPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    setDraft(profile);
    setPassword("");
    hasSavedPassword(profile.id).then(setPasswordSaved).catch(() => setPasswordSaved(false));
  }, [profile]);

  const set = <K extends keyof Profile>(field: K, value: Profile[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));

  /**
   * Changing the server's NetHack version moves every tile index, so follow
   * it with a sheet built for that version when one is bundled.
   */
  const setVersion = (version: Profile["version"]) =>
    setDraft((d) => {
      const match = tilesets.find((t) => t.version === version);
      return { ...d, version, tilesetId: match?.id ?? d.tilesetId };
    });

  const chosenTileset = tilesets.find((t) => t.id === draft.tilesetId);
  const versionMismatch =
    chosenTileset !== undefined && chosenTileset.version !== draft.version;
  const isLocal = draft.transport === "local";

  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft, password === "" ? null : password);
      }}
    >
      <fieldset>
        <legend>{isLocal ? "This computer" : "Server"}</legend>
        <label>
          <span>Name</span>
          <input
            required
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={isLocal ? "This computer" : "nethack.alt.org"}
          />
        </label>
        <label>
          <span>Where the game runs</span>
          <select
            value={draft.transport}
            onChange={(e) => set("transport", e.target.value as Profile["transport"])}
          >
            <option value="ssh">A public server, over SSH</option>
            <option value="local">NetHack installed on this computer</option>
          </select>
        </label>

        {isLocal ? (
          <>
            <div className="row">
              <label className="grow">
                <span>Command</span>
                <input
                  value={draft.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="Leave empty to find NetHack automatically"
                  spellCheck={false}
                />
              </label>
              <label className="grow">
                <span>NetHack version</span>
                <select
                  value={draft.version}
                  onChange={(e) => setVersion(e.target.value as Profile["version"])}
                >
                  <option value="v36">3.6.x</option>
                  <option value="v50">5.0 / 3.7</option>
                </select>
              </label>
            </div>
            <p className="hint">
              Tiles are a compile-time option in NetHack, and most packaged
              builds are made without it. Such a build plays fine here, in
              ASCII — it just never sends any tile data.
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <label className="grow">
                <span>Host</span>
                <input
                  required
                  value={draft.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="nethack.alt.org"
                />
              </label>
              <label className="narrow">
                <span>Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => set("port", Number(e.target.value))}
                />
              </label>
            </div>
            <div className="row">
              <label className="grow">
                <span>SSH user</span>
                <input
                  required
                  value={draft.sshUser}
                  onChange={(e) => set("sshUser", e.target.value)}
                  placeholder="nethack"
                />
              </label>
              <label className="grow">
                <span>NetHack version</span>
                <select
                  value={draft.version}
                  onChange={(e) => setVersion(e.target.value as Profile["version"])}
                >
                  <option value="v36">3.6.x</option>
                  <option value="v50">5.0 / 3.7</option>
                </select>
              </label>
            </div>
            <p className="hint">
              Everyone shares one SSH user on these servers. Your own account is
              the game login below.
            </p>
          </>
        )}
      </fieldset>

      {!isLocal && (
        <fieldset>
          <legend>Game account</legend>
          <label>
            <span>Username</span>
            <input
              value={draft.gameUser}
              onChange={(e) => set("gameUser", e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              placeholder={passwordSaved ? "Saved in your keychain" : "Not saved"}
            />
          </label>
          <p className="hint">
            Both are typed for you at the server's login prompt. The password
            goes to your operating system's keychain, never to the config file.
            Leave them empty to log in by hand.
          </p>
        </fieldset>
      )}

      <fieldset>
        <legend>Display</legend>
        <label>
          <span>Tileset</span>
          <select
            value={draft.tilesetId}
            onChange={(e) => set("tilesetId", e.target.value)}
          >
            {tilesets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label className="grow">
            <span>Font</span>
            <input
              value={draft.fontFamily}
              onChange={(e) => set("fontFamily", e.target.value)}
            />
          </label>
          <label className="narrow">
            <span>Size</span>
            <input
              type="number"
              min={6}
              max={72}
              value={draft.fontSize}
              onChange={(e) => set("fontSize", Number(e.target.value))}
            />
          </label>
          <label className="narrow">
            <span>Zoom</span>
            <input
              type="number"
              min={0.5}
              max={4}
              step={0.25}
              value={draft.scale}
              onChange={(e) => set("scale", Number(e.target.value))}
            />
          </label>
        </div>
        {versionMismatch && (
          <p className="hint hint--warn">
            This tileset was built for{" "}
            {chosenTileset.version === "v36" ? "NetHack 3.6" : "NetHack 5.0"}, but
            the server runs {draft.version === "v36" ? "3.6" : "5.0"}. Tile
            numbering differs between releases, so the map will show the wrong
            pictures.
          </p>
        )}
        <p className="hint">Zoom multiplies the font size; tiles follow the cell.</p>
      </fieldset>

      <fieldset>
        <legend>State log</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(draft.stateLogEnabled)}
            onChange={(e) => set("stateLogEnabled", e.target.checked)}
          />
          <span>Write game state to a folder</span>
        </label>
        <div className="row">
          <label className="grow">
            <span>Folder</span>
            <input
              readOnly
              value={draft.stateLogDirectory ?? ""}
              placeholder="Not set"
            />
          </label>
          <label>
            <span>&nbsp;</span>
            <button
              type="button"
              onClick={() => {
                void open({
                  directory: true,
                  multiple: false,
                  title: "State log folder",
                }).then((selected) => {
                  if (typeof selected === "string") set("stateLogDirectory", selected);
                }).catch(() => {
                  // Cancelled, or the dialog is missing (plain browser).
                });
              }}
            >
              Choose…
            </button>
          </label>
        </div>
        <p className="hint">
          A live dump of the screen, messages, level, inventory and dungeon
          overview, for an LLM to read. Nothing extra appears in the game.
        </p>
      </fieldset>

      <div className="form-actions">
        {onDelete && (
          <button type="button" className="danger" onClick={() => onDelete(draft.id)}>
            Delete profile
          </button>
        )}
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save profile
        </button>
      </div>
    </form>
  );
}
