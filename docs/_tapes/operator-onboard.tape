# sk REPL — the /install connector onboarding wizard
# (template picker → credentials → probe → save).
# Render:  cd docs/_tapes && vhs operator-onboard.tape
# Output:  docs/_tapes/out/operator-onboard.gif
#
# Drives a scripted reproduction of the real wizard frames so the GIF
# renders offline. Credentials are FAKE and shown redacted (***redacted***).

Output out/operator-onboard.gif

Set Shell bash
Set FontSize 18
Set Width 1280
Set Height 820
Set Padding 24
Set Margin 0
Set Framerate 24
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type "bash scenes/operator-onboard.sh"
Enter
Show

Sleep 28s
