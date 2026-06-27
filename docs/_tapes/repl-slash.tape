# sk REPL — the slash fuzzy footer + /draft, /connectors, /context, /settings.
# Render:  cd docs/_tapes && vhs repl-slash.tape
# Output:  docs/_tapes/out/repl-slash.gif
#
# Drives a scripted reproduction of the real REPL frames (slash `›` footer,
# command catalog, status line) so the GIF renders offline with FAKE,
# redacted data.

Output out/repl-slash.gif

Set Shell bash
Set FontSize 18
Set Width 1280
Set Height 900
Set Padding 24
Set Margin 0
Set Framerate 24
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type "bash scenes/repl-slash.sh"
Enter
Show

Sleep 30s
