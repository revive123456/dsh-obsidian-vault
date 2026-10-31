# Why a notes pane

Chat history is a bad place to keep knowledge that outlives a conversation.
The pane reads a plain folder of markdown files — the same folder a real
Obsidian vault uses — and renders it next to the conversation.

## Three claims

1. **Your files stay yours.** Plain `.md`, no database, no import step.
2. **The chat can read them.** Cite a whole note or a selection; the assistant
   receives the path, the line numbers and the text.
3. **Nothing leaves the machine.** The host serves the vault over local routes;
   there is no telemetry and no outbound request.

## Shape of the integration

```text
DeepSeek Harness (dsh web)
├── sidebar           sessions + 📚 notes tree
├── conversation      composer, transcript
└── notes dock  ──►  /obsidian/*  ──►  vault/ on disk
```

> [!quote] Design rule
> A note pane should feel boring: open, read, edit, save, get back to the chat.

Back to [[Home]].
