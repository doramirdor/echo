pub mod refiner;
pub mod cli;
pub mod claude;
pub mod openai;
pub mod groq;
pub mod ollama;
pub mod llama;

use crate::memory::store::MemoryEntry;

pub struct RefinementContext {
    pub memory_entries: Vec<MemoryEntry>,
    pub memory_formatted: String,
    pub window_context: Option<String>,
    pub vocabulary_list: Option<String>,
    pub custom_prompt: Option<String>,
    pub existing_field_text: Option<String>,
    pub tone: Option<String>,
}

pub async fn refine(
    provider: &str,
    raw: &str,
    ctx: &RefinementContext,
    settings: &crate::settings::SettingsStore,
) -> Result<String, String> {
    let system_prompt = refiner::build_system_prompt(&ctx.memory_formatted, ctx);
    let project_context = crate::codebase::analyzer::load_context();

    match provider {
        "claude-cli" => cli::refine("claude", raw, &system_prompt, project_context.as_deref()).await,
        "codex-cli" => cli::refine("codex", raw, &system_prompt, project_context.as_deref()).await,
        "claude-api" => {
            let key = settings.get(|s| s.claude_api_key.clone());
            let model = settings.get(|s| s.claude_api_model.clone());
            claude::refine(&key, &model, raw, &system_prompt).await
        }
        "openai-api" => {
            let key = settings.get(|s| s.openai_api_key.clone());
            let model = settings.get(|s| s.openai_api_model.clone());
            openai::refine(&key, &model, raw, &system_prompt).await
        }
        "groq" => {
            let key = settings.get(|s| s.groq_api_key.clone());
            let model = settings.get(|s| s.groq_llm_model.clone());
            groq::refine(&key, &model, raw, &system_prompt).await
        }
        "ollama" => {
            let endpoint = settings.get(|s| s.ollama_endpoint.clone());
            let model = settings.get(|s| s.ollama_model.clone());
            ollama::refine(&endpoint, &model, raw, &system_prompt).await
        }
        "llama-local" => {
            let endpoint = settings.get(|s| s.llama_endpoint.clone());
            let model = settings.get(|s| s.llama_model.clone());
            llama::refine(&endpoint, &model, raw, &system_prompt).await
        }
        _ => Ok(raw.to_string()),
    }
}
