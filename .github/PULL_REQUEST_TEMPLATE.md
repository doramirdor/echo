<!-- Thanks for contributing to Echo! -->

## What does this PR do?

<!-- A short summary of the change and why it's needed. Link any related issue. -->

Closes #

## Which tree(s) did you touch?

<!-- Echo has parallel TypeScript (src/main) and Rust (src-tauri/src) implementations. -->

- [ ] TypeScript / Electron (`src/main/`)
- [ ] Rust / Tauri (`src-tauri/src/`)
- [ ] Shared renderer (`src/renderer/`)
- [ ] Docs only

> If you changed pipeline logic, a provider, a settings key, or the IPC surface in
> only one tree, explain why the other tree doesn't need the change.

## Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] Added/updated tests where it makes sense
- [ ] Updated docs for user-facing changes
