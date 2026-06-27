# sk REPL — natural-language authoring → preview → approve → run → cost.
# Render:  cd docs/_tapes && vhs repl-author.tape
# Output:  docs/_tapes/out/repl-author.gif
#
# Drives a scripted reproduction of the real REPL frames (banner, braille
# spinner with token count, status line) so the GIF renders offline with
# FAKE, redacted data. To record against a live engine, swap the scene
# command below for `sk` and type the prompt with VHS `Type`/`Enter`.

Output out/repl-author.gif

Set Shell bash
Set FontSize 18
Set Width 1280
Set Height 860
Set Padding 24
Set Margin 0
Set Framerate 24
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type "bash scenes/repl-author.sh"
Enter
Show

Sleep 52s
