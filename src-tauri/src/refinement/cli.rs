use std::io::Write;
use std::process::{Command, Stdio};

pub async fn refine(
    command: &str,
    raw: &str,
    system_prompt: &str,
    project_context: Option<&str>,
) -> Result<String, String> {
    let extra_path = format!(
        "{}:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin",
        std::env::var("PATH").unwrap_or_default(),
        dirs::home_dir().unwrap_or_default().display()
    );

    let project_part = project_context
        .map(|pc| format!("\nProject context (use this to fix technical terms and names):\n{}\n", pc))
        .unwrap_or_default();

    let full_prompt = format!("{}{}\nRaw transcription:\n{}", system_prompt, project_part, raw);

    let cmd_line = if command == "claude" {
        format!("{} -p --model haiku", command)
    } else {
        format!("{} -q", command)
    };

    log::info!("[{}] Sending {} chars", command, full_prompt.len());

    // Run in a blocking thread since we're using std::process
    let cmd = command.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("bash")
            .args(["-c", &cmd_line])
            .env("PATH", &extra_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{} failed: {}", cmd, e))?;

        if let Some(ref mut stdin) = child.stdin {
            stdin.write_all(full_prompt.as_bytes())
                .map_err(|e| format!("Write stdin: {}", e))?;
        }
        drop(child.stdin.take());

        let output = child.wait_with_output()
            .map_err(|e| format!("{} failed: {}", cmd, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("{} failed (exit {}): {}", cmd, output.status.code().unwrap_or(-1), &stderr[..stderr.len().min(200)]));
        }

        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::info!("[{}] Refined: \"{}\"", cmd, text);
        Ok(text)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(result)
}
