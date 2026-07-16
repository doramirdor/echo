// Rust mirror of src/main/history/stats.ts (`computeStats`).
// Returns the exact camelCase shape the shared renderer's Insights tab expects
// (see src/renderer/settings.js `renderStats`).

use crate::history::run_log::{RunLog, RunLogEntry};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

const AVG_TYPING_WPM: f64 = 40.0;

#[derive(Debug, Clone, Serialize)]
struct DailyActivity {
    date: String,
    count: u32,
}

#[derive(Debug, Clone, Serialize)]
struct TopApp {
    app: String,
    count: u32,
    percent: u32,
}

#[derive(Debug, Clone, Serialize)]
struct RecentDictation {
    time: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoStats {
    total_dictations: u32,
    total_words_dictated: u32,
    total_corrections: u32,
    avg_words_per_minute: u32,
    wpm_speedup: f64,
    avg_duration_ms: u64,
    current_streak: u32,
    longest_streak: u32,
    this_month_words: u32,
    last_month_words: u32,
    month_growth_percent: i32,
    daily_activity: Vec<DailyActivity>,
    top_apps: Vec<TopApp>,
    recent_dictations: Vec<RecentDictation>,
}

fn count_words(text: &str) -> u32 {
    text.split_whitespace().filter(|s| !s.is_empty()).count() as u32
}

/// Parse an RFC3339 timestamp (as written by RunLog::add) into a UTC datetime.
fn parse_ts(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn date_of(ts: &str) -> Option<NaiveDate> {
    parse_ts(ts).map(|d| d.date_naive())
}

/// Mirrors `calculateStreak`: current run of consecutive active days ending
/// today/yesterday, plus the longest consecutive run ever.
fn calculate_streak(days: &BTreeSet<NaiveDate>) -> (u32, u32) {
    if days.is_empty() {
        return (0, 0);
    }
    let today = Utc::now().date_naive();
    let yesterday = today - Duration::days(1);

    // BTreeSet iterates ascending; the last element is the most recent day.
    let most_recent = *days.iter().next_back().unwrap();
    let mut current = 0u32;
    if most_recent == today || most_recent == yesterday {
        let mut check = most_recent;
        for day in days.iter().rev() {
            if *day == check {
                current += 1;
                check -= Duration::days(1);
            } else {
                break;
            }
        }
    }

    let mut longest = 0u32;
    let mut streak = 0u32;
    let mut prev: Option<NaiveDate> = None;
    for day in days.iter() {
        streak = match prev {
            Some(p) if (*day - p).num_days() == 1 => streak + 1,
            _ => 1,
        };
        longest = longest.max(streak);
        prev = Some(*day);
    }

    (current, longest)
}

/// Best-effort app name for an entry: the recorded `source_app`, else parsed
/// from the leading "App: ..." line of the window context, else None.
fn app_name(entry: &RunLogEntry) -> Option<String> {
    if let Some(app) = entry.source_app.as_ref().filter(|s| !s.trim().is_empty()) {
        return Some(app.trim().to_string());
    }
    let ctx = entry.context.trim();
    if ctx.is_empty() {
        return None;
    }
    let first_line = ctx.lines().next().unwrap_or("").trim();
    if let Some(rest) = first_line
        .strip_prefix("App:")
        .or_else(|| first_line.strip_prefix("app:"))
    {
        let name = rest.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

pub fn compute_stats(run_log: &RunLog) -> EchoStats {
    let entries = run_log.get_all();
    let success: Vec<&RunLogEntry> = entries
        .iter()
        .filter(|e| e.error.is_none() && !e.refined_text.is_empty())
        .collect();

    let total_dictations = success.len() as u32;
    let total_words_dictated: u32 = success.iter().map(|e| count_words(&e.refined_text)).sum();

    let total_corrections = success
        .iter()
        .filter(|e| {
            let raw = e.raw_transcription.trim().to_lowercase();
            let refined = e.refined_text.trim().to_lowercase();
            raw != refined && !raw.is_empty()
        })
        .count() as u32;

    // Average WPM across entries that recorded a duration.
    let with_duration: Vec<&&RunLogEntry> = success.iter().filter(|e| e.duration_ms > 0).collect();
    let avg_words_per_minute = if with_duration.is_empty() {
        0u32
    } else {
        let total_wpm: f64 = with_duration
            .iter()
            .map(|e| {
                let words = count_words(&e.refined_text) as f64;
                let minutes = e.duration_ms as f64 / 60000.0;
                if minutes > 0.0 {
                    words / minutes
                } else {
                    0.0
                }
            })
            .sum();
        (total_wpm / with_duration.len() as f64).round() as u32
    };

    let wpm_speedup = if avg_words_per_minute > 0 {
        ((avg_words_per_minute as f64 / AVG_TYPING_WPM) * 10.0).round() / 10.0
    } else {
        0.0
    };

    let avg_duration_ms = if with_duration.is_empty() {
        0u64
    } else {
        let total: u64 = with_duration.iter().map(|e| e.duration_ms).sum();
        (total as f64 / with_duration.len() as f64).round() as u64
    };

    // Month boundaries (local calendar, matching the TS implementation).
    let now = Local::now();
    let this_month_start = NaiveDate::from_ymd_opt(now.year(), now.month(), 1).unwrap();
    let last_month_start = if now.month() == 1 {
        NaiveDate::from_ymd_opt(now.year() - 1, 12, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(now.year(), now.month() - 1, 1).unwrap()
    };

    let mut this_month_words = 0u32;
    let mut last_month_words = 0u32;
    for e in &success {
        if let Some(d) = date_of(&e.timestamp) {
            if d >= this_month_start {
                this_month_words += count_words(&e.refined_text);
            } else if d >= last_month_start && d < this_month_start {
                last_month_words += count_words(&e.refined_text);
            }
        }
    }
    let month_growth_percent = if last_month_words > 0 {
        (((this_month_words as f64 - last_month_words as f64) / last_month_words as f64) * 100.0)
            .round() as i32
    } else if this_month_words > 0 {
        100
    } else {
        0
    };

    let (current_streak, longest_streak) = {
        let days: BTreeSet<NaiveDate> = success.iter().filter_map(|e| date_of(&e.timestamp)).collect();
        calculate_streak(&days)
    };

    // Daily activity for the last 90 days (inclusive of today).
    let today = Utc::now().date_naive();
    let start = today - Duration::days(90);
    let mut daily_map: HashMap<NaiveDate, u32> = HashMap::new();
    let mut d = start;
    while d <= today {
        daily_map.insert(d, 0);
        d += Duration::days(1);
    }
    for e in &success {
        if let Some(day) = date_of(&e.timestamp) {
            if let Some(c) = daily_map.get_mut(&day) {
                *c += 1;
            }
        }
    }
    let mut daily_activity: Vec<DailyActivity> = daily_map
        .into_iter()
        .map(|(date, count)| DailyActivity {
            date: date.format("%Y-%m-%d").to_string(),
            count,
        })
        .collect();
    daily_activity.sort_by(|a, b| a.date.cmp(&b.date));

    // Top apps.
    let mut app_counts: HashMap<String, u32> = HashMap::new();
    for e in &success {
        let name = app_name(e).unwrap_or_else(|| "Other".to_string());
        *app_counts.entry(name).or_insert(0) += 1;
    }
    let mut top_apps: Vec<TopApp> = app_counts
        .into_iter()
        .map(|(app, count)| TopApp {
            app,
            count,
            percent: if total_dictations > 0 {
                ((count as f64 / total_dictations as f64) * 100.0).round() as u32
            } else {
                0
            },
        })
        .collect();
    top_apps.sort_by(|a, b| b.count.cmp(&a.count));
    top_apps.truncate(5);

    // Recent dictations (most recent first — get_all already returns newest-first).
    let recent_dictations: Vec<RecentDictation> = success
        .iter()
        .take(10)
        .map(|e| {
            let time = parse_ts(&e.timestamp)
                .map(|t| t.with_timezone(&Local).format("%-I:%M %p").to_string())
                .unwrap_or_default();
            RecentDictation {
                time,
                text: e.refined_text.chars().take(120).collect(),
            }
        })
        .collect();

    EchoStats {
        total_dictations,
        total_words_dictated,
        total_corrections,
        avg_words_per_minute,
        wpm_speedup,
        avg_duration_ms,
        current_streak,
        longest_streak,
        this_month_words,
        last_month_words,
        month_growth_percent,
        daily_activity,
        top_apps,
        recent_dictations,
    }
}
