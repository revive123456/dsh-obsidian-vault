# Markdown syntax

A walk through the constructs the preview renders with real layout, not a
monospace dump. Each source line keeps its line number on the left.

## Table alignment

| Left aligned | Centered | Right aligned | Default |
| :--- | :---: | ---: | --- |
| alpha | beta | gamma | delta |
| `code` | **bold** | *italic* | [link](https://github.com) |
| a longer cell that wraps | short | 1,024 | escaped pipe: a \| b |

## Fenced code

```ts
type Note = {
  path: string;
  mtimeMs: number;
};

export async function open(path: string): Promise<Note> {
  const res = await fetch(`/obsidian/note?path=${encodeURIComponent(path)}`, {
    headers: { "x-dsh-obsidian": "1" },
  });
  return res.json();
}
```

## Lists and tasks

- unordered item
- second item with a nested list
  - nested item
  - another nested item
    1. ordered inside unordered
    2. second ordered item
- [ ] open task
- [x] finished task

## Setext headings

A heading underlined with `===`
===

A heading underlined with `---`
---

## Quote and rule

> A plain quote line.
> A second quote line with `code`.
>
> > A nested quote.

---

Trailing paragraph after the rule. Back to [[Home]].
