import { RunLog, RunLogEntry } from './runLog';

export interface EchoStats {
  totalDictations: number;
  totalWordsDictated: number;
  totalCorrections: number;
  avgWordsPerMinute: number;
  wpmSpeedup: number;
  avgDurationMs: number;
  currentStreak: number;
  longestStreak: number;
  thisMonthWords: number;
  lastMonthWords: number;
  monthGrowthPercent: number;
  dailyActivity: Array<{ date: string; count: number }>;
  topApps: Array<{ app: string; count: number; percent: number }>;
  recentDictations: Array<{ time: string; text: string }>;
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function getDateString(ts: string): string {
  return new Date(ts).toISOString().split('T')[0];
}

function calculateStreak(entries: RunLogEntry[]): { current: number; longest: number } {
  if (entries.length === 0) return { current: 0, longest: 0 };

  const activeDays = new Set(entries.map(e => getDateString(e.timestamp)));
  const sortedDays = Array.from(activeDays).sort().reverse();

  if (sortedDays.length === 0) return { current: 0, longest: 0 };

  const today = getDateString(new Date().toISOString());
  const yesterday = getDateString(new Date(Date.now() - 86400000).toISOString());

  let current = 0;
  if (sortedDays[0] === today || sortedDays[0] === yesterday) {
    let checkDate = new Date(sortedDays[0]);
    for (const day of sortedDays) {
      if (day === getDateString(checkDate.toISOString())) {
        current++;
        checkDate = new Date(checkDate.getTime() - 86400000);
      } else {
        break;
      }
    }
  }

  let longest = 0;
  let streak = 0;
  const allDaysSorted = Array.from(activeDays).sort();
  for (let i = 0; i < allDaysSorted.length; i++) {
    if (i === 0) {
      streak = 1;
    } else {
      const prev = new Date(allDaysSorted[i - 1]);
      const curr = new Date(allDaysSorted[i]);
      const diffDays = (curr.getTime() - prev.getTime()) / 86400000;
      streak = diffDays === 1 ? streak + 1 : 1;
    }
    longest = Math.max(longest, streak);
  }

  return { current, longest };
}

export function computeStats(runLog: RunLog): EchoStats {
  const entries = runLog.getAll();
  const successEntries = entries.filter(e => !e.error && e.refinedText);

  const totalDictations = successEntries.length;
  const totalWordsDictated = successEntries.reduce((sum, e) => sum + countWords(e.refinedText), 0);

  const totalCorrections = successEntries.filter(e => {
    const raw = (e.rawTranscription || '').trim().toLowerCase();
    const refined = (e.refinedText || '').trim().toLowerCase();
    return raw !== refined && raw.length > 0;
  }).length;

  const AVG_TYPING_WPM = 40;

  let avgWordsPerMinute = 0;
  const entriesWithDuration = successEntries.filter(e => e.durationMs > 0);
  if (entriesWithDuration.length > 0) {
    const totalWpm = entriesWithDuration.reduce((sum, e) => {
      const words = countWords(e.refinedText);
      const minutes = e.durationMs / 60000;
      return sum + (minutes > 0 ? words / minutes : 0);
    }, 0);
    avgWordsPerMinute = Math.round(totalWpm / entriesWithDuration.length);
  }

  const wpmSpeedup = avgWordsPerMinute > 0
    ? Math.round((avgWordsPerMinute / AVG_TYPING_WPM) * 10) / 10
    : 0;

  const avgDurationMs = entriesWithDuration.length > 0
    ? Math.round(entriesWithDuration.reduce((s, e) => s + e.durationMs, 0) / entriesWithDuration.length)
    : 0;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const thisMonthWords = successEntries
    .filter(e => new Date(e.timestamp) >= thisMonthStart)
    .reduce((sum, e) => sum + countWords(e.refinedText), 0);

  const lastMonthWords = successEntries
    .filter(e => {
      const d = new Date(e.timestamp);
      return d >= lastMonthStart && d < thisMonthStart;
    })
    .reduce((sum, e) => sum + countWords(e.refinedText), 0);

  const monthGrowthPercent = lastMonthWords > 0
    ? Math.round(((thisMonthWords - lastMonthWords) / lastMonthWords) * 100)
    : thisMonthWords > 0 ? 100 : 0;

  const { current: currentStreak, longest: longestStreak } = calculateStreak(successEntries);

  // Daily activity for the last 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
  const dailyMap = new Map<string, number>();
  for (let d = new Date(ninetyDaysAgo); d <= now; d = new Date(d.getTime() + 86400000)) {
    dailyMap.set(getDateString(d.toISOString()), 0);
  }
  successEntries.forEach(e => {
    const day = getDateString(e.timestamp);
    if (dailyMap.has(day)) {
      dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
    }
  });
  const dailyActivity = Array.from(dailyMap.entries()).map(([date, count]) => ({ date, count }));

  // Top apps — use sourceApp field, fall back to extracting app name from context
  const appCounts = new Map<string, number>();
  successEntries.forEach(e => {
    let app = e.sourceApp;
    if (!app && e.context) {
      const match = e.context.match(/^App:\s*(.+?)(?:\n|$)/i)
        || e.context.match(/^(\w[\w\s]+?)(?:\s*[-—]|\n|$)/);
      app = match ? match[1].trim() : undefined;
    }
    const appName = app || 'Other';
    appCounts.set(appName, (appCounts.get(appName) || 0) + 1);
  });
  const topApps = Array.from(appCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([app, count]) => ({
      app,
      count,
      percent: totalDictations > 0 ? Math.round((count / totalDictations) * 100) : 0,
    }));

  // Recent dictations
  const recentDictations = successEntries.slice(0, 10).map(e => ({
    time: new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    text: e.refinedText.substring(0, 120),
  }));

  return {
    totalDictations,
    totalWordsDictated,
    totalCorrections,
    avgWordsPerMinute,
    wpmSpeedup,
    avgDurationMs,
    currentStreak,
    longestStreak,
    thisMonthWords,
    lastMonthWords,
    monthGrowthPercent,
    dailyActivity,
    topApps,
    recentDictations,
  };
}
