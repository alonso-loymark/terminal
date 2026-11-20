//! Last redaction pass, in Rust: the values of this process's sensitive environment variables
//! (tokens, passwords, connection strings) wherever they appear in the text about to be sent.
//! A value printed by `echo $env:GITHUB_TOKEN` matches no known token format, but it is here.
//! The values never leave this process: the frontend sends text and gets it back scrubbed.

use serde::Serialize;

/// Words in a variable name that mark its value as secret.
const SENSITIVE: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "API_KEY",
    "APIKEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "CLIENT_SECRET",
    "CONNECTION_STRING",
    "CONNECTIONSTRING",
    "CONN_STR",
    "CONNSTR",
    "CREDENTIAL",
    "AUTH",
    "SIGNATURE",
    "DATABASE_URL",
    "DB_URL",
    "_DSN",
    "WEBHOOK",
    "COOKIE",
    "SAS_",
    "_SAS",
    "_PWD",
];

/// Shorter values are too likely to be ordinary words or numbers.
const MIN_VALUE: usize = 8;

pub fn is_sensitive_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "PWD" | "OLDPWD") {
        return false;
    }
    upper.ends_with("_KEY") || SENSITIVE.iter().any(|word| upper.contains(word))
}

/// (name, value) of the sensitive variables worth looking for.
pub fn sensitive_vars(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vars
        .filter(|(name, value)| {
            is_sensitive_name(name)
                && value.chars().count() >= MIN_VALUE
                // A folder (C:\..., /home/...) under a sensitive-looking name is not a secret.
                && !value.get(1..3).is_some_and(|s| s == ":\\")
                && !value.starts_with('/')
        })
        .collect();
    // Longest first: a value that contains another is replaced whole.
    out.sort_by_key(|(_, value)| std::cmp::Reverse(value.len()));
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scrubbed {
    pub texts: Vec<String>,
    /// Names of the variables whose values were found (not the values).
    pub names: Vec<String>,
    pub count: usize,
}

pub fn scrub(texts: Vec<String>, vars: &[(String, String)]) -> Scrubbed {
    let mut names = Vec::new();
    let mut count = 0;
    let texts = texts
        .into_iter()
        .map(|mut text| {
            for (name, value) in vars {
                let hits = text.matches(value.as_str()).count();
                if hits > 0 {
                    text = text.replace(value.as_str(), &format!("[REDACTED:env:{name}]"));
                    count += hits;
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
            }
            text
        })
        .collect();
    Scrubbed {
        texts,
        names,
        count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_names() {
        for name in [
            "GITHUB_TOKEN",
            "OPENAI_API_KEY",
            "db_password",
            "STRIPE_KEY",
            "AZURE_STORAGE_CONNECTION_STRING",
            "DATABASE_URL",
            "NPM_AUTH_TOKEN",
            "SQL_PWD",
        ] {
            assert!(is_sensitive_name(name), "{name}");
        }
        for name in [
            "PATH",
            "PWD",
            "OLDPWD",
            "USERPROFILE",
            "TERM",
            "HOME",
            "COMPUTERNAME",
        ] {
            assert!(!is_sensitive_name(name), "{name}");
        }
    }

    #[test]
    fn values_are_replaced_by_the_variable_name() {
        let vars = sensitive_vars(
            [
                (
                    "MY_SERVICE_TOKEN".to_owned(),
                    "zq81-internal-9f2k".to_owned(),
                ),
                ("SHORT_TOKEN".to_owned(), "abc".to_owned()),
                ("CACHE_KEY".to_owned(), r"C:\cache\dir".to_owned()),
                ("PATH".to_owned(), "C:\\Windows".to_owned()),
            ]
            .into_iter(),
        );
        assert_eq!(vars.len(), 1);
        let out = scrub(
            vec![
                "echo zq81-internal-9f2k\nzq81-internal-9f2k".to_owned(),
                "abc".to_owned(),
            ],
            &vars,
        );
        assert_eq!(
            out.texts[0],
            "echo [REDACTED:env:MY_SERVICE_TOKEN]\n[REDACTED:env:MY_SERVICE_TOKEN]"
        );
        assert_eq!(out.texts[1], "abc");
        assert_eq!(out.count, 2);
        assert_eq!(out.names, vec!["MY_SERVICE_TOKEN".to_owned()]);
    }
}
