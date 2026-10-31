# Callout gallery

Obsidian callouts are `> [!type] Optional title` blocks. The preview keeps one
source line per rendered line (line numbers on the left) and draws the coloured
callout spine across all lines of the block.

> [!note] A note with an explicit title
> Callouts render an icon, a title and a coloured body. Body content is real
> Markdown: **bold**, *italic*, `inline code` and [links](https://obsidian.md).

> [!abstract] Abstract / summary / tldr
> Aliases from the Obsidian docs resolve to the same canonical type.

> [!info] Info
> Plain information.

> [!todo] Todo
> - [ ] first nested task
> - [x] second nested task

> [!tip] Tip / hint / important
> The tip block shares the colour family of hints.

> [!success] Success / check / done
> Nothing exploded.

> [!question] Question / help / faq
> Why are there line numbers on every preview? So a quote can cite an exact line.

> [!warning] Warning / caution / attention
> Watch the attachment folder before moving it.

> [!failure] Failure / fail / missing
> This one is used in the troubleshooting notes.

> [!danger] Danger / error
> Deleting a note does not go through the trash.

> [!bug] Bug
> Fixed in the release notes.

> [!example] Example
> The example block is a normal callout; fences belong outside of it:
> `fetch("/obsidian/note?path=Home.md")`

> [!quote] Quote / cite
> > The best note is the one you actually open.
> > — anonymous demo author

## A callout can hold headings and lists

> [!warning] Structured body content
> ### Inside a callout
> The body is parsed as Markdown, not as plain text:
> - headings keep their level
> - lists keep their indentation
> - quotes nest one level deeper

Back to [[Home]].
