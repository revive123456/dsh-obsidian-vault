---
tags: [demo, attachment]
aliases: [Pasted image demo]
---
# Screenshot paste

While editing a note, paste an image from the clipboard with
<kbd>Cmd/Ctrl+V</kbd>. The host writes the image into the configured attachment
folder and inserts an Obsidian-native embed at the caret:

```markdown
![[Pasted image 20251031-101500-123.png]]
```

The markdown written to disk is the same syntax Obsidian itself uses, so the
embed keeps working if you open the vault in Obsidian.

## Embedded demo image

![[demo-attachment.png|640x360]]

## Why it matters

1. Paste a screenshot into a note without leaving the chat.
2. Move the attachment folder later — the panel moves the files and rewrites
   every `![[…]]` reference in the vault.
3. Deleting an embed and saving can clean up the orphaned file (opt-in, see the
   attachment settings).

Back to [[Home]].
