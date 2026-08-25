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

/// Longest dictation (in words, per side) still diffed word-by-word for the
/// "fixes" count. The diff is O(n·m); past this it degrades to "1 fix if the
/// text changed at all" rather than burning time on an outlier.
const MAX_DIFF_WORDS: usize = 400;

fn count_words(text: &str) -> u32 {
    text.split_whitespace().filter(|s| !s.is_empty()).count() as u32
}

/// How many distinct edits the refiner made to one transcript.
///
/// A "fix" is one contiguous run of changed words — so replacing "monday" with
/// "tuesday morning" is one fix, not three. This mirrors the highlighted regions
/// the History tab's "Show changes" diff renders, which is what the Insights
/// card's "FIXES BY ECHO" label promises. Counting whole *dictations* instead
/// (the old behaviour) made the number meaningless: it could never exceed the
/// dictation count sitting right next to it.
fn count_word_edits(raw: &str, refined: &str) -> u32 {
    let a: Vec<&str> = raw.split_whitespace().collect();
    let b: Vec<&str> = refined.split_whitespace().collect();
    if a.is_empty() && b.is_empty() {
        return 0;
    }
    if a.len() > MAX_DIFF_WORDS || b.len() > MAX_DIFF_WORDS {
        return u32::from(a != b);
    }

    // Suffix LCS table: lcs[i][j] = length of the longest common subsequence of
    // a[i..] and b[j..]. Same formulation as the renderer's diffWords().
    let mut lcs = vec![vec![0u16; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    // Walk the alignment, counting maximal runs of non-matching words.
    let (mut i, mut j) = (0usize, 0usize);
    let mut fixes = 0u32;
    let mut in_change = false;
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            in_change = false;
            i += 1;
            j += 1;
        } else {
            if !in_change {
                fixes += 1;
                in_change = true;
            }
            if lcs[i + 1][j] >= lcs[i][j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    // Whatever is left on either side is one trailing insertion/deletion run.
    if (i < a.len() || j < b.len()) && !in_change {
        fixes += 1;
    }
    fixes
}

/// Parse an RFC3339 timestamp (as written by RunLog::add) into a UTC datetime.
fn parse_ts(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// The *local* calendar day a run happened on. Timestamps are stored in UTC, so
/// bucketing on `date_naive()` directly would file an 11pm dictation in UTC+3
/// under the following day — visibly breaking the streak and the heatmap. Every
/// day-based stat here (streak, heatmap, month totals) must agree on local days.
fn date_of(ts: &str) -> Option<NaiveDate> {
    parse_ts(ts).map(|d| d.with_timezone(&Local).date_naive())
}

/// Mirrors `calculateStreak`: current run of consecutive active days ending
/// today/yesterday, plus the longest consecutive run ever.
fn calculate_streak(days: &BTreeSet<NaiveDate>) -> (u32, u32) {
    if days.is_empty() {
        return (0, 0);
    }
    let today = Local::now().date_naive();
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

    // Entries with no raw transcript (e.g. a template expansion) have nothing to
    // diff against, so they contribute no fixes.
    let total_corrections: u32 = success
        .iter()
        .filter(|e| !e.raw_transcription.trim().is_empty())
        .map(|e| count_word_edits(e.raw_transcription.trim(), e.refined_text.trim()))
        .sum();

    // Average WPM — words spoken divided by the time spent *speaking*.
    //
    // This deliberately does NOT use `duration_ms`: that is how long the pipeline
    // took to transcribe/refine/insert, which is a fraction of the speaking time
    // and produced absurd figures (a 20-word dictation processed in 2.7s scored
    // 444 wpm, "11x faster than typing"). Entries written before `speech_ms`
    // existed have no speaking time to divide by and are simply left out of the
    // average rather than being estimated.
    let with_speech: Vec<&&RunLogEntry> = success
        .iter()
        .filter(|e| e.speech_ms.unwrap_or(0) > 0)
        .collect();
    let avg_words_per_minute = if with_speech.is_empty() {
        0u32
    } else {
        let total_wpm: f64 = with_speech
            .iter()
            .map(|e| {
                let words = count_words(&e.refined_text) as f64;
                let minutes = e.speech_ms.unwrap_or(0) as f64 / 60000.0;
                if minutes > 0.0 {
                    words / minutes
                } else {
                    0.0
                }
            })
            .sum();
        (total_wpm / with_speech.len() as f64).round() as u32
    };

    // Pipeline latency stays keyed off `duration_ms` — that *is* what it measures.
    let with_duration: Vec<&&RunLogEntry> = success.iter().filter(|e| e.duration_ms > 0).collect();

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
    let today = Local::now().date_naive();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::run_log::RunLog;

    fn entry(refined: &str, ts: DateTime<Local>, speech_ms: Option<u64>) -> RunLogEntry {
        RunLogEntry {
            id: String::new(),
            timestamp: ts.to_rfc3339(),
            raw_transcription: refined.to_string(),
            refined_text: refined.to_string(),
            context: String::new(),
            source_app: None,
            stt_engine: "whisper".into(),
            llm_provider: "groq".into(),
            // Pipeline latency, deliberately far shorter than the speaking time —
            // computing wpm off this is the bug these tests pin down.
            duration_ms: 2_700,
            speech_ms,
            error: None,
        }
    }

    /// `get_all()` returns newest-first, which several stats rely on.
    fn log_of(entries: Vec<RunLogEntry>) -> RunLog {
        RunLog::from_entries(entries)
    }

    #[test]
    fn wpm_uses_speaking_time_not_pipeline_latency() {
        // 20 words spoken over 10s = 120 wpm. Against the 2.7s pipeline duration
        // it would have scored 444.
        let words = "one two three four five six seven eight nine ten \
                     one two three four five six seven eight nine ten";
        let stats = compute_stats(&log_of(vec![entry(words, Local::now(), Some(10_000))]));
        assert_eq!(stats.avg_words_per_minute, 120);
        assert_eq!(stats.wpm_speedup, 3.0);
    }

    #[test]
    fn wpm_ignores_entries_without_speaking_time() {
        // Legacy entries (no speechMs) must not drag the average anywhere — they
        // are excluded, not estimated from duration_ms.
        let words = "one two three four five six seven eight nine ten";
        let stats = compute_stats(&log_of(vec![
            entry(words, Local::now(), Some(10_000)), // 10 words / 10s = 60 wpm
            entry(words, Local::now(), None),
        ]));
        assert_eq!(stats.avg_words_per_minute, 60);
        // Both entries still count as dictations and words.
        assert_eq!(stats.total_dictations, 2);
        assert_eq!(stats.total_words_dictated, 20);
    }

    #[test]
    fn wpm_is_zero_when_no_entry_has_speaking_time() {
        let stats = compute_stats(&log_of(vec![entry("hello there", Local::now(), None)]));
        assert_eq!(stats.avg_words_per_minute, 0);
        assert_eq!(stats.wpm_speedup, 0.0);
    }

    #[test]
    fn counts_each_changed_region_as_one_fix() {
        // A multi-word replacement is a single fix, not one per word.
        assert_eq!(count_word_edits("meet on monday", "meet on tuesday morning"), 1);
        // Two separate edits, with untouched words between them.
        assert_eq!(count_word_edits("meet on monday at noon", "meet on tuesday at midnight"), 2);
        // A trailing insertion after an untouched run is its own fix.
        assert_eq!(count_word_edits("meet on monday", "meet on monday please"), 1);
        // Untouched text scores zero.
        assert_eq!(count_word_edits("hello world", "hello world"), 0);
        assert_eq!(count_word_edits("", ""), 0);
        // Nothing in common at all is one wholesale rewrite.
        assert_eq!(count_word_edits("alpha beta", "gamma delta"), 1);
    }

    #[test]
    fn fixes_are_counted_across_all_dictations() {
        let mut a = entry("meet on monday at noon", Local::now(), Some(1_000));
        a.refined_text = "meet on tuesday at midnight".into();
        let mut b = entry("hello world", Local::now(), Some(1_000));
        b.refined_text = "hello world".into();

        let stats = compute_stats(&log_of(vec![a, b]));
        // 2 fixes in the first dictation, 0 in the second — the old metric could
        // only ever have said "1", capped by the dictation count.
        assert_eq!(stats.total_corrections, 2);
        assert_eq!(stats.total_dictations, 2);
    }

    #[test]
    fn errored_and_empty_runs_are_excluded() {
        let mut errored = entry("", Local::now(), Some(1_000));
        errored.error = Some("Microphone access failed.".into());
        let mut empty = entry("", Local::now(), Some(1_000));
        empty.refined_text = String::new();

        let stats = compute_stats(&log_of(vec![
            entry("one two", Local::now(), Some(60_000)),
            errored,
            empty,
        ]));
        assert_eq!(stats.total_dictations, 1);
        assert_eq!(stats.avg_words_per_minute, 2);
    }

    #[test]
    fn streak_and_heatmap_bucket_by_local_day() {
        // Late-evening local time — in any timezone east of UTC this instant
        // falls on the *next* UTC day, which used to file it under tomorrow and
        // break both the streak and the heatmap cell.
        let today = Local::now()
            .date_naive()
            .and_hms_opt(23, 30, 0)
            .unwrap()
            .and_local_timezone(Local)
            .unwrap();
        let stats = compute_stats(&log_of(vec![entry("hello there", today, Some(1_000))]));

        assert_eq!(stats.current_streak, 1);
        assert_eq!(stats.longest_streak, 1);

        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let cell = stats
            .daily_activity
            .iter()
            .find(|d| d.date == today_key)
            .expect("today should be in the 90-day window");
        assert_eq!(cell.count, 1);
    }

    #[test]
    fn streak_counts_consecutive_local_days() {
        let now = Local::now();
        let stats = compute_stats(&log_of(vec![
            entry("a b", now, Some(1_000)),
            entry("c d", now - Duration::days(1), Some(1_000)),
            entry("e f", now - Duration::days(2), Some(1_000)),
            // Gap at day 3, so the streak stops at 3.
            entry("g h", now - Duration::days(5), Some(1_000)),
        ]));
        assert_eq!(stats.current_streak, 3);
        assert_eq!(stats.longest_streak, 3);
    }
}
