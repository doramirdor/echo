use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn context_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/project-context.md")
}

pub fn has_context() -> bool {
    context_path().exists()
}

pub fn load_context() -> Option<String> {
    let path = context_path();
    if path.exists() { fs::read_to_string(&path).ok() } else { None }
}

pub fn get_context_path() -> String {
    context_path().to_string_lossy().to_string()
}

pub async fn analyze(
    project_path: &str,
    project_name: &str,
    on_chunk: impl Fn(&str) + Send + 'static,
) -> Result<String, String> {
    let prompt = format!(
        r#"You are scanning the codebase at "{}" for a project called "{}".

Your goal is to generate a voice-to-text context document. This document will be used as context when refining speech-to-text transcriptions from a developer working on this codebase.

Scan the project and produce a document with these sections:

## Project Overview
Brief description of what this project is and does.

## Key Terminology
List every important term, name, and identifier that someone would say out loud when discussing this code.

## Naming Conventions
Describe the naming patterns used.

## Architecture
Brief overview of how the code is organized.

## Domain Language
Any domain-specific words, acronyms, product names, or jargon.

Be thorough. Output the document in markdown format."#,
        project_path, project_name
    );

    let resolved_path = if project_path.starts_with('~') {
        project_path.replacen('~', &dirs::home_dir().unwrap_or_default().to_string_lossy(), 1)
    } else {
        project_path.to_string()
    };

    let extra_path = format!(
        "{}:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin",
        std::env::var("PATH").unwrap_or_default(),
        dirs::home_dir().unwrap_or_default().display()
    );

    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("bash")
            .args(["-c", "claude -p --model sonnet"])
            .current_dir(&resolved_path)
            .env("PATH", &extra_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Analysis failed: {}", e))?;

        if let Some(ref mut stdin) = child.stdin {
            stdin.write_all(prompt.as_bytes()).map_err(|e| format!("Write: {}", e))?;
        }
        drop(child.stdin.take());

        let output = child.wait_with_output().map_err(|e| format!("Wait: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Analysis failed: {}", &stderr[..stderr.len().min(200)]));
        }

        let context = String::from_utf8_lossy(&output.stdout).trim().to_string();
        on_chunk(&context);

        // Save
        let path = context_path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).ok();
        }
        fs::write(&path, &context).ok();

        Ok(context)
    })
    .await
    .map_err(|e| format!("Task: {}", e))??;

    Ok(result)
}
