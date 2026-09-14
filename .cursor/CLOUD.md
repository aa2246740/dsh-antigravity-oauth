# Cloud agent model lock

Never launch subagents (Task / explore / browser / computerUse / video) with other models. Only use grok 4.6.
Never select Claude/GPT/Gemini; stay on the parent Grok model only.

Do not spawn Task / computerUse / browser subagents unless I explicitly ask.
If a subagent is required, do not pass a model argument; inherit the parent model.
Never use Claude, Sonnet, Opus, GPT, or Gemini.
Prefer Grok or Composer only.
