//! Updates of the desktop app from the project's GitHub Releases.
//!
//! The manifest address and the public key come from `plugins.updater` in `tauri.conf.json`, never from the page.
//! The plugin downloads the installer named in the manifest, checks its minisign signature against that key and,
//! with `requireSignedVersion`, that the signature was made for the announced version (an old installer cannot be
//! passed off as a new one). Only a newer version is offered.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// The manifest is a few hundred bytes: a slow answer means a bad network, and the check gives up rather than hang.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// Long enough for the installer over a slow mobile hotspot, short enough that a stalled download ends in an error.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// One progress message per this many bytes: a message per network chunk would only keep the page busy.
const PROGRESS_STEP: u64 = 256 * 1024;

/// The update found by the last check, so that installing fetches exactly the version the page showed.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Checked {
    /// The build carries no public key, so it could not verify an installer and does not look for one.
    Off { current: String },
    Latest { current: String },
    Available { current: String, version: String },
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Progress {
    Started { total: Option<u64> },
    Received { received: u64, total: Option<u64> },
    /// The installer starts and closes the app; the installer opens it again when it is done.
    Installing,
}

fn has_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Asked once at start, without network: a build without the key keeps the update card hidden.
#[tauri::command]
pub fn update_enabled(app: AppHandle) -> bool {
    has_key(&app)
}

/// What the page tells the user: `signature` (the file is not what the key signed), `network`, `manifest` (a broken
/// `latest.json`) or `error` (anything else). The page shows its own text for each; the plugin's wording stays here.
fn reason(error: Error) -> String {
    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => "signature",
        // The plugin parses the body with reqwest, so a `latest.json` that is not JSON arrives as a reqwest error. Only a
        // JSON error inside it means a broken manifest: a dropped connection mid-body is a decode error too.
        Error::Reqwest(e) if is_json(&e) => "manifest",
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => "network",
        Error::Serialization(_) | Error::Semver(_) | Error::UrlParse(_) => "manifest",
        _ => "error",
    }
    .to_string()
}

fn is_json(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut cause = error.source();
    while let Some(inner) = cause {
        if inner.is::<serde_json::Error>() {
            return true;
        }
        cause = inner.source();
    }
    false
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Checked, String> {
    let current = app.package_info().version.to_string();
    if !has_key(&app) {
        return Ok(Checked::Off { current });
    }
    let found = match app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(reason)?.check().await {
        Ok(found) => found,
        // A release without a Windows file: nothing to install. (A 404 is not here: the plugin reports every status that is
        // not 2xx as ReleaseNotFound, so a 503 or a rate limit would pass for "up to date" and wait a day. It shows as `network`.)
        Err(Error::TargetNotFound(_) | Error::TargetsNotFound(_)) => None,
        Err(e) => return Err(reason(e)),
    };
    let checked = match &found {
        Some(update) => Checked::Available { current, version: update.version.clone() },
        None => Checked::Latest { current },
    };
    *pending.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = found.map(|mut update| {
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        update
    });
    Ok(checked)
}

/// Downloads, verifies and runs the installer. On Windows the plugin ends this process to let the installer replace it,
/// so a successful call does not return. A failed one leaves nothing pending: the page checks again before retrying.
#[tauri::command]
pub async fn update_install(pending: State<'_, Pending>, on_event: Channel<Progress>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
        .ok_or_else(|| "error".to_string())?;
    let mut received = 0u64;
    let mut reported = 0u64;
    let mut started = false;
    update
        .download_and_install(
            |chunk, total| {
                if !started {
                    started = true;
                    let _ = on_event.send(Progress::Started { total });
                }
                received += chunk as u64;
                if received - reported >= PROGRESS_STEP || total == Some(received) {
                    reported = received;
                    let _ = on_event.send(Progress::Received { received, total });
                }
            },
            || {
                let _ = on_event.send(Progress::Installing);
            },
        )
        .await
        .map_err(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejected_installer_is_not_reported_as_a_network_problem() {
        let mismatch = Error::SignedVersionMismatch { signed: "0.1.0".into(), announced: "0.2.0".into() };
        assert_eq!(reason(mismatch), "signature");
        assert_eq!(reason(Error::MissingSignedVersion), "signature");
        assert_eq!(reason(Error::Network("timed out".into())), "network");
        assert_eq!(reason(Error::ReleaseNotFound), "network");
        let broken: Error = serde_json::from_str::<serde_json::Value>("{").unwrap_err().into();
        assert_eq!(reason(broken), "manifest");
        assert_eq!(reason(Error::EmptyEndpoints), "error");
        // reqwest keeps the cause as its source: a JSON error means a broken manifest, a cut-off body does not.
        let parse = Wrap(Box::new(serde_json::from_str::<serde_json::Value>("{").unwrap_err()));
        assert!(is_json(&parse));
        let cut = Wrap(Box::new(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset")));
        assert!(!is_json(&cut));
    }

    /// Stands in for reqwest::Error, which keeps its cause as `source()` the same way; reqwest is not a dependency here.
    #[derive(Debug)]
    struct Wrap(Box<dyn std::error::Error + 'static>);

    impl std::fmt::Display for Wrap {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("request failed")
        }
    }

    impl std::error::Error for Wrap {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&*self.0)
        }
    }
}
