# Sharing Echo with a non-technical friend

Echo is free, local, and unsigned (no Apple Developer account). With the steps
below your friend gets a working app **without installing any developer tools** —
the only manual step is a one-time Gatekeeper bypass (unavoidable without paid
Apple notarization).

---

## 1. Build the shareable app (on YOUR Mac)

You need, one time: **Rust** (`curl https://sh.rustup.rs -sSf | sh`), **Xcode
Command Line Tools** (`xcode-select --install`), **cmake** + **git** (`brew
install cmake git`), and **Node**.

```bash
npm install
bash scripts/package-mac.sh
```

This compiles the native helpers, builds `whisper-cli` and `parakeet-cli`,
bundles them into the app, and produces a small DMG:

```
src-tauri/target/release/bundle/dmg/Echo_0.1.0_<arch>.dmg
```

The helpers + `whisper-cli` + `parakeet-cli` are baked in — on first launch the
app copies them into `~/Library/Application Support/echo`, so your friend needs
no Xcode tools, Homebrew, or git/cmake.

> Building `parakeet-cli` adds several minutes the first time (it clones and
> compiles parakeet.cpp). Run `ECHO_SKIP_PARAKEET=1 bash scripts/package-mac.sh`
> to leave it out — the opt-in Parakeet engine then requires your friend to build
> the binary from Settings, which needs git/cmake.

> **The Whisper model (~142 MB) is not bundled** — it keeps the DMG small. On
> first launch, onboarding downloads it once (Setup Whisper → the model lands in
> `~/Library/Application Support/echo/models`). So your friend **does need
> internet the first time** they set up Whisper. After that, transcription is
> fully offline.

> **Chip match:** this `.dmg` is built for your Mac's chip (Apple Silicon or
> Intel) and runs on a friend with the **same chip**. For a universal build that
> runs on both, push a `vX.Y.Z` git tag and use the GitHub release workflow
> instead (`.github/workflows/release.yml`).

Optional sanity check before sending:

```bash
plutil -p "src-tauri/target/release/bundle/macos/Echo.app/Contents/Info.plist" | grep Usage
# should list NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription, NSAppleEventsUsageDescription
```

---

## 2. Send your friend the `.dmg` + these steps

Copy-paste this to them:

> 1. Open the **Echo** `.dmg` and drag **Echo** into **Applications**.
> 2. Try to open Echo. macOS will block it (it's not from the App Store).
>    - If it says **"Echo is damaged"**, open **Terminal** and paste:
>      ```
>      xattr -dr com.apple.quarantine /Applications/Echo.app
>      ```
>      then open Echo again.
>    - Otherwise: **System Settings → Privacy & Security**, scroll down, click
>      **"Open Anyway"** next to Echo.
> 3. On first launch, grant the permissions Echo asks for:
>    - **Microphone** (to hear you)
>    - **Accessibility** (to type the text for you)
>    - **Input Monitoring** (for the `fn` hotkey) — then **quit and reopen Echo**
> 4. On the **Transcription** step, click **Setup Whisper**. This downloads the
>    speech model (~142 MB) once — you'll need internet for this. After it
>    finishes, transcription works fully offline.
> 5. On the **Refinement** step, get a free key at **console.groq.com** and paste
>    it in. This is what cleans up grammar and spelling. (Skip it and you'll still
>    get raw transcription, just without the polish.) Transcription itself works
>    offline with no key.
> 6. Press **`fn`** (or the menu-bar icon) and start talking. That's it.

---

## Why the Gatekeeper step exists

The build isn't Apple-notarized (that needs a $99/yr Apple Developer account).
The `xattr` / "Open Anyway" step is the standard one-time way to run an unsigned
app. To remove it entirely later, enroll in the Apple Developer Program and add
signing + notarization secrets to `.github/workflows/release.yml`.
