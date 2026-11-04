// SPDX-License-Identifier: GPL-3.0-or-later
//! Carries per-user data over a bundle identifier change (BURN-40).
//!
//! Tauri names the app's data, config and local-data folders after the bundle
//! identifier, so renaming `dev.aria-burn.lasersim` to `dev.aria.burn` would
//! leave the settings store (`settings.json`) and, on Windows, the WebView2
//! profile behind. On start, before Tauri creates the window and opens those
//! folders, each old folder whose new counterpart doesn't exist yet is copied
//! across. The old folders are left as they are, so an older build still works.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Identifiers the app has shipped under before, newest first.
pub const PREVIOUS_IDENTIFIERS: &[&str] = &["dev.aria-burn.lasersim"];

/// The per-user base folders Tauri joins the identifier to: app data, config
/// and local data (the same folder on macOS; Roaming and Local on Windows).
fn base_dirs() -> BTreeSet<PathBuf> {
    [dirs::data_dir(), dirs::config_dir(), dirs::data_local_dir()].into_iter().flatten().collect()
}

/// One folder copied: from the old identifier's folder to the new one's.
#[derive(Debug, PartialEq, Eq)]
pub struct Copied {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// Copy `<base>/<old>` to `<base>/<new>` for every base where the old folder
/// exists and the new one doesn't. The first previous identifier found wins.
pub fn migrate_in(bases: &BTreeSet<PathBuf>, previous: &[&str], current: &str) -> Vec<io::Result<Copied>> {
    let mut done = Vec::new();
    for base in bases {
        let to = base.join(current);
        if to.exists() {
            continue;
        }
        let Some(from) = previous.iter().map(|id| base.join(id)).find(|p| p.is_dir()) else {
            continue;
        };
        done.push(copy_dir(&from, &to).map(|()| Copied { from, to }));
    }
    done
}

/// Migrate the real per-user folders to `current`. Never fails the start:
/// problems are printed and the app opens with whatever was copied.
pub fn run(current: &str) {
    for result in migrate_in(&base_dirs(), PREVIOUS_IDENTIFIERS, current) {
        match result {
            Ok(c) => eprintln!("aria-burn: copied {} to {}", c.from.display(), c.to.display()),
            Err(e) => eprintln!("aria-burn: couldn't copy the previous app data: {e}"),
        }
    }
}

/// Recursive copy into a fresh folder. Written to a temporary sibling and
/// renamed at the end, so an interrupted copy never looks like a finished one.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    let mut name = to.file_name().unwrap_or_default().to_os_string();
    name.push(".migrating");
    let tmp = to.with_file_name(name);
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    copy_tree(from, &tmp)?;
    fs::rename(&tmp, to)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &dest)?;
        }
        // Symlinks (none expected in these folders) are skipped rather than followed.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aria-burn-migrate-{name}-{}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir).unwrap();
        }
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_every_file_from_the_old_identifier() {
        let base = scratch("copy");
        let old = base.join("dev.aria-burn.lasersim");
        fs::create_dir_all(old.join("EBWebView/Default")).unwrap();
        fs::write(old.join("settings.json"), r#"{"settings":{"material":"birch"}}"#).unwrap();
        fs::write(old.join("EBWebView/Default/Preferences"), "x").unwrap();

        let done = migrate_in(&BTreeSet::from([base.clone()]), PREVIOUS_IDENTIFIERS, "dev.aria.burn");

        assert_eq!(done.len(), 1);
        let new = base.join("dev.aria.burn");
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), r#"{"settings":{"material":"birch"}}"#);
        assert_eq!(fs::read_to_string(new.join("EBWebView/Default/Preferences")).unwrap(), "x");
        // The old folder stays for older builds, and no temporary folder is left.
        assert!(old.join("settings.json").exists());
        assert!(!base.join("dev.aria.burn.migrating").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn never_touches_an_existing_new_folder() {
        let base = scratch("keep");
        fs::create_dir_all(base.join("dev.aria-burn.lasersim")).unwrap();
        fs::write(base.join("dev.aria-burn.lasersim/settings.json"), "old").unwrap();
        fs::create_dir_all(base.join("dev.aria.burn")).unwrap();
        fs::write(base.join("dev.aria.burn/settings.json"), "new").unwrap();

        let done = migrate_in(&BTreeSet::from([base.clone()]), PREVIOUS_IDENTIFIERS, "dev.aria.burn");

        assert!(done.is_empty());
        assert_eq!(fs::read_to_string(base.join("dev.aria.burn/settings.json")).unwrap(), "new");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn does_nothing_for_a_new_install() {
        let base = scratch("fresh");
        assert!(migrate_in(&BTreeSet::from([base.clone()]), PREVIOUS_IDENTIFIERS, "dev.aria.burn").is_empty());
        assert!(!base.join("dev.aria.burn").exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
