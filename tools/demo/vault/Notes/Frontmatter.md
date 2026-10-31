---
tags: [demo, frontmatter]
aliases: [YAML demo]
status: evergreen
rating: 5
---
# Frontmatter

The YAML block at the top of this file never reaches the editor. The host parses
it, returns only the body, and stitches the original block back on save — byte
for byte, including `tags`, `aliases` and custom keys.

- [ ] Edit this note in the panel
- [ ] Save it without opening the YAML
- [ ] Reopen it in an external editor and confirm the block is intact

## What is preserved

| Key | Value |
| --- | --- |
| tags | demo, frontmatter |
| aliases | YAML demo |
| status | evergreen |

> [!tip] Why stitch on the host
> External tools (Obsidian itself, scripts) may edit the YAML while the panel is
> open. Re-reading it at save time means those edits are not clobbered by the
> panel's editor buffer.

Back to [[Home]].
