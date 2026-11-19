//! Watches the folders the explorer shows (non-recursive: one OS watch per expanded folder) and
//! reports, debounced, which folders changed. The UI then re-lists only those.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::ExplorerError;

pub type WatchId = u32;

/// Quiet time that closes a batch of changes (a `git checkout` or `npm install` fires hundreds).
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Under a continuous stream of changes, report at least this often.
const MAX_DELAY: Duration = Duration::from_millis(600);
/// Upper bound of OS watches per explorer (each one is a ReadDirectoryChangesW handle).
pub const MAX_WATCHED_DIRS: usize = 256;

/// Receives the folders whose contents changed.
pub trait WatchEvents: Send + 'static {
    fn changed(&self, dirs: Vec<PathBuf>);
}

struct Watch {
    owner: String,
    watcher: RecommendedWatcher,
    dirs: HashSet<PathBuf>,
}

#[derive(Default)]
struct Inner {
    watches: Mutex<HashMap<WatchId, Watch>>,
    next_id: AtomicU32,
}

/// Cheap to clone (shared state), so work can move to the blocking pool.
#[derive(Clone, Default)]
pub struct WatchManager {
    inner: Arc<Inner>,
}

impl WatchManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// A watcher with no folders yet; `events` gets the debounced changes.
    pub fn start(&self, owner: &str, events: impl WatchEvents) -> Result<WatchId, ExplorerError> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in event.paths {
                // Something inside a watched folder changed; if a watched folder itself was
                // removed or renamed, its own path is reported too.
                if let Some(parent) = path.parent() {
                    let _ = tx.send(parent.to_path_buf());
                }
                let _ = tx.send(path);
            }
        })
        .map_err(|e| ExplorerError::Unavailable(format!("watcher: {e}")))?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        // Ends when the watcher (and with it the sender in its handler) is dropped.
        thread::Builder::new()
            .name(format!("fs-watch-{id}"))
            .stack_size(64 * 1024)
            .spawn(move || debounce(rx, events))
            .map_err(|e| ExplorerError::Unavailable(format!("watcher thread: {e}")))?;
        self.lock().insert(
            id,
            Watch {
                owner: owner.to_owned(),
                watcher,
                dirs: HashSet::new(),
            },
        );
        Ok(id)
    }

    /// Watches exactly `dirs` from now on: new ones are added, the rest released. Folders that
    /// cannot be watched (gone, no access) are skipped. Returns the folders being watched.
    pub fn set_dirs(&self, id: WatchId, dirs: &[PathBuf]) -> Result<Vec<PathBuf>, ExplorerError> {
        let mut watches = self.lock();
        let watch = watches.get_mut(&id).ok_or(ExplorerError::NoWatcher(id))?;
        let wanted: HashSet<PathBuf> = dirs.iter().take(MAX_WATCHED_DIRS).cloned().collect();
        let stale: Vec<PathBuf> = watch.dirs.difference(&wanted).cloned().collect();
        for dir in stale {
            let _ = watch.watcher.unwatch(&dir);
            watch.dirs.remove(&dir);
        }
        for dir in wanted {
            if !watch.dirs.contains(&dir)
                && watch
                    .watcher
                    .watch(&dir, RecursiveMode::NonRecursive)
                    .is_ok()
            {
                watch.dirs.insert(dir);
            }
        }
        Ok(watch.dirs.iter().cloned().collect())
    }

    pub fn watched(&self, id: WatchId) -> Option<Vec<PathBuf>> {
        self.lock()
            .get(&id)
            .map(|watch| watch.dirs.iter().cloned().collect())
    }

    pub fn stop(&self, id: WatchId) {
        // Dropping the watcher releases every OS watch and ends its debounce thread.
        self.lock().remove(&id);
    }

    /// The page that owned these watchers was reloaded or closed.
    pub fn stop_owned_by(&self, owner: &str) {
        self.lock().retain(|_, watch| watch.owner != owner);
    }

    pub fn shutdown(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<WatchId, Watch>> {
        self.inner
            .watches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

fn debounce(rx: Receiver<PathBuf>, events: impl WatchEvents) {
    while let Ok(first) = rx.recv() {
        let mut batch: HashSet<PathBuf> = HashSet::from([first]);
        let started = Instant::now();
        loop {
            let left = MAX_DELAY.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(DEBOUNCE.min(left)) {
                Ok(path) => {
                    batch.insert(path);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut dirs: Vec<PathBuf> = batch.into_iter().filter(|p| !is_noise(p)).collect();
        dirs.sort();
        if !dirs.is_empty() {
            events.changed(dirs);
        }
    }
}

/// Changes inside .git (index, lock files) are not listed folders; git status is refreshed by
/// the UI on its own schedule.
fn is_noise(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Sender;

    struct Collect(Mutex<Sender<Vec<PathBuf>>>);

    impl WatchEvents for Collect {
        fn changed(&self, dirs: Vec<PathBuf>) {
            let _ = self.0.lock().unwrap().send(dirs);
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("terminal-watch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn reports_changes_debounced_and_releases_folders() {
        let dir = temp_dir("a");
        let other = temp_dir("b");
        let manager = WatchManager::new();
        let (tx, rx) = mpsc::channel();
        let id = manager.start("main", Collect(Mutex::new(tx))).unwrap();
        assert_eq!(
            manager
                .set_dirs(id, &[dir.clone(), other.clone(), dir.join("no-existe")])
                .unwrap()
                .len(),
            2,
            "a missing folder is skipped"
        );

        // A burst of changes arrives as one batch.
        for i in 0..20 {
            std::fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
        }
        let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(batch.contains(&dir), "{batch:?}");
        while rx.recv_timeout(Duration::from_millis(800)).is_ok() {}

        // Released folders stop reporting; the kept one still does.
        let kept = std::slice::from_ref(&other);
        assert_eq!(manager.set_dirs(id, kept).unwrap(), kept);
        std::fs::write(dir.join("tarde.txt"), "x").unwrap();
        std::fs::write(other.join("nuevo.txt"), "x").unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(batch.contains(&other) && !batch.contains(&dir), "{batch:?}");

        manager.stop_owned_by("main");
        assert!(manager.watched(id).is_none());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&other).ok();
    }
}
