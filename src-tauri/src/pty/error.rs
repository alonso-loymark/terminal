use serde::{Serialize, Serializer};

use super::manager::SessionId;

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("session {0} does not exist")]
    NotFound(SessionId),
    #[error("session {0} is closing")]
    Closed(SessionId),
    #[error("could not open a pseudoconsole: {0}")]
    Open(String),
    #[error("could not start {0}")]
    Spawn(String),
    #[error("could not resize the pseudoconsole: {0}")]
    Resize(String),
    #[error("pty i/o error: {0}")]
    Io(String),
}

/// Commands reject with the error message as a plain string.
impl Serialize for PtyError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
