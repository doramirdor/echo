use crate::history::run_log::RunLog;

pub fn build_dictation_context(run_log: &RunLog, count: u32) -> String {
    if count == 0 { return String::new(); }
    let recent: Vec<_> = run_log.get_all().iter()
        .filter(|e| e.error.is_none() && !e.refined_text.is_empty())
        .take(count as usize)
        .cloned()
        .collect();

    if recent.is_empty() { return String::new(); }

    recent.iter().rev().enumerate()
        .map(|(i, e)| format!("[{}] \"{}\"", i + 1, e.refined_text))
        .collect::<Vec<_>>()
        .join("\n")
}
