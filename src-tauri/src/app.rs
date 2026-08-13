//! Tauri state and commands: the seam between the UI and the backend modules.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::autologin::{AutoLogin, AutoLoginState};
use crate::banner::{ServerVersion, VersionWatch};
use crate::debuglog::{file_from_env, TileDebugLog};
use crate::glyph::{GlyphFlags, NetHackVersion};
use crate::demux::{Demuxer, StreamItem, TileEvent};
use crate::local::{self, LocalConfig};
use crate::profiles::{KeyringSecrets, Profile, ProfileStore, Transport, WithLegacy};
use crate::session::{Session, SessionEvent};
use crate::ssh::{self, SshConfig};
use crate::statelog::{self, StateLogWrite};
use crate::tileset::{Tileset, TilesetManifest};

/// The tilesets shipped with the app, one per supported NetHack line.
///
/// Embedded rather than bundled as Tauri resources so that dev runs and
/// packaged builds resolve them identically. Regenerate with `tiles2png` (see
/// `README.md`).
///
/// There has to be one per version: tile indices are positional, and the two
/// releases number them differently, so a 3.6.7 sheet on a 5.0 server draws
/// the wrong picture for nearly every glyph. Index 1469 is "unexplored" on 5.0
/// and "statue of thug" on 3.6.7, which is what a whole map of the wrong
/// pairing looks like.
const BUNDLED_TILESETS: &[(&str, &[u8])] = &[
    (
        include_str!("../tiles/vanilla-3.6.7-16.json"),
        include_bytes!("../tiles/vanilla-3.6.7-16.png"),
    ),
    (
        include_str!("../tiles/vanilla-5.0.0-16.json"),
        include_bytes!("../tiles/vanilla-5.0.0-16.png"),
    ),
];

/// Event names. Namespaced so they cannot collide with Tauri's own.
pub mod events {
    /// A batch of demultiplexed [`crate::demux::StreamItem`]s.
    pub const STREAM: &str = "nh://stream";
    /// A [`super::StatusPayload`].
    pub const STATUS: &str = "nh://status";
    /// Fired once per session the first time a tile escape code arrives.
    pub const TILEDATA_SEEN: &str = "nh://tiledata-seen";
    /// A [`super::ServerVersionPayload`], once per session, when the server's
    /// startup banner names the NetHack release it runs.
    pub const SERVER_VERSION: &str = "nh://server-version";
}

/// What the server's startup banner said, and whether it agrees with the
/// profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerVersionPayload {
    /// The version as printed, e.g. `5.0.0-0`.
    pub text: String,
    /// The tile ordering it uses, or `None` if this app has no sheet for it.
    pub version: Option<NetHackVersion>,
    /// What to tell the player, or `None` if the profile was right.
    pub warning: Option<String>,
}

/// Connection state for the status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "message")]
pub enum StatusPayload {
    Connecting(String),
    Connected(String),
    /// Progress or advisory text; does not change the connected state.
    Info(String),
    Error(String),
    Closed(Option<String>),
}

/// The stream item actually sent to the UI.
///
/// Identical to [`StreamItem`] except that glyph flags arrive already decoded.
/// The `MG_*` bit layout differs between NetHack versions, and keeping that
/// table in exactly one place -- [`crate::glyph`] -- is worth the conversion.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppStreamItem {
    Text { bytes: String, prints: bool },
    Event { event: AppTileEvent },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppTileEvent {
    #[serde(rename_all = "camelCase")]
    GlyphStart {
        tile: u32,
        flags: GlyphFlags,
        /// The undecoded bitmask, for diagnostics.
        raw_flags: u32,
    },
    GlyphEnd,
    SelectWindow {
        winid: Option<i64>,
    },
    FrameSync,
    Sound {
        id: Option<i64>,
    },
}

impl AppStreamItem {
    fn from_demux(item: StreamItem, version: NetHackVersion) -> Self {
        match item {
            // Latin-1: each byte becomes the char of the same value, so the
            // frontend can reconstruct the exact bytes.
            StreamItem::Text { bytes, prints } => AppStreamItem::Text {
                bytes: bytes.iter().map(|&b| b as char).collect(),
                prints,
            },
            StreamItem::Event { event } => AppStreamItem::Event {
                event: match event {
                    TileEvent::GlyphStart { tile, flags } => AppTileEvent::GlyphStart {
                        tile,
                        flags: GlyphFlags::decode(flags, version),
                        raw_flags: flags,
                    },
                    TileEvent::GlyphEnd => AppTileEvent::GlyphEnd,
                    TileEvent::SelectWindow { winid } => AppTileEvent::SelectWindow { winid },
                    TileEvent::FrameSync => AppTileEvent::FrameSync,
                    TileEvent::Sound { id } => AppTileEvent::Sound { id },
                },
            },
        }
    }
}

/// A tileset plus its pixels, ready for the overlay canvas.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TilesetPayload {
    pub manifest: TilesetManifest,
    /// `data:image/png;base64,...`
    pub data_url: String,
}

pub struct AppState {
    profiles: Mutex<ProfileStore>,
    /// Loaded tilesets by id; the bundled one is always present.
    tilesets: Mutex<HashMap<String, Tileset>>,
    session: Mutex<Option<Session>>,
}

impl AppState {
    pub fn new() -> Result<Self, String> {
        let path = ProfileStore::default_path().map_err(|e| e.to_string())?;
        // The bundle identifier changed, which moved both the config directory
        // and the keychain service. Neither is worth making anyone set their
        // servers up again over.
        if let Ok(legacy) = ProfileStore::legacy_path() {
            if let Err(e) = ProfileStore::adopt_legacy(&path, &legacy) {
                log::warn!("could not adopt the profiles from the previous version: {e}");
            }
        }
        let secrets = WithLegacy::new(
            Box::new(KeyringSecrets::default()),
            Box::new(KeyringSecrets::legacy()),
        );
        let mut profiles =
            ProfileStore::load(path, Box::new(secrets)).map_err(|e| e.to_string())?;

        let mut tilesets = HashMap::new();
        for (manifest_json, png) in BUNDLED_TILESETS {
            let manifest: TilesetManifest =
                serde_json::from_str(manifest_json).map_err(|e| e.to_string())?;
            let id = manifest.id.clone();
            let tileset = Tileset::load(manifest, png.to_vec())
                .map_err(|e| format!("the bundled tileset {id} is unusable: {e}"))?;
            tilesets.insert(id, tileset);
        }

        // Nobody's first run should start on an empty screen: offer the two
        // public servers, already pointed at a matching tile sheet, plus this
        // machine's own NetHack if it has one.
        if profiles.is_first_run() {
            let installed = local::find();
            let local_game = installed.as_deref().map(|command| {
                // Ask the binary rather than guess: tile indices are
                // positional, so the wrong sheet draws the wrong picture for
                // nearly every glyph.
                let version = local::probe_version(command).unwrap_or_default();
                (command, version)
            });
            for mut profile in crate::profiles::default_profiles(local_game) {
                profile.tileset_id = sheet_for_version(&tilesets, profile.version);
                if let Err(e) = profiles.upsert(profile) {
                    log::warn!("could not write the default profiles: {e}");
                }
            }
        }

        Ok(AppState {
            profiles: Mutex::new(profiles),
            tilesets: Mutex::new(tilesets),
            session: Mutex::new(None),
        })
    }
}

/// Picks the bundled sheet built for `version`. Tile indices are positional
/// and renumbered between NetHack lines, so this pairing is not cosmetic.
fn sheet_for_version(tilesets: &HashMap<String, Tileset>, version: NetHackVersion) -> String {
    tilesets
        .values()
        .map(|t| t.manifest())
        .find(|m| m.version == version)
        .or_else(|| tilesets.values().map(|t| t.manifest()).next())
        .map(|m| m.id.clone())
        .unwrap_or_default()
}

type CmdResult<T> = Result<T, String>;

/// Surfaces a webview failure in the process log, where it can be read.
/// A blank window with the error trapped in the webview console is useless.
#[tauri::command]
pub fn log_frontend_error(message: String) {
    eprintln!("[frontend] {message}");
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> CmdResult<Vec<Profile>> {
    Ok(state.profiles.lock().unwrap().profiles().to_vec())
}

#[tauri::command]
pub fn last_used_profile(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    Ok(state
        .profiles
        .lock()
        .unwrap()
        .last_used()
        .map(str::to_string))
}

/// Saves a profile. `password` is stored in the OS keychain, never in the
/// config file; passing `None` leaves any existing password untouched.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: Profile,
    password: Option<String>,
) -> CmdResult<()> {
    let mut store = state.profiles.lock().unwrap();
    let id = profile.id.clone();
    store.upsert(profile).map_err(|e| e.to_string())?;
    if let Some(password) = password {
        store.set_password(&id, &password).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .profiles
        .lock()
        .unwrap()
        .remove(&id)
        .map_err(|e| e.to_string())
}

/// Whether a password is on file, so the UI can show "saved" without ever
/// reading the secret back into the webview.
#[tauri::command]
pub fn has_saved_password(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    Ok(state
        .profiles
        .lock()
        .unwrap()
        .password(&id)
        .map_err(|e| e.to_string())?
        .is_some())
}

#[tauri::command]
pub fn list_tilesets(state: State<'_, AppState>) -> CmdResult<Vec<TilesetManifest>> {
    let tilesets = state.tilesets.lock().unwrap();
    let mut manifests: Vec<_> = tilesets.values().map(|t| t.manifest().clone()).collect();
    manifests.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(manifests)
}

#[tauri::command]
pub fn get_tileset(state: State<'_, AppState>, id: String) -> CmdResult<TilesetPayload> {
    let tilesets = state.tilesets.lock().unwrap();
    let tileset = tilesets
        .get(&id)
        .ok_or_else(|| format!("no tileset with id {id:?}"))?;
    Ok(TilesetPayload {
        manifest: tileset.manifest().clone(),
        data_url: tileset.data_url(),
    })
}

/// Loads a user-supplied sheet. The manifest describes its geometry; get it
/// wrong and tiles come out sheared, so the loader validates the dimensions.
#[tauri::command]
pub fn add_custom_tileset(
    state: State<'_, AppState>,
    manifest: TilesetManifest,
    path: String,
) -> CmdResult<TilesetPayload> {
    let png = std::fs::read(&path).map_err(|e| format!("reading {path}: {e}"))?;
    let tileset = Tileset::load(manifest, png).map_err(|e| e.to_string())?;
    let payload = TilesetPayload {
        manifest: tileset.manifest().clone(),
        data_url: tileset.data_url(),
    };
    state
        .tilesets
        .lock()
        .unwrap()
        .insert(tileset.manifest().id.clone(), tileset);
    Ok(payload)
}

/// Parameters the UI controls per connection attempt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[tauri::command]
pub async fn session_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> CmdResult<()> {
    // Gather everything we need under the lock, then release it: the connect
    // below is async and must not hold a std::sync::Mutex across an await.
    let (profile, password) = {
        let store = state.profiles.lock().unwrap();
        let profile = store
            .get(&request.profile_id)
            .ok_or_else(|| format!("no profile with id {:?}", request.profile_id))?
            .clone();
        // Read whenever there is a prompt that could want it; whether it gets
        // typed is `autologin_for`'s decision.
        let password = if profile.transport == Transport::Local {
            None
        } else {
            store.password(&profile.id).map_err(|e| e.to_string())?
        };
        (profile, password)
    };

    if state.session.lock().unwrap().is_some() {
        return Err("already connected -- disconnect first".into());
    }

    let (tx, rx) = mpsc::unbounded_channel();
    let local = profile.transport == Transport::Local;

    emit_status(
        &app,
        StatusPayload::Connecting(if local {
            describe_local(&profile)
        } else {
            format!("{}:{}", profile.host, profile.port)
        }),
    );

    let session = if local {
        start_local(&profile, request.cols, request.rows, tx)
    } else {
        let mut config = SshConfig::dgamelaunch(&profile.host, profile.port, &profile.ssh_user);
        config.cols = request.cols;
        config.rows = request.rows;
        ssh::connect(config, tx).await.map_err(|e| e.to_string())
    }
    .inspect_err(|message| emit_status(&app, StatusPayload::Error(message.clone())))?;

    let autologin = autologin_for(&profile, password);

    *state.session.lock().unwrap() = Some(session.clone());
    emit_status(
        &app,
        StatusPayload::Connected(if local {
            describe_local(&profile)
        } else {
            profile.host.clone()
        }),
    );

    let tile_count = state
        .tilesets
        .lock()
        .unwrap()
        .get(&profile.tileset_id)
        .map(|t| t.manifest().tile_count)
        .unwrap_or(0);

    tauri::async_runtime::spawn(consume_session(
        app,
        rx,
        session,
        autologin,
        profile.version,
        tile_count,
    ));

    if let Ok(mut store) = state.profiles.lock() {
        let _ = store.set_last_used(&profile.id);
    }

    if profile.state_log_enabled && !profile.state_log_directory.is_empty() {
        let dir = std::path::Path::new(&profile.state_log_directory);
        if let Err(e) = statelog::clear(dir) {
            log::warn!("could not clear the state log at {}: {e}", dir.display());
        }
    }

    Ok(())
}

/// Starts the NetHack installed on this machine.
///
/// An empty `command` means "whatever is installed now", resolved at connect
/// time rather than stored, so the profile does not go stale when NetHack is
/// upgraded, moved, or installed after the profile was written.
fn start_local(
    profile: &Profile,
    cols: u32,
    rows: u32,
    events: mpsc::UnboundedSender<SessionEvent>,
) -> Result<Session, String> {
    let command = if profile.command.is_empty() {
        local::find().ok_or_else(|| local::LocalError::NotFound.to_string())?
    } else {
        profile.command.clone().into()
    };

    let mut config = LocalConfig::new(command);
    config.cols = cols as u16;
    config.rows = rows as u16;
    local::spawn(config, events).map_err(|e| e.to_string())
}

/// What to call a local game in the status bar.
fn describe_local(profile: &Profile) -> String {
    if profile.command.is_empty() {
        "NetHack on this computer".into()
    } else {
        profile.command.clone()
    }
}

/// Owns the demuxer and auto-login machine for one session's lifetime.
async fn consume_session(
    app: AppHandle,
    mut events: mpsc::UnboundedReceiver<SessionEvent>,
    session: Session,
    mut autologin: Option<AutoLogin>,
    version: NetHackVersion,
    tile_count: u32,
) {
    let mut demuxer = Demuxer::new();
    let mut announced_tiledata = false;
    // The profile only records which release the player expects. One host can
    // serve several, so take the server's own word for it. See banner.rs.
    let mut version_watch = VersionWatch::new();

    // Diagnostics, off unless the environment asks for them. See debuglog.rs.
    let mut debug = file_from_env("NHTILES_LOG").map(|f| TileDebugLog::new(f, tile_count));
    let mut raw = file_from_env("NHTILES_RAW");

    while let Some(event) = events.recv().await {
        match event {
            SessionEvent::Data(bytes) => {
                if let Some(raw) = raw.as_mut() {
                    use std::io::Write;
                    let _ = raw.write_all(&bytes);
                    let _ = raw.flush();
                }

                if version_watch.wants_output() {
                    let text: String = bytes.iter().map(|&b| b as char).collect();
                    if let Some(found) = version_watch.observe(&text) {
                        let warning = version_warning(&found, version);
                        if let Some(warning) = warning.as_deref() {
                            log::warn!("{warning}");
                        }
                        let _ = app.emit(
                            events::SERVER_VERSION,
                            &ServerVersionPayload {
                                text: found.text,
                                version: found.version,
                                warning,
                            },
                        );
                    }
                }

                if let Some(login) = autologin.as_mut() {
                    // Only the plain text matters here, and only until the
                    // credentials are in.
                    let text: String = bytes.iter().map(|&b| b as char).collect();
                    if let Some(reply) = login.observe(&text) {
                        let _ = session.write(reply);
                    }
                    // Say which login this is about: the status bar has
                    // already reported the *SSH* connection, and the two are
                    // different accounts entirely.
                    let outcome = match login.state() {
                        AutoLoginState::Failed(reason) => Some(StatusPayload::Error(reason.clone())),
                        AutoLoginState::LoggedIn => Some(StatusPayload::Info(format!(
                            "Logged in to the game server as {}",
                            login.username()
                        ))),
                        _ => None,
                    };
                    if let Some(status) = outcome {
                        emit_status(&app, status);
                        autologin = None;
                    } else if !login.wants_output() {
                        autologin = None;
                    }
                }

                let decoded = demuxer.feed(&bytes);
                if let Some(debug) = debug.as_mut() {
                    debug.observe(&decoded);
                }
                let items: Vec<_> = decoded
                    .into_iter()
                    .map(|item| AppStreamItem::from_demux(item, version))
                    .collect();
                if !items.is_empty() {
                    let _ = app.emit(events::STREAM, &items);
                }
                if !announced_tiledata && demuxer.saw_tile_data() {
                    announced_tiledata = true;
                    let _ = app.emit(events::TILEDATA_SEEN, ());
                }
            }
            SessionEvent::Status(message) => emit_status(&app, StatusPayload::Info(message)),
            SessionEvent::Closed { reason } => {
                if let Some(debug) = debug.as_mut() {
                    debug.summarize();
                }
                emit_status(&app, StatusPayload::Closed(reason));
                break;
            }
        }
    }

    if let Some(debug) = debug.as_mut() {
        debug.summarize();
    }
    if let Some(state) = app.try_state::<AppState>() {
        *state.session.lock().unwrap() = None;
    }
}

/// Sends keystrokes. `data` is a UTF-8 string from xterm.js `onData`.
#[tauri::command]
pub fn session_write(state: State<'_, AppState>, data: String) -> CmdResult<()> {
    with_session(&state, |s| s.write(data.into_bytes()))
}

/// Sends raw bytes.
///
/// NetHack's meta commands are a single byte with the eighth bit set, which
/// no UTF-8 string can carry: encoding U+00EC would put two bytes on the wire
/// and the server would see garbage instead of `M-l`.
#[tauri::command]
pub fn session_write_bytes(state: State<'_, AppState>, bytes: Vec<u8>) -> CmdResult<()> {
    with_session(&state, |s| s.write(bytes))
}

#[tauri::command]
pub fn session_resize(state: State<'_, AppState>, cols: u32, rows: u32) -> CmdResult<()> {
    with_session(&state, |s| s.resize(cols, rows))
}

#[tauri::command]
pub fn session_disconnect(state: State<'_, AppState>) -> CmdResult<()> {
    let session = state.session.lock().unwrap().take();
    match session {
        Some(s) => s.disconnect().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Replaces files in the profile's state-log directory. Unknown names are
/// refused by [`statelog`].
#[tauri::command]
pub fn state_log_write(request: StateLogWrite) -> CmdResult<()> {
    let dir = std::path::Path::new(&request.directory);
    statelog::write_files(dir, &request.files).map_err(|e| e.to_string())
}

fn with_session<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Session) -> Result<T, crate::session::Disconnected>,
) -> CmdResult<T> {
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or("not connected")?;
    f(session).map_err(|e| e.to_string())
}

fn emit_status(app: &AppHandle, status: StatusPayload) {
    let _ = app.emit(events::STATUS, status);
}

/// Demultiplexed items are emitted as a batch.
pub type StreamBatch = Vec<AppStreamItem>;

/// The warning to show when the server is not the release the profile expects.
///
/// One host can serve several releases: Hardfought's menu offers 3.4.3, 3.6.7
/// and 5.0.0 behind a single SSH host. The profile holds a guess, and the
/// startup banner holds the truth. Returns `None` when they agree.
fn version_warning(found: &ServerVersion, profile: NetHackVersion) -> Option<String> {
    if found.version == Some(profile) {
        return None;
    }
    let expected = version_name(profile);
    Some(match found.version {
        Some(actual) => format!(
            "This server runs NetHack {}, but this profile is set to {expected}. \
             Tiles will be wrong. Disconnect, then set the profile's NetHack \
             version to {}.",
            found.text,
            version_name(actual)
        ),
        // Naming the release is the useful half even with no sheet to offer.
        // It says why the tiles look wrong, which stops the player looking for
        // a setting that would put them right.
        None => format!(
            "This server runs NetHack {}, which this app has no tile sheet for. \
             Tiles will be wrong. Turn tiles off, or start a {expected} game on \
             this server.",
            found.text
        ),
    })
}

fn version_name(version: NetHackVersion) -> &'static str {
    match version {
        NetHackVersion::V36 => "NetHack 3.6",
        NetHackVersion::V50 => "NetHack 5.0 / 3.7",
    }
}

/// Decides whether to answer the dgamelaunch login prompt for a profile.
///
/// A saved password is never held back: a player who typed one in wants it
/// used, and the alternative is watching the app stop at a prompt it could
/// have answered. Both halves have to be known, because the name is typed
/// first and a password sent in its place appears on screen in clear text.
fn autologin_for(profile: &Profile, password: Option<String>) -> Option<AutoLogin> {
    // A local game is already "logged in" as whoever is at the keyboard.
    if profile.transport == Transport::Local || profile.game_user.is_empty() {
        return None;
    }
    Some(AutoLogin::new(profile.game_user.clone(), password?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(game_user: &str) -> Profile {
        Profile {
            host: "nethack.alt.org".into(),
            ssh_user: "nethack".into(),
            game_user: game_user.into(),
            ..Profile::new("nao", "NAO")
        }
    }

    #[test]
    fn a_saved_login_is_typed_at_the_prompt() {
        let login = autologin_for(&server("username"), Some("hunter2".into()));
        assert!(login.is_some());
    }

    #[test]
    fn a_local_game_has_no_prompt_to_answer() {
        let mut profile = server("username");
        profile.transport = Transport::Local;
        assert!(autologin_for(&profile, Some("hunter2".into())).is_none());
    }

    #[test]
    fn without_a_saved_password_the_player_types_it() {
        assert!(autologin_for(&server("username"), None).is_none());
    }

    fn found(text: &str, version: Option<NetHackVersion>) -> ServerVersion {
        ServerVersion {
            text: text.into(),
            version,
        }
    }

    #[test]
    fn a_server_running_the_release_the_profile_expects_says_nothing() {
        let warning = version_warning(&found("3.6.7", Some(NetHackVersion::V36)), NetHackVersion::V36);
        assert_eq!(warning, None);
    }

    #[test]
    fn a_5_0_server_under_a_3_6_profile_is_reported() {
        // The case this exists for: Hardfought serves 3.6.7 and 5.0.0 from one
        // host, and the wrong pairing draws a statue of a thug for every
        // unexplored square.
        let warning = version_warning(&found("5.0.0-0", Some(NetHackVersion::V50)), NetHackVersion::V36)
            .expect("a mismatch must be reported");
        assert!(warning.contains("5.0.0-0"), "{warning}");
        assert!(warning.contains("3.6"), "{warning}");
    }

    #[test]
    fn the_warning_says_which_setting_to_change() {
        // A warning with no next step just tells the player something is
        // broken.
        let warning = version_warning(&found("5.0.0-0", Some(NetHackVersion::V50)), NetHackVersion::V36)
            .expect("a mismatch must be reported");
        assert!(warning.contains("version"), "{warning}");
    }

    #[test]
    fn a_release_with_no_sheet_is_named_rather_than_guessed_at() {
        let warning = version_warning(&found("3.4.3", None), NetHackVersion::V36)
            .expect("an unsupported release must be reported");
        assert!(warning.contains("3.4.3"), "{warning}");
        // It must not claim a sheet would fix it, because none would.
        assert!(!warning.contains("5.0"), "{warning}");
    }

    #[test]
    fn a_password_without_a_username_answers_nothing() {
        // Sending a password to the menu that asks for a name would type the
        // secret where the screen shows it.
        assert!(autologin_for(&server(""), Some("hunter2".into())).is_none());
    }
}
