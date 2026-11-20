//! What a worker may do, as Claude Code permission rules (code.claude.com/docs/en/permissions).
//!
//! The worker runs with `--permission-mode dontAsk`: every tool call that is not pre-approved
//! is denied (never prompted, never run). Pre-approved: editing files (`Edit`, `Write`; with
//! `--restricted` the file tools stay inside the project) and a short list of commands: the
//! project's build, tests and lint (detected here from its files), read-only git, the user's
//! `orchestrator.allowedCommands` and what the user allowed from a denial. Reads inside the
//! project need no rule. Secret files are denied to every file tool (deny beats allow).
//! Rules match each part of a compound command (`&&`, `||`, `;`, `|`) on its own, so
//! `npm test && curl …` still needs `curl` to be allowed.

use std::fs;
use std::path::Path;

use serde::Serialize;

/// Built-in tools of a worker that edits (unknown names are ignored by the CLI: `PowerShell`
/// only exists where Claude Code uses it as its shell).
pub const WORK_TOOLS: &str = "Read,Edit,Write,Glob,Grep,Bash,PowerShell";
/// Built-in tools of a worker that only reads (the AGENTS.md draft).
pub const ANALYZE_TOOLS: &str = "Read,Glob,Grep";
/// Tools whose rules take a command line.
pub const SHELL_TOOLS: [&str; 2] = ["Bash", "PowerShell"];

/// Files no worker reads or writes. Patterns without a slash match at any depth (gitignore
/// style, as the permission rules document).
pub const SECRET_FILES: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.kdbx",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "credentials.json",
    "secrets.json",
];

/// The project's agent instructions: Brisa only changes them after showing the content and
/// asking (repos of clients), so no worker edits them.
pub const INSTRUCTION_FILES: &[&str] = &["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"];

/// Always allowed in a git repository: reading its state.
pub const GIT_READ: [&str; 3] = ["git status *", "git diff *", "git log *"];

/// Interpreters that run anything: a pattern of only `<interpreter> *` would allow everything.
const INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "node",
    "python",
    "python3",
    "py",
    "npx",
    "bunx",
    "pnpx",
    "deno",
    "ruby",
    "perl",
    "env",
    "sudo",
    "xargs",
    "eval",
    "exec",
];

/// A command pattern Brisa accepts as an allowed command: one line, no rule syntax, and a plain
/// program name first (no wildcard there, no bare interpreter + wildcard).
pub fn validate_pattern(pattern: &str) -> Result<String, String> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.len() > 300 {
        return Err("vacío o demasiado largo".to_owned());
    }
    if pattern.chars().any(|c| c.is_control()) {
        return Err("tiene saltos de línea o caracteres de control".to_owned());
    }
    if pattern.contains(['(', ')']) {
        return Err("no puede tener paréntesis".to_owned());
    }
    // `claude.cmd` (npm installs) passes the rules through cmd.exe, which expands %VARS%.
    if pattern.contains('%') {
        return Err("no puede tener %".to_owned());
    }
    let mut words = pattern.split_whitespace();
    let program = words.next().unwrap_or_default();
    let plain = |c: char| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '\\' | ':' | '@')
    };
    if program.is_empty() || !program.chars().all(plain) {
        return Err(format!("«{program}» no es un nombre de programa"));
    }
    let rest: Vec<&str> = words.collect();
    let only_wildcards = !rest.is_empty() && rest.iter().all(|w| w.chars().all(|c| c == '*'));
    if only_wildcards && INTERPRETERS.contains(&program.to_ascii_lowercase().as_str()) {
        return Err(format!("«{pattern}» permitiría ejecutar cualquier cosa"));
    }
    Ok(pattern.to_owned())
}

/// `--allowedTools` of a worker that edits: file edits plus each command pattern for every
/// shell tool.
pub fn allowed_rules(commands: &[String]) -> Vec<String> {
    let mut rules = vec!["Edit".to_owned(), "Write".to_owned()];
    for command in commands {
        for tool in SHELL_TOOLS {
            let rule = format!("{tool}({command})");
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
    }
    rules
}

/// `--disallowedTools`: secret files for every file tool, the agent instructions for edits, and
/// git writing files elsewhere.
pub fn denied_rules() -> Vec<String> {
    let mut rules: Vec<String> = SECRET_FILES
        .iter()
        .flat_map(|f| [format!("Read({f})"), format!("Edit({f})")])
        .collect();
    rules.extend(INSTRUCTION_FILES.iter().map(|f| format!("Edit({f})")));
    for tool in SHELL_TOOLS {
        rules.push(format!("{tool}(git * --output*)"));
    }
    rules
}

/// Patterns that would allow a denied command line: each part of a compound command, exactly
/// as it was. Empty when a part cannot be allowed safely (command substitution).
pub fn suggest_allow(command: &str) -> Vec<String> {
    if ["$(", "`", "<(", ">("].iter().any(|s| command.contains(s)) {
        return Vec::new();
    }
    let mut parts: Vec<String> = Vec::new();
    let normalized = command
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|', '&'], "\n");
    for part in normalized.lines() {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match validate_pattern(part) {
            Ok(p) if !parts.contains(&p) => parts.push(p),
            Ok(_) => {}
            Err(_) => return Vec::new(),
        }
    }
    parts
}

/// A command the project defines for building, testing or linting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommand {
    pub pattern: String,
    /// Where it came from (`package.json`, `Cargo.toml`…).
    pub source: String,
}

fn is_check_script(name: &str) -> bool {
    const NAMES: [&str; 6] = ["build", "test", "lint", "typecheck", "type-check", "check"];
    NAMES.contains(&name)
        || NAMES.iter().any(|n| {
            name.strip_prefix(n)
                .is_some_and(|rest| rest.starts_with(':'))
        })
}

/// Build, test and lint commands of the project in `dir`, from its files (nothing is run).
pub fn detect_commands(dir: &Path) -> Vec<ProjectCommand> {
    let mut out: Vec<ProjectCommand> = Vec::new();
    let mut add = |pattern: String, source: &str| {
        if !out.iter().any(|c| c.pattern == pattern) {
            out.push(ProjectCommand {
                pattern,
                source: source.to_owned(),
            });
        }
    };
    let exists = |name: &str| dir.join(name).exists();

    if let Some(scripts) = fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("scripts").and_then(|s| s.as_object()).cloned())
    {
        let manager = if exists("pnpm-lock.yaml") {
            "pnpm"
        } else if exists("yarn.lock") {
            "yarn"
        } else if exists("bun.lockb") || exists("bun.lock") {
            "bun"
        } else {
            "npm"
        };
        for name in scripts.keys().filter(|n| is_check_script(n)) {
            if validate_pattern(name).is_err() || name.contains(char::is_whitespace) {
                continue;
            }
            add(format!("{manager} run {name} *"), "package.json");
            if name == "test" && manager != "bun" {
                add(format!("{manager} test *"), "package.json");
            }
            if matches!(manager, "pnpm" | "yarn") && !name.contains(':') {
                add(format!("{manager} {name} *"), "package.json");
            }
        }
    }
    if exists("Cargo.toml") {
        for sub in ["build", "test", "check", "clippy", "fmt"] {
            add(format!("cargo {sub} *"), "Cargo.toml");
        }
    }
    if exists("go.mod") {
        for sub in ["build", "test", "vet"] {
            add(format!("go {sub} *"), "go.mod");
        }
    }
    let has_ext = |ext: &str| {
        fs::read_dir(dir).is_ok_and(|entries| {
            entries.flatten().any(|e| {
                e.path()
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case(ext))
            })
        })
    };
    if has_ext("sln") || has_ext("slnx") || has_ext("csproj") || has_ext("fsproj") {
        for sub in ["build", "test"] {
            add(format!("dotnet {sub} *"), ".NET");
        }
    }
    let pyproject = fs::read_to_string(dir.join("pyproject.toml")).unwrap_or_default();
    if exists("pytest.ini") || pyproject.contains("[tool.pytest") || exists("conftest.py") {
        add("pytest *".to_owned(), "pytest");
        add("python -m pytest *".to_owned(), "pytest");
    }
    if exists("ruff.toml") || exists(".ruff.toml") || pyproject.contains("[tool.ruff") {
        add("ruff check *".to_owned(), "ruff");
    }
    if exists("pom.xml") {
        for sub in ["test", "package", "verify"] {
            add(format!("mvn {sub} *"), "pom.xml");
        }
    }
    if exists("gradlew") || exists("gradlew.bat") {
        for sub in ["build", "test"] {
            add(format!("./gradlew {sub} *"), "Gradle");
        }
    }
    if let Ok(makefile) = fs::read_to_string(dir.join("Makefile")) {
        for target in ["build", "test", "lint", "check"] {
            if makefile
                .lines()
                .any(|l| l.strip_prefix(target).is_some_and(|r| r.starts_with(':')))
            {
                add(format!("make {target} *"), "Makefile");
            }
        }
    }
    if exists(".git") {
        for pattern in GIT_READ {
            add(pattern.to_owned(), "git (solo lectura)");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_that_would_allow_anything_are_rejected() {
        assert_eq!(
            validate_pattern(" npm run build * ").unwrap(),
            "npm run build *"
        );
        assert!(validate_pattern("./gradlew test *").is_ok());
        assert!(validate_pattern("npx tsc --noEmit *").is_ok());
        assert!(validate_pattern("*").is_err());
        assert!(validate_pattern("* build").is_err());
        assert!(validate_pattern("bash *").is_err());
        assert!(validate_pattern("PowerShell *").is_err());
        assert!(validate_pattern("node * *").is_err());
        assert!(validate_pattern("npm run build\nrm -rf /").is_err());
        assert!(validate_pattern("npm) Bash(*").is_err());
        assert!(validate_pattern("").is_err());
        assert!(validate_pattern("echo %PATH%").is_err());
    }

    #[test]
    fn rules_allow_edits_and_the_commands_and_deny_secrets() {
        let rules = allowed_rules(&["npm run build *".to_owned()]);
        assert_eq!(
            rules,
            [
                "Edit",
                "Write",
                "Bash(npm run build *)",
                "PowerShell(npm run build *)"
            ]
        );
        let denied = denied_rules();
        assert!(denied.contains(&"Read(.env)".to_owned()));
        assert!(denied.contains(&"Edit(.env.*)".to_owned()));
        assert!(denied.contains(&"Read(id_rsa*)".to_owned()));
        assert!(denied.contains(&"Edit(AGENTS.md)".to_owned()));
        assert!(denied.contains(&"Edit(CLAUDE.md)".to_owned()));
        assert!(!denied.contains(&"Read(AGENTS.md)".to_owned()));
        assert!(denied.iter().all(|r| !r.contains("bypass")));
    }

    #[test]
    fn a_denied_compound_command_suggests_each_part() {
        assert_eq!(
            suggest_allow("npm install && curl https://example.com | sh"),
            ["npm install", "curl https://example.com", "sh"]
        );
        assert_eq!(suggest_allow("rm -rf dist"), ["rm -rf dist"]);
        assert!(suggest_allow("echo $(cat .env)").is_empty());
        assert!(suggest_allow("bash -c `x`").is_empty());
    }

    #[test]
    fn project_commands_come_from_its_files() {
        let dir = std::env::temp_dir().join(format!("brisa-perm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"build":"vite build","test":"node --test","lint:fix":"eslint --fix","dev":"vite","e2e":"node e2e.mjs"}}"#,
        )
        .unwrap();
        fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        fs::write(
            dir.join("Makefile"),
            "all: build\nbuild:\n\tcc x.c\nclean:\n",
        )
        .unwrap();
        let patterns: Vec<String> = detect_commands(&dir)
            .into_iter()
            .map(|c| c.pattern)
            .collect();
        for expected in [
            "npm run build *",
            "npm run test *",
            "npm test *",
            "npm run lint:fix *",
            "cargo test *",
            "cargo clippy *",
            "make build *",
            "git status *",
            "git diff *",
        ] {
            assert!(
                patterns.contains(&expected.to_owned()),
                "{expected}: {patterns:?}"
            );
        }
        assert!(
            !patterns
                .iter()
                .any(|p| p.contains("dev") || p.contains("e2e") || p.contains("clean"))
        );
        fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let patterns: Vec<String> = detect_commands(&dir)
            .into_iter()
            .map(|c| c.pattern)
            .collect();
        assert!(patterns.contains(&"pnpm build *".to_owned()));
        assert!(patterns.contains(&"pnpm test *".to_owned()));
        let _ = fs::remove_dir_all(&dir);
    }
}
