//! Saved connection profiles.
//!
//! Profiles live in a TOML file under the OS config directory. Passwords
//! never appear in that file -- they go to the OS keychain, keyed by profile
//! id, behind the [`SecretStore`] trait so the store's logic stays testable
//! without touching the real keychain.
//!
//! The stored password is the **dgamelaunch account password**, not an SSH
//! credential: NAO and Hardfought accept an SSH connection as a shared game
//! user and then prompt for the game account inside the terminal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::glyph::NetHackVersion;

/// Service name under which passwords are filed in the OS keychain. Matches
/// the bundle identifier, which is how the keychain is usually read.
const KEYCHAIN_SERVICE: &str = "io.statico.nethack-tiles";

/// What the identifier used to be. Passwords filed under it are read through
/// to and copied forward; see [`WithLegacy`].
const LEGACY_KEYCHAIN_SERVICE: &str = "com.ian.nethack-tiles";

fn default_port() -> u16 {
    22
}
fn default_font_family() -> String {
    "Menlo, DejaVu Sans Mono, Consolas, monospace".to_string()
}
fn default_font_size() -> u32 {
    16
}
fn default_scale() -> f32 {
    1.0
}
fn default_line_height() -> f32 {
    1.0
}
fn default_letter_spacing() -> f32 {
    0.0
}

/// How a profile reaches its game.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// A public server over SSH, via dgamelaunch.
    #[default]
    Ssh,
    /// A NetHack installed on this machine, in a pseudo-terminal.
    Local,
}

/// One saved server connection plus its display preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Stable id; also the keychain account key.
    pub id: String,
    /// Display name in the picker.
    pub name: String,
    /// Where the game runs. Defaults to SSH so profiles written before local
    /// play existed still load.
    #[serde(default)]
    pub transport: Transport,
    /// The local NetHack to run, for [`Transport::Local`]. Empty means "look
    /// for one at connect time", so a profile does not go stale when NetHack
    /// is upgraded or moved.
    #[serde(default)]
    pub command: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// The shared SSH user the server publishes, e.g. `nethack`.
    pub ssh_user: String,
    /// The dgamelaunch account name typed at the in-terminal prompt.
    #[serde(default)]
    pub game_user: String,
    /// NetHack release the server runs; selects the glyph flag layout.
    #[serde(default)]
    pub version: NetHackVersion,
    /// Id of the tileset to render with.
    pub tileset_id: String,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_scale")]
    pub scale: f32,
    /// Cell height as a multiple of the font size. A tile is drawn to fill its
    /// terminal cell, so this is how tall the tiles are.
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    /// Extra pixels of cell width. Terminal cells are far narrower than they
    /// are tall, which squashes a square tile; this is how the player widens
    /// them back out.
    #[serde(default = "default_letter_spacing")]
    pub letter_spacing: f32,
    /// Draw tiles at a whole-number multiple of their native pixel size,
    /// centred in the cell, rather than stretched to fill it.
    #[serde(default)]
    pub pixel_perfect: bool,
    /// Write live game-state snapshots for an LLM to read.
    #[serde(default)]
    pub state_log_enabled: bool,
    /// Directory those snapshots go in. Empty means "not set".
    #[serde(default)]
    pub state_log_directory: String,
}

impl Profile {
    /// A new profile with sensible defaults for `name`.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Profile {
            id: id.into(),
            name: name.into(),
            transport: Transport::default(),
            command: String::new(),
            host: String::new(),
            port: default_port(),
            ssh_user: String::new(),
            game_user: String::new(),
            version: NetHackVersion::default(),
            tileset_id: String::new(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            scale: default_scale(),
            line_height: default_line_height(),
            letter_spacing: default_letter_spacing(),
            pixel_perfect: false,
            state_log_enabled: false,
            state_log_directory: String::new(),
        }
    }
}

/// The games to offer someone who has never used the app before.
///
/// `local` is the NetHack found on this machine, if any, with the release it
/// reported; a local game is only offered when there is one to run. The public
/// servers come first: their leaderboards are the point of the app, and a
/// local game keeps no score anyone else can see.
///
/// `tileset_id` is left empty deliberately: which sheet matches a NetHack
/// version is the tileset registry's business, and the caller fills it in.
pub fn default_profiles(local: Option<(&Path, NetHackVersion)>) -> Vec<Profile> {
    let mut profiles = vec![
        Profile {
            // NAO's play menu currently offers 5.0.0 and nothing else.
            host: "nethack.alt.org".into(),
            ssh_user: "nethack".into(),
            version: NetHackVersion::V50,
            ..Profile::new("nethack-alt-org", "NetHack.alt.org")
        },
        Profile {
            // Hardfought's SSH is on regional hosts, not on the bare domain:
            // that one is the website, behind Cloudflare, which does not
            // proxy port 22. `eu.` and `au.` work identically; accounts are
            // registered on the US host and sync to the others.
            host: "us.hardfought.org".into(),
            ssh_user: "nethack".into(),
            version: NetHackVersion::V36,
            ..Profile::new("hardfought-org", "Hardfought (US)")
        },
    ];

    if let Some((command, version)) = local {
        profiles.push(Profile {
            transport: Transport::Local,
            command: command.display().to_string(),
            version,
            ..Profile::new("local-nethack", "This computer")
        });
    }

    profiles
}

/// Saved hosts that cannot work, and what they should have been.
///
/// `hardfought.org` shipped as a default in an earlier build. It is the
/// website, served through Cloudflare, which does not proxy port 22 -- so it
/// resolves but never accepts SSH. Anyone who ran that build has it saved,
/// and leaving them to discover and edit it themselves is not a fix.
const HOST_REPAIRS: &[(&str, &str)] = &[("hardfought.org", "us.hardfought.org")];

/// The on-disk document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDocument {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// Id of the profile to preselect on launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("reading {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("writing {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not valid profile TOML: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("serializing profiles: {0}")]
    Serialize(#[from] toml::ser::Error),
    #[error("no profile with id {0:?}")]
    NoSuchProfile(String),
    #[error("could not locate an OS config directory")]
    NoConfigDir,
    #[error("keychain: {0}")]
    Secret(String),
}

/// Somewhere to keep passwords that is not the config file.
pub trait SecretStore: std::fmt::Debug + Send + Sync {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), ProfileError>;
    fn get_password(&self, profile_id: &str) -> Result<Option<String>, ProfileError>;
    fn delete_password(&self, profile_id: &str) -> Result<(), ProfileError>;
}

/// The real OS keychain (Keychain / Credential Manager / Secret Service).
#[derive(Debug)]
pub struct KeyringSecrets {
    service: &'static str,
}

impl Default for KeyringSecrets {
    fn default() -> Self {
        Self {
            service: KEYCHAIN_SERVICE,
        }
    }
}

impl KeyringSecrets {
    /// The store the previous bundle identifier wrote to.
    pub fn legacy() -> Self {
        Self {
            service: LEGACY_KEYCHAIN_SERVICE,
        }
    }

    fn entry(&self, profile_id: &str) -> Result<keyring::Entry, ProfileError> {
        keyring::Entry::new(self.service, profile_id)
            .map_err(|e| ProfileError::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringSecrets {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), ProfileError> {
        self.entry(profile_id)?
            .set_password(password)
            .map_err(|e| ProfileError::Secret(e.to_string()))
    }

    fn get_password(&self, profile_id: &str) -> Result<Option<String>, ProfileError> {
        match self.entry(profile_id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(ProfileError::Secret(e.to_string())),
        }
    }

    fn delete_password(&self, profile_id: &str) -> Result<(), ProfileError> {
        match self.entry(profile_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(ProfileError::Secret(e.to_string())),
        }
    }
}

/// A secret store that can still see what an earlier version of the app saved.
///
/// The bundle identifier moved from `com.ian` to `io.statico`, and the
/// keychain files passwords under it. Rather than make anyone type their
/// server passwords again, a lookup that misses falls through to the old
/// service and copies what it finds forward.
#[derive(Debug)]
pub struct WithLegacy {
    primary: Box<dyn SecretStore>,
    legacy: Box<dyn SecretStore>,
}

impl WithLegacy {
    pub fn new(primary: Box<dyn SecretStore>, legacy: Box<dyn SecretStore>) -> Self {
        Self { primary, legacy }
    }
}

impl SecretStore for WithLegacy {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), ProfileError> {
        self.primary.set_password(profile_id, password)
    }

    fn get_password(&self, profile_id: &str) -> Result<Option<String>, ProfileError> {
        if let Some(password) = self.primary.get_password(profile_id)? {
            return Ok(Some(password));
        }
        let Some(password) = self.legacy.get_password(profile_id)? else {
            return Ok(None);
        };
        // Best effort: a keychain that will not take the write still leaves
        // the player logged in this time, which beats refusing to connect.
        if let Err(e) = self.primary.set_password(profile_id, &password) {
            log::warn!("could not copy {profile_id}'s password to the current keychain entry: {e}");
        }
        Ok(Some(password))
    }

    fn delete_password(&self, profile_id: &str) -> Result<(), ProfileError> {
        self.primary.delete_password(profile_id)?;
        self.legacy.delete_password(profile_id)
    }
}

/// An in-memory secret store, for tests and for running without a keychain.
#[derive(Debug, Default)]
pub struct MemorySecrets {
    entries: Arc<Mutex<HashMap<String, String>>>,
}

impl MemorySecrets {
    /// A second view of the same entries, for looking at what a store that has
    /// been handed away was told.
    pub fn clone_handle(&self) -> Self {
        Self {
            entries: Arc::clone(&self.entries),
        }
    }
}

impl SecretStore for MemorySecrets {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), ProfileError> {
        self.entries
            .lock()
            .unwrap()
            .insert(profile_id.to_string(), password.to_string());
        Ok(())
    }

    fn get_password(&self, profile_id: &str) -> Result<Option<String>, ProfileError> {
        Ok(self.entries.lock().unwrap().get(profile_id).cloned())
    }

    fn delete_password(&self, profile_id: &str) -> Result<(), ProfileError> {
        self.entries.lock().unwrap().remove(profile_id);
        Ok(())
    }
}

/// Profiles on disk plus the secret store their passwords live in.
#[derive(Debug)]
pub struct ProfileStore {
    path: PathBuf,
    doc: ProfileDocument,
    secrets: Box<dyn SecretStore>,
    /// True when there was no config file at all, i.e. a first run. Distinct
    /// from "no profiles": someone who has deleted every profile has still
    /// expressed a preference, and should not have defaults handed back.
    first_run: bool,
}

impl ProfileStore {
    /// The config file location, under the app's bundle identifier.
    pub fn default_path() -> Result<PathBuf, ProfileError> {
        Self::path_under("io", "statico")
    }

    /// Where the config file lived under the previous bundle identifier.
    pub fn legacy_path() -> Result<PathBuf, ProfileError> {
        Self::path_under("com", "ian")
    }

    fn path_under(qualifier: &str, organization: &str) -> Result<PathBuf, ProfileError> {
        let dirs = directories::ProjectDirs::from(qualifier, organization, "nethack-tiles")
            .ok_or(ProfileError::NoConfigDir)?;
        Ok(dirs.config_dir().join("profiles.toml"))
    }

    /// Copies profiles saved under the old bundle identifier into the current
    /// location, once, if nothing is saved there yet.
    ///
    /// A copy rather than a move: if this version turns out to be a mistake,
    /// the previous one still finds its own file where it left it.
    pub fn adopt_legacy(current: &Path, legacy: &Path) -> Result<(), ProfileError> {
        if current.exists() || !legacy.exists() {
            return Ok(());
        }
        if let Some(parent) = current.parent() {
            std::fs::create_dir_all(parent).map_err(|source| ProfileError::Write {
                path: current.to_path_buf(),
                source,
            })?;
        }
        std::fs::copy(legacy, current).map_err(|source| ProfileError::Write {
            path: current.to_path_buf(),
            source,
        })?;
        log::info!(
            "adopted the profiles saved at {} under the previous app identifier",
            legacy.display()
        );
        Ok(())
    }

    /// Loads profiles from `path`, treating a missing file as "no profiles".
    pub fn load(
        path: impl Into<PathBuf>,
        secrets: Box<dyn SecretStore>,
    ) -> Result<Self, ProfileError> {
        let path = path.into();
        let mut first_run = false;
        let doc = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).map_err(|source| ProfileError::Parse {
                path: path.clone(),
                source,
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                first_run = true;
                ProfileDocument::default()
            }
            Err(source) => {
                return Err(ProfileError::Read {
                    path: path.clone(),
                    source,
                })
            }
        };
        let mut store = ProfileStore {
            path,
            doc,
            secrets,
            first_run,
        };
        store.repair_hosts();
        Ok(store)
    }

    /// Rewrites saved hosts that are known not to work.
    ///
    /// Only exact matches from [`HOST_REPAIRS`] are touched, so a host the
    /// player typed themselves is never second-guessed. A failed write is
    /// logged rather than returned: the repair is already applied in memory,
    /// and refusing to start over it would be a worse outcome than redoing it
    /// next launch.
    fn repair_hosts(&mut self) {
        let mut repaired = Vec::new();
        for profile in &mut self.doc.profiles {
            if let Some((_, fixed)) = HOST_REPAIRS.iter().find(|(bad, _)| profile.host == *bad) {
                repaired.push(format!("{} -> {fixed}", profile.host));
                profile.host = (*fixed).to_string();
            }
        }
        if repaired.is_empty() {
            return;
        }
        log::info!("repaired unreachable profile hosts: {}", repaired.join(", "));
        if let Err(e) = self.save() {
            log::warn!("could not write the repaired hosts back: {e}");
        }
    }

    /// True when no config file existed, so nothing has been chosen yet.
    pub fn is_first_run(&self) -> bool {
        self.first_run
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn profiles(&self) -> &[Profile] {
        &self.doc.profiles
    }

    pub fn last_used(&self) -> Option<&str> {
        self.doc.last_used.as_deref()
    }

    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.doc.profiles.iter().find(|p| p.id == id)
    }

    /// Inserts `profile`, replacing any existing profile with the same id.
    pub fn upsert(&mut self, profile: Profile) -> Result<(), ProfileError> {
        match self.doc.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile,
            None => self.doc.profiles.push(profile),
        }
        self.save()
    }

    /// Removes a profile and its stored password.
    pub fn remove(&mut self, id: &str) -> Result<(), ProfileError> {
        let before = self.doc.profiles.len();
        self.doc.profiles.retain(|p| p.id != id);
        if self.doc.profiles.len() == before {
            return Err(ProfileError::NoSuchProfile(id.to_string()));
        }
        if self.doc.last_used.as_deref() == Some(id) {
            self.doc.last_used = None;
        }
        self.secrets.delete_password(id)?;
        self.save()
    }

    /// Records `id` as the profile to preselect next launch.
    pub fn set_last_used(&mut self, id: &str) -> Result<(), ProfileError> {
        if self.get(id).is_none() {
            return Err(ProfileError::NoSuchProfile(id.to_string()));
        }
        self.doc.last_used = Some(id.to_string());
        self.save()
    }

    pub fn set_password(&self, id: &str, password: &str) -> Result<(), ProfileError> {
        self.secrets.set_password(id, password)
    }

    pub fn password(&self, id: &str) -> Result<Option<String>, ProfileError> {
        self.secrets.get_password(id)
    }

    /// Writes the document to disk, creating parent directories as needed.
    fn save(&self) -> Result<(), ProfileError> {
        let text = toml::to_string_pretty(&self.doc)?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| ProfileError::Write {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        std::fs::write(&self.path, text).map_err(|source| ProfileError::Write {
            path: self.path.clone(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: TempDir,
        path: PathBuf,
    }

    /// Minimal scoped temp directory; avoids a dev-dependency just for this.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "nethack-tiles-test-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).expect("temp dir");
            TempDir(base)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(tag: &str) -> Fixture {
        let dir = TempDir::new(tag);
        // Deliberately nested: the store must create missing parents.
        let path = dir.0.join("config").join("profiles.toml");
        Fixture { _dir: dir, path }
    }

    fn store(path: &Path) -> ProfileStore {
        ProfileStore::load(path, Box::new(MemorySecrets::default())).expect("load")
    }

    fn sample() -> Profile {
        Profile {
            host: "nethack.alt.org".into(),
            ssh_user: "nethack".into(),
            game_user: "username".into(),
            tileset_id: "vanilla-3.6.7-16".into(),
            ..Profile::new("nao", "NetHack.alt.org")
        }
    }

    #[test]
    fn a_missing_file_loads_as_an_empty_store() {
        let f = fixture("missing");
        let s = store(&f.path);
        assert!(s.profiles().is_empty());
        assert_eq!(s.last_used(), None);
    }

    #[test]
    fn a_first_run_is_told_apart_from_a_deliberately_emptied_store() {
        let f = fixture("firstrun");
        assert!(store(&f.path).is_first_run());

        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.remove("nao").unwrap();

        let reloaded = store(&f.path);
        assert!(reloaded.profiles().is_empty());
        assert!(
            !reloaded.is_first_run(),
            "a file exists, so the empty list is a choice"
        );
    }

    #[test]
    fn the_default_profiles_are_the_two_public_servers() {
        let hosts: Vec<_> = default_profiles(None)
            .iter()
            .map(|p| p.host.clone())
            .collect();
        assert_eq!(hosts, ["nethack.alt.org", "us.hardfought.org"]);
    }

    #[test]
    fn the_default_profiles_are_ready_to_connect_to() {
        for p in default_profiles(None) {
            assert!(!p.id.is_empty(), "{p:?}");
            assert!(!p.name.is_empty(), "{p:?}");
            assert_eq!(p.ssh_user, "nethack", "the shared dgamelaunch user");
            assert_eq!(p.port, 22);
            // No credentials are invented; the player supplies those.
            assert!(p.game_user.is_empty());
        }
    }

    #[test]
    fn the_hardfought_default_is_a_host_that_answers_ssh() {
        // Bare hardfought.org is the website, behind Cloudflare, which does
        // not proxy port 22 -- so it resolves but can never accept an SSH
        // connection. Hardfought's own instructions name the regional hosts.
        let hardfought = default_profiles(None)
            .into_iter()
            .find(|p| p.host.contains("hardfought"))
            .expect("hardfought profile");
        assert_eq!(hardfought.host, "us.hardfought.org");
        assert_ne!(hardfought.host, "hardfought.org");
    }

    /// Writes a profile file with one profile on `host`.
    fn with_host(path: &Path, host: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "[[profiles]]\nid = \"hf\"\nname = \"Hardfought\"\n\
                 host = \"{host}\"\nsshUser = \"nethack\"\n\
                 tilesetId = \"vanilla-3.6.7-16\"\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn a_profile_left_pointing_at_the_hardfought_website_is_repaired() {
        // Anyone who ran an earlier build has this host saved, and it can
        // never connect -- Cloudflare does not proxy port 22. Telling them to
        // go and edit it themselves is not a fix.
        let f = fixture("hardfought-repair");
        with_host(&f.path, "hardfought.org");

        assert_eq!(store(&f.path).get("hf").unwrap().host, "us.hardfought.org");
    }

    #[test]
    fn the_repair_is_written_back_rather_than_redone_every_launch() {
        let f = fixture("hardfought-repair-persists");
        with_host(&f.path, "hardfought.org");
        let _ = store(&f.path);

        let on_disk = std::fs::read_to_string(&f.path).unwrap();
        assert!(on_disk.contains("us.hardfought.org"), "{on_disk}");
    }

    #[test]
    fn a_regional_hardfought_host_is_left_alone() {
        let f = fixture("hardfought-eu");
        with_host(&f.path, "eu.hardfought.org");

        assert_eq!(store(&f.path).get("hf").unwrap().host, "eu.hardfought.org");
    }

    #[test]
    fn an_unrelated_host_is_never_rewritten() {
        let f = fixture("host-untouched");
        with_host(&f.path, "nethack.alt.org");

        assert_eq!(store(&f.path).get("hf").unwrap().host, "nethack.alt.org");
    }

    #[test]
    fn a_first_run_writes_no_file_just_by_being_loaded() {
        // The repair must not create a config file where there was none, or
        // the next launch would no longer look like a first run.
        let f = fixture("repair-no-file");
        let _ = store(&f.path);
        assert!(!f.path.exists());
    }

    #[test]
    fn a_machine_with_nethack_installed_also_gets_a_local_profile() {
        let local = Path::new("/opt/homebrew/bin/nethack");
        let profiles = default_profiles(Some((local, NetHackVersion::V36)));

        let p = profiles
            .iter()
            .find(|p| p.transport == Transport::Local)
            .expect("a local game should be offered when one is installed");
        assert_eq!(p.command, "/opt/homebrew/bin/nethack");
        assert_eq!(p.version, NetHackVersion::V36);
    }

    #[test]
    fn a_local_profile_needs_no_host_ssh_user_or_login() {
        let local = Path::new("/usr/games/nethack");
        let profiles = default_profiles(Some((local, NetHackVersion::V50)));
        let p = profiles.iter().find(|p| p.transport == Transport::Local).unwrap();

        assert!(p.host.is_empty(), "a local game is not on a host");
        assert!(p.ssh_user.is_empty());
        assert!(p.game_user.is_empty());
    }

    #[test]
    fn the_public_servers_come_before_the_local_game() {
        // The point of the app is the public leaderboards; a local game is the
        // fallback, so it should not be what Connect does by default.
        let profiles = default_profiles(Some((Path::new("/usr/games/nethack"), NetHackVersion::V36)));
        assert_eq!(profiles[0].transport, Transport::Ssh);
        assert_eq!(profiles.last().unwrap().transport, Transport::Local);
    }

    #[test]
    fn a_profile_saved_before_local_play_existed_still_loads_as_an_ssh_one() {
        let f = fixture("transport-default");
        std::fs::create_dir_all(f.path.parent().unwrap()).unwrap();
        std::fs::write(
            &f.path,
            r#"
[[profiles]]
id = "old"
name = "Old"
host = "nethack.alt.org"
sshUser = "nethack"
tilesetId = "vanilla-3.6.7-16"
"#,
        )
        .unwrap();

        let s = store(&f.path);
        let p = s.get("old").expect("profile");
        assert_eq!(p.transport, Transport::Ssh);
        assert!(p.command.is_empty());
    }

    #[test]
    fn a_local_profile_survives_a_reload() {
        let f = fixture("local-roundtrip");
        let mut s = store(&f.path);
        let local = Profile {
            transport: Transport::Local,
            command: "/opt/homebrew/bin/nethack".into(),
            ..Profile::new("local", "This Mac")
        };
        s.upsert(local.clone()).unwrap();

        assert_eq!(store(&f.path).get("local"), Some(&local));
    }

    #[test]
    fn an_upserted_profile_survives_a_reload() {
        let f = fixture("roundtrip");
        let mut s = store(&f.path);
        s.upsert(sample()).expect("upsert");

        let reloaded = store(&f.path);
        assert_eq!(reloaded.profiles(), &[sample()]);
    }

    #[test]
    fn upsert_replaces_a_profile_with_the_same_id_instead_of_duplicating() {
        let f = fixture("replace");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.upsert(Profile {
            name: "Renamed".into(),
            ..sample()
        })
        .unwrap();

        assert_eq!(s.profiles().len(), 1);
        assert_eq!(s.profiles()[0].name, "Renamed");
    }

    #[test]
    fn upsert_preserves_the_order_of_existing_profiles() {
        let f = fixture("order");
        let mut s = store(&f.path);
        s.upsert(Profile::new("a", "A")).unwrap();
        s.upsert(Profile::new("b", "B")).unwrap();
        s.upsert(Profile::new("a", "A2")).unwrap();

        let ids: Vec<_> = s.profiles().iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn the_config_file_never_contains_the_password() {
        let f = fixture("nopassword");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.set_password("nao", "hunter2").unwrap();

        let on_disk = std::fs::read_to_string(&f.path).expect("config file");
        assert!(
            !on_disk.contains("hunter2"),
            "password leaked into the config file:\n{on_disk}"
        );
        // ...but it is still retrievable from the secret store.
        assert_eq!(s.password("nao").unwrap().as_deref(), Some("hunter2"));
    }

    #[test]
    fn removing_a_profile_also_deletes_its_password() {
        let f = fixture("remove");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.set_password("nao", "hunter2").unwrap();

        s.remove("nao").unwrap();

        assert!(s.profiles().is_empty());
        assert_eq!(s.password("nao").unwrap(), None);
        assert!(store(&f.path).profiles().is_empty());
    }

    #[test]
    fn removing_an_unknown_profile_is_an_error() {
        let f = fixture("remove-unknown");
        let mut s = store(&f.path);
        assert!(matches!(
            s.remove("ghost"),
            Err(ProfileError::NoSuchProfile(_))
        ));
    }

    #[test]
    fn removing_a_profile_clears_last_used_if_it_pointed_there() {
        let f = fixture("remove-last-used");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.set_last_used("nao").unwrap();

        s.remove("nao").unwrap();

        assert_eq!(s.last_used(), None);
    }

    #[test]
    fn last_used_survives_a_reload() {
        let f = fixture("last-used");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        s.set_last_used("nao").unwrap();

        assert_eq!(store(&f.path).last_used(), Some("nao"));
    }

    #[test]
    fn last_used_must_name_an_existing_profile() {
        let f = fixture("last-used-unknown");
        let mut s = store(&f.path);
        assert!(matches!(
            s.set_last_used("ghost"),
            Err(ProfileError::NoSuchProfile(_))
        ));
    }

    #[test]
    fn get_finds_a_profile_by_id() {
        let f = fixture("get");
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        assert_eq!(s.get("nao").map(|p| p.host.as_str()), Some("nethack.alt.org"));
        assert_eq!(s.get("ghost"), None);
    }

    #[test]
    fn malformed_toml_is_reported_with_its_path() {
        let f = fixture("malformed");
        std::fs::create_dir_all(f.path.parent().unwrap()).unwrap();
        std::fs::write(&f.path, "this is not = = toml").unwrap();

        let err = ProfileStore::load(&f.path, Box::new(MemorySecrets::default()))
            .expect_err("malformed TOML must not load silently");
        assert!(matches!(err, ProfileError::Parse { .. }), "got {err:?}");
    }

    #[test]
    fn optional_fields_fall_back_to_defaults_when_absent() {
        let f = fixture("defaults");
        std::fs::create_dir_all(f.path.parent().unwrap()).unwrap();
        std::fs::write(
            &f.path,
            r#"
[[profiles]]
id = "min"
name = "Minimal"
host = "example.org"
sshUser = "nethack"
tilesetId = "vanilla-3.6.7-16"
"#,
        )
        .unwrap();

        let s = store(&f.path);
        let p = s.get("min").expect("profile");
        assert_eq!(p.port, 22);
        assert_eq!(p.font_size, 16);
        assert_eq!(p.scale, 1.0);
        assert_eq!(p.line_height, 1.0);
        assert_eq!(p.letter_spacing, 0.0);
        assert!(!p.pixel_perfect);
        assert!(!p.state_log_enabled);
        assert!(p.state_log_directory.is_empty());
        assert_eq!(p.version, NetHackVersion::V36);
    }

    #[test]
    fn display_settings_survive_a_reload() {
        // These are tuned live while playing, so they have to stick.
        let f = fixture("display");
        let mut s = store(&f.path);
        s.upsert(Profile {
            font_size: 22,
            line_height: 1.4,
            letter_spacing: 6.5,
            pixel_perfect: true,
            ..sample()
        })
        .unwrap();

        let p = store(&f.path).get("nao").cloned().expect("profile");
        assert_eq!(p.font_size, 22);
        assert_eq!(p.line_height, 1.4);
        assert_eq!(p.letter_spacing, 6.5);
        assert!(p.pixel_perfect);
    }

    #[test]
    fn state_log_settings_survive_a_reload() {
        let f = fixture("state-log");
        let mut s = store(&f.path);
        s.upsert(Profile {
            state_log_enabled: true,
            state_log_directory: "/tmp/nh-state".into(),
            ..sample()
        })
        .unwrap();

        let p = store(&f.path).get("nao").cloned().expect("profile");
        assert!(p.state_log_enabled);
        assert_eq!(p.state_log_directory, "/tmp/nh-state");
    }

    #[test]
    fn saving_creates_missing_parent_directories() {
        let f = fixture("mkdir");
        assert!(!f.path.parent().unwrap().exists());
        let mut s = store(&f.path);
        s.upsert(sample()).unwrap();
        assert!(f.path.exists());
    }

    // The app identifier changed from com.ian to io.statico, which moves both
    // the config directory and the keychain service. Someone who was already
    // playing should not find their servers gone.

    #[test]
    fn profiles_saved_under_the_old_identifier_are_adopted() {
        let dir = TempDir::new("adopt");
        let legacy = dir.0.join("com.ian").join("profiles.toml");
        let current = dir.0.join("io.statico").join("profiles.toml");

        let mut old = store(&legacy);
        old.upsert(sample()).unwrap();

        ProfileStore::adopt_legacy(&current, &legacy).expect("adopt");

        assert_eq!(store(&current).get("nao").map(|p| p.host.clone()).as_deref(), Some("nethack.alt.org"));
        assert!(legacy.exists(), "the old file is left alone, not moved");
    }

    #[test]
    fn adopting_never_overwrites_profiles_already_saved_under_the_new_one() {
        let dir = TempDir::new("adopt-noclobber");
        let legacy = dir.0.join("com.ian").join("profiles.toml");
        let current = dir.0.join("io.statico").join("profiles.toml");

        store(&legacy).upsert(sample()).unwrap();
        let mut new = store(&current);
        new.upsert(Profile {
            host: "eu.hardfought.org".into(),
            ..Profile::new("hdf", "Hardfought")
        })
        .unwrap();

        ProfileStore::adopt_legacy(&current, &legacy).expect("adopt");

        let s = store(&current);
        assert!(s.get("hdf").is_some());
        assert!(s.get("nao").is_none(), "the legacy file overwrote the current one");
    }

    #[test]
    fn adopting_with_nothing_to_adopt_is_not_an_error() {
        let dir = TempDir::new("adopt-empty");
        let legacy = dir.0.join("com.ian").join("profiles.toml");
        let current = dir.0.join("io.statico").join("profiles.toml");

        ProfileStore::adopt_legacy(&current, &legacy).expect("adopt");

        assert!(!current.exists(), "a file was invented out of nothing");
    }

    #[test]
    fn a_password_from_the_old_keychain_service_is_still_found() {
        let legacy = Box::new(MemorySecrets::default());
        legacy.set_password("nao", "hunter2").unwrap();
        let secrets = WithLegacy::new(Box::new(MemorySecrets::default()), legacy);

        assert_eq!(secrets.get_password("nao").unwrap().as_deref(), Some("hunter2"));
    }

    #[test]
    fn a_password_found_in_the_old_service_is_copied_to_the_new_one() {
        // Otherwise every launch reads through to a service the app has
        // otherwise stopped using, and uninstalling the old app loses it.
        let legacy = Box::new(MemorySecrets::default());
        legacy.set_password("nao", "hunter2").unwrap();
        let primary = Box::new(MemorySecrets::default());
        let seen = primary.clone_handle();
        let secrets = WithLegacy::new(primary, legacy);

        secrets.get_password("nao").unwrap();

        assert_eq!(seen.get_password("nao").unwrap().as_deref(), Some("hunter2"));
    }

    #[test]
    fn the_new_service_wins_when_both_have_a_password() {
        let legacy = Box::new(MemorySecrets::default());
        legacy.set_password("nao", "old").unwrap();
        let primary = Box::new(MemorySecrets::default());
        primary.set_password("nao", "new").unwrap();
        let secrets = WithLegacy::new(primary, legacy);

        assert_eq!(secrets.get_password("nao").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn deleting_a_password_clears_it_from_both_services() {
        let legacy = Box::new(MemorySecrets::default());
        legacy.set_password("nao", "hunter2").unwrap();
        let seen = legacy.clone_handle();
        let secrets = WithLegacy::new(Box::new(MemorySecrets::default()), legacy);

        secrets.delete_password("nao").unwrap();

        assert_eq!(seen.get_password("nao").unwrap(), None);
    }
}
