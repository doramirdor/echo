//! Deterministic, LLM-free project-jargon extraction.
//!
//! Mirrors `src/main/codebase/projectJargon.ts`. Mines identifiers directly from
//! a repo — dependency names from manifests, exported symbol names, and source
//! file names — so STT biasing works with zero setup and no LLM configured.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use regex::Regex;

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", "out", "vendor",
    ".venv", "venv", "__pycache__", "coverage", ".turbo", "Pods", "DerivedData",
    ".cache", ".idea", ".vscode",
];

const SOURCE_EXT: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt",
    "swift", "rb", "php", "cs", "c", "cc", "cpp", "h", "hpp", "scala", "ex", "exs", "dart",
];

fn symbol_patterns() -> Vec<Regex> {
    vec![
        Regex::new(r"\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]+)").unwrap(),
        Regex::new(r"\bexport\s+(?:const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]+)").unwrap(),
        Regex::new(r"\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]+)").unwrap(),
        Regex::new(r"\bdef\s+([A-Za-z_][\w]+)").unwrap(),
        Regex::new(r"\bfunc\s+([A-Za-z_][\w]+)").unwrap(),
        Regex::new(r"\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]+)").unwrap(),
        Regex::new(r"\b(?:pub\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_][\w]+)").unwrap(),
    ]
}

fn is_useful_term(tok: &str) -> bool {
    let len = tok.chars().count();
    if len < 3 || len > 40 {
        return false;
    }
    let re = Regex::new(r"^[A-Za-z][A-Za-z0-9_.-]*$").unwrap();
    re.is_match(tok)
}

fn looks_technical(tok: &str) -> bool {
    let camel = Regex::new(r"[a-z][A-Z]").unwrap();
    let upper_start = Regex::new(r"^[A-Z]{2,}").unwrap();
    camel.is_match(tok) || tok.contains('_') || tok.contains('-') || upper_start.is_match(tok)
}

fn strip_scope(name: &str) -> String {
    // "@scope/pkg" -> "pkg"
    match name.rfind('/') {
        Some(idx) if name.starts_with('@') => name[idx + 1..].to_string(),
        _ => name.to_string(),
    }
}

fn read_manifest_deps(project_path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let read = |file: &str| -> Option<String> { fs::read_to_string(project_path.join(file)).ok() };

    // package.json — name + all dependency keys.
    if let Some(pkg) = read("package.json") {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&pkg) {
            if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                out.push(strip_scope(name));
            }
            for field in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                if let Some(map) = json.get(field).and_then(|v| v.as_object()) {
                    for key in map.keys() {
                        out.push(strip_scope(key));
                    }
                }
            }
        }
    }

    // Cargo.toml — package name + dependency keys.
    if let Some(cargo) = read("Cargo.toml") {
        let mut section = String::new();
        let name_re = Regex::new(r#"^name\s*=\s*"([^"]+)""#).unwrap();
        let dep_re = Regex::new(r"^([A-Za-z0-9_-]+)\s*=").unwrap();
        for raw in cargo.lines() {
            let line = raw.trim();
            if let Some(sec) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                section = sec.to_string();
                continue;
            }
            if section == "package" {
                if let Some(c) = name_re.captures(line) {
                    out.push(c[1].to_string());
                    continue;
                }
            }
            if section.ends_with("dependencies") {
                if let Some(c) = dep_re.captures(line) {
                    out.push(c[1].to_string());
                }
            }
        }
    }

    // requirements.txt — python package names before any version specifier.
    if let Some(reqs) = read("requirements.txt") {
        let re = Regex::new(r"^([A-Za-z0-9_.-]+)").unwrap();
        for raw in reqs.lines() {
            let line = raw.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(c) = re.captures(line) {
                out.push(c[1].to_string());
            }
        }
    }

    out
}

fn collect_symbols_and_names(
    project_path: &Path,
    max_files: usize,
    max_bytes_per_file: usize,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![project_path.to_path_buf()];
    let mut scanned = 0usize;
    let patterns = symbol_patterns();

    while let Some(dir) = stack.pop() {
        if scanned >= max_files {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if scanned >= max_files {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let full = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(full);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let ext = full.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !SOURCE_EXT.contains(&ext) {
                continue;
            }
            scanned += 1;

            if let Some(base) = full.file_stem().and_then(|b| b.to_str()) {
                if looks_technical(base) {
                    out.push(base.to_string());
                }
            }

            // Read a bounded prefix of the file.
            let mut content = String::new();
            if let Ok(mut f) = fs::File::open(&full) {
                let mut buf = vec![0u8; max_bytes_per_file];
                if let Ok(n) = f.read(&mut buf) {
                    content = String::from_utf8_lossy(&buf[..n]).to_string();
                }
            }
            for pattern in &patterns {
                for cap in pattern.captures_iter(&content) {
                    if let Some(m) = cap.get(1) {
                        out.push(m.as_str().to_string());
                    }
                }
            }
        }
    }

    out
}

/// Extract jargon terms from a project directory without any LLM call.
/// Priority order: manifest dependency names → exported symbols/filenames.
pub fn extract_project_jargon(project_path: &str) -> Vec<String> {
    let max_files = 300usize;
    let max_terms = 400usize;
    let max_bytes_per_file = 200_000usize;

    let resolved = if project_path.starts_with('~') {
        project_path.replacen('~', &dirs::home_dir().unwrap_or_default().to_string_lossy(), 1)
    } else {
        project_path.to_string()
    };
    let root = Path::new(&resolved);

    let mut ordered = read_manifest_deps(root);
    ordered.extend(collect_symbols_and_names(root, max_files, max_bytes_per_file));

    let mut seen: HashSet<String> = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    for raw in ordered {
        let tok = raw.trim();
        if !is_useful_term(tok) {
            continue;
        }
        let key = tok.to_lowercase();
        if seen.insert(key) {
            terms.push(tok.to_string());
            if terms.len() >= max_terms {
                break;
            }
        }
    }
    terms
}

fn jargon_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/project-jargon.json")
}

/// Deterministic jargon scan + cache to disk for STT biasing.
pub fn quick_scan(project_path: &str) -> Vec<String> {
    let terms = extract_project_jargon(project_path);
    let path = jargon_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).ok();
    }
    if let Ok(json) = serde_json::to_string(&terms) {
        fs::write(&path, json).ok();
    }
    terms
}

/// Load cached deterministic jargon terms (empty if none).
pub fn load_jargon_terms() -> Vec<String> {
    let path = jargon_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(terms) = serde_json::from_str::<Vec<String>>(&content) {
            return terms;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_useful_terms() {
        assert!(is_useful_term("runPipeline"));
        assert!(is_useful_term("api_key"));
        assert!(!is_useful_term("ab"));
        assert!(!is_useful_term("no spaces here"));
    }

    #[test]
    fn technical_filename_detection() {
        assert!(looks_technical("speechBias"));
        assert!(looks_technical("app_profiles"));
        assert!(looks_technical("API"));
        assert!(!looks_technical("index"));
        assert!(!looks_technical("main"));
    }

    #[test]
    fn strips_npm_scope() {
        assert_eq!(strip_scope("@tauri-apps/api"), "api");
        assert_eq!(strip_scope("react"), "react");
    }
}
