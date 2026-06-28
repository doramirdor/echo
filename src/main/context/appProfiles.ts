import { getSetting } from '../settings/settings';

export type AppProfile = 'coding' | 'prose' | 'chat' | 'default';

const APP_PROFILE_MAP: Record<string, AppProfile> = {
  'Visual Studio Code': 'coding',
  'Code': 'coding',
  'Cursor': 'coding',
  'Xcode': 'coding',
  'iTerm2': 'coding',
  'Terminal': 'coding',
  'Warp': 'coding',
  'Notion': 'prose',
  'Google Chrome': 'prose',
  'Safari': 'prose',
  'Pages': 'prose',
  'Microsoft Word': 'prose',
  'Slack': 'chat',
  'Messages': 'chat',
  'Discord': 'chat',
  'Telegram': 'chat',
};

const PROFILE_PROMPTS: Record<AppProfile, string> = {
  coding: `You are refining speech for a code editor. Preserve technical terms, variable names, and function names exactly. Use backticks for code identifiers when appropriate. Do not add prose formatting.`,
  prose: `You are refining speech for a document editor. Use proper grammar, punctuation, and paragraph structure. Capitalize sentences correctly.`,
  chat: `You are refining speech for a chat/messaging app. Keep the tone casual and conversational. Omit trailing periods on short messages unless clearly a full sentence.`,
  default: '',
};

export function detectAppProfile(appName: string | null): AppProfile {
  if (!appName) return 'default';

  const overrides = getSetting('appProfiles');
  if (overrides[appName]) {
    return overrides[appName] as AppProfile;
  }

  return APP_PROFILE_MAP[appName] ?? 'default';
}

export function getProfilePrompt(appName: string | null): string {
  const profile = detectAppProfile(appName);
  return PROFILE_PROMPTS[profile];
}

export function getAppProfileOptions(): { id: AppProfile; label: string }[] {
  return [
    { id: 'coding', label: 'Coding (preserve technical terms)' },
    { id: 'prose', label: 'Prose (formal writing)' },
    { id: 'chat', label: 'Chat (casual messaging)' },
    { id: 'default', label: 'Default' },
  ];
}
