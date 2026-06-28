# Echo Stress Test Checklist

Manual stress tests for v1.0 release validation.

## Long Recordings

- [ ] Record for 30+ minutes continuously
- [ ] Verify memory usage stays stable (< 500MB)
- [ ] Verify transcription completes without timeout

## Rapid Toggle

- [ ] Toggle recording 20 times in 10 seconds
- [ ] No zombie recorder processes (`ps aux | grep rec`)
- [ ] App returns to idle state each time

## Provider Failures

- [ ] Revoke Groq API key mid-pipeline → user-facing error shown
- [ ] Stop Ollama during refinement → falls back to raw text
- [ ] Kill Whisper binary mid-transcription → error notification

## Permission Revocation

- [ ] Revoke Accessibility during insertion → clear error message
- [ ] Revoke Microphone during recording → graceful failure

## Multi-Monitor

- [ ] Move focus between displays → overlay follows cursor display
- [ ] Drag overlay across displays → position persists

## Edge Cases

- [ ] Empty recording (silence only) → no insertion, no error
- [ ] Very long text (5000+ words) → insertion succeeds
- [ ] Special characters in transcription → inserted correctly
