cask "echo" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/doramirdor/echo/releases/download/v#{version}/Echo-#{version}.dmg"
  name "Echo"
  desc "Voice-to-text dictation for macOS with LLM refinement"
  homepage "https://github.com/doramirdor/echo"

  depends_on macos: ">= :monterey"

  app "Echo.app"

  zap trash: [
    "~/Library/Application Support/echo",
    "~/Library/Preferences/com.echo.app.plist",
    "~/Library/Logs/echo",
  ]
end
